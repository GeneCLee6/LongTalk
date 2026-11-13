// Windows: SendInput (N4, e9-t06; f-remote-control-security.md §5.8, §5.12).
// - keys by scan code (keymap.rs), so the controlled computer's layout decides what they type;
// - text (an input method's result) as KEYEVENTF_UNICODE, one UTF-16 unit at a time;
// - the pointer as absolute coordinates on the virtual desktop (physical pixels: Tauri makes the
//   process per-monitor DPI aware), the wheel in WHEEL_DELTA units;
// - a press aimed at one of the agent's own windows is not sent (§5.8, TH-30): the window under
//   the pointer for a button or the wheel, the foreground window for a key or text. Releases go;
// - on the secure desktop (UAC, the lock screen) nothing is sent: Windows takes no injected input
//   there, the person at the computer answers it (§5.12). The agent runs at medium integrity and
//   never with uiAccess, so UIPI also refuses input to an administrator's window (T-16): SendInput
//   then sends fewer events than asked, reported as `Refused`.

use std::mem::size_of;

use windows_sys::Win32::Foundation::{LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
    WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK,
};
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId,
    SystemParametersInfoW, WindowFromPoint, GA_ROOT, MONITORINFOF_PRIMARY, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SPI_GETSCREENSAVERRUNNING,
};

use super::keymap::windows_key;
use super::{is_press, skip, Action, Injector, Screen, Skipped};
use crate::control::MouseButton;

/** One notch of a Windows wheel */
const WHEEL_DELTA: f64 = 120.0;
/** Browser wheel pixels per notch (Chromium on Windows scrolls 100 px a notch at 100 %) */
const PIXELS_PER_NOTCH: f64 = 100.0;

pub struct WindowsInjector {
    pid: u32,
    /** Where the last MoveTo put the pointer (SendInput is asynchronous: GetCursorPos may lag) */
    pointer: Option<(i32, i32)>,
}

impl WindowsInjector {
    pub fn new() -> Self {
        Self {
            pid: unsafe { GetCurrentProcessId() },
            pointer: None,
        }
    }

    fn owns(&self, hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
        if hwnd.is_null() {
            return false;
        }
        let mut pid = 0u32;
        unsafe {
            let root = GetAncestor(hwnd, GA_ROOT);
            GetWindowThreadProcessId(if root.is_null() { hwnd } else { root }, &mut pid);
        }
        pid == self.pid
    }

    /** Whether a press of `action` would land on one of the agent's own windows */
    fn aimed_at_agent(&self, action: &Action) -> bool {
        match action {
            Action::Button { .. } | Action::Wheel { .. } => {
                let point = match self.pointer {
                    Some((x, y)) => POINT { x, y },
                    None => {
                        let mut point = POINT { x: 0, y: 0 };
                        if unsafe { GetCursorPos(&mut point) } == 0 {
                            return true;
                        }
                        point
                    }
                };
                self.owns(unsafe { WindowFromPoint(point) })
            }
            Action::Key { .. } | Action::Text(_) => self.owns(unsafe { GetForegroundWindow() }),
            Action::MoveTo { .. } => false,
        }
    }
}

fn keyboard(scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: 0,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn mouse(dx: i32, dy: i32, data: i32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/** A pixel of the virtual desktop to SendInput's 0–65535 absolute scale */
fn absolute(x: i32, y: i32) -> (i32, i32) {
    let (left, top, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
        )
    };
    let scale = |value: i32, origin: i32, size: i32| {
        (((value - origin) as i64 * 65_535 + (size as i64 - 1) / 2) / (size as i64 - 1)) as i32
    };
    (scale(x, left, width), scale(y, top, height))
}

/** The browser's wheel pixels (positive: down, right) to WHEEL_DELTA units (positive: up, right) */
pub fn wheel_units(pixels: i32) -> i32 {
    (pixels as f64 * WHEEL_DELTA / PIXELS_PER_NOTCH).round() as i32
}

fn inputs_for(action: &Action) -> Option<Vec<INPUT>> {
    Some(match action {
        Action::MoveTo { x, y } => {
            let (ax, ay) = absolute(*x, *y);
            vec![mouse(
                ax,
                ay,
                0,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            )]
        }
        Action::Button { button, down } => {
            let flags = match (button, down) {
                (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
                (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
                (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
                (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
                (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
                (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
            };
            vec![mouse(0, 0, 0, flags)]
        }
        Action::Wheel { dx, dy } => {
            let mut inputs = Vec::new();
            let vertical = -wheel_units(*dy);
            if vertical != 0 {
                inputs.push(mouse(0, 0, vertical, MOUSEEVENTF_WHEEL));
            }
            let horizontal = wheel_units(*dx);
            if horizontal != 0 {
                inputs.push(mouse(0, 0, horizontal, MOUSEEVENTF_HWHEEL));
            }
            inputs
        }
        Action::Key { code, down } => {
            let key = windows_key(code)?;
            let mut flags = KEYEVENTF_SCANCODE;
            if key.extended {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            if !down {
                flags |= KEYEVENTF_KEYUP;
            }
            vec![keyboard(key.scan, flags)]
        }
        Action::Text(text) => text
            .encode_utf16()
            .flat_map(|unit| {
                [
                    keyboard(unit, KEYEVENTF_UNICODE),
                    keyboard(unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
                ]
            })
            .collect(),
    })
}

impl Injector for WindowsInjector {
    fn perform(&mut self, actions: &[Action]) -> Vec<Skipped> {
        let mut skipped = Vec::new();
        if secure_desktop() {
            if actions.iter().any(is_press) {
                skip(&mut skipped, Skipped::SecureDesktop);
            }
            return skipped;
        }
        for action in actions {
            if is_press(action) && self.aimed_at_agent(action) {
                skip(&mut skipped, Skipped::AgentWindow);
                continue;
            }
            let Some(inputs) = inputs_for(action) else {
                skip(&mut skipped, Skipped::UnknownKey);
                continue;
            };
            if inputs.is_empty() {
                continue;
            }
            let sent = unsafe {
                SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    size_of::<INPUT>() as i32,
                )
            };
            if (sent as usize) < inputs.len() {
                skip(&mut skipped, Skipped::Refused);
            }
            if let Action::MoveTo { x, y } = action {
                self.pointer = Some((*x, *y));
            }
        }
        skipped
    }

    fn screens(&self) -> Vec<Screen> {
        unsafe extern "system" fn each(
            monitor: HMONITOR,
            _: HDC,
            _: *mut RECT,
            data: LPARAM,
        ) -> windows_sys::core::BOOL {
            let screens = &mut *(data as *mut Vec<Screen>);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor, &mut info) != 0 {
                let r = info.rcMonitor;
                let (width, height) = ((r.right - r.left) as u32, (r.bottom - r.top) as u32);
                screens.push(Screen {
                    x: r.left,
                    y: r.top,
                    width,
                    height,
                    pixel_width: width,
                    pixel_height: height,
                    primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
                });
            }
            1
        }
        let mut screens: Vec<Screen> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(each),
                &mut screens as *mut Vec<Screen> as LPARAM,
            );
        }
        screens
    }
}

/**
 * The input desktop is not the person's own (UAC's secure desktop, the lock screen, a secure
 * screen saver): a medium-integrity process cannot even open it
 */
pub fn secure_desktop() -> bool {
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return true;
        }
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            (name.len() * 2) as u32,
            &mut needed,
        );
        CloseDesktop(desktop);
        if ok == 0 {
            return true;
        }
        let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..end]) != "Default"
    }
}

/** The session is locked, or the screen saver runs (§5.3 step 5: control ends, `locked`) */
pub fn session_locked() -> bool {
    unsafe {
        let mut running = 0i32;
        if SystemParametersInfoW(
            SPI_GETSCREENSAVERRUNNING,
            0,
            (&mut running as *mut i32).cast(),
            0,
        ) != 0
            && running != 0
        {
            return true;
        }
        let mut buffer: *mut u16 = std::ptr::null_mut();
        let mut bytes = 0u32;
        if WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        ) == 0
            || buffer.is_null()
        {
            return false;
        }
        let info = &*(buffer as *const WTSINFOEXW);
        let locked = info.Level == 1
            && info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK as i32;
        WTSFreeMemory(buffer.cast());
        locked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wheel_pixels_become_notches() {
        assert_eq!(wheel_units(100), 120);
        assert_eq!(wheel_units(-100), -120);
        assert_eq!(wheel_units(53), 64);
        assert_eq!(wheel_units(0), 0);
    }

    #[test]
    fn every_key_has_an_input_and_text_goes_unit_by_unit() {
        for code in super::super::keymap::all_control_codes() {
            assert!(inputs_for(&Action::Key { code, down: true }).is_some());
        }
        // 你 is one unit, 😀 two (a surrogate pair): a down and an up for each
        let inputs = inputs_for(&Action::Text("你😀".into())).unwrap();
        assert_eq!(inputs.len(), 6);
        // A wheel with both axes sends both
        assert_eq!(
            inputs_for(&Action::Wheel { dx: 50, dy: -100 })
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn the_screens_are_found() {
        // Whatever this machine has: at least one, exactly one primary, sizes positive
        let screens = WindowsInjector::new().screens();
        if screens.is_empty() {
            // A runner with no display at all
            return;
        }
        assert_eq!(screens.iter().filter(|s| s.primary).count(), 1);
        assert!(screens.iter().all(|s| s.width > 0 && s.height > 0));
    }
}

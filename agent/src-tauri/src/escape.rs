// Escape pressed three times within a second on the PHYSICAL keyboard stops control (N4, e9-t07;
// f-remote-control-security.md §5.4, shared/control.ts ESCAPE_STOP_PRESSES, ESCAPE_STOP_MS).
//
// Seeing a physical Escape anywhere on the computer takes a global keyboard hook, which is exactly
// what a keylogger is (A3, TH-21). The rules, each checked by the tests and the review list (T-17):
// - the hook exists only while someone controls this computer (`Watch` is dropped with the grant);
// - its callback looks at ONE thing, whether the key is Escape going down and not injected; every
//   other key is passed on at once and never stored, counted, logged or sent anywhere;
// - an injected Escape (the controller's, LLKHF_INJECTED) does not count, nor does a held Escape
//   repeating: only a press after a release.
// macOS (threat model Q12): a global monitor needs the 輸入監控 permission, asked for in N5's guide
// (e9-t08); until then a Mac stops with the floating 中斷 button and the tray. Linux: N5.

/** shared/control.ts ESCAPE_STOP_PRESSES, ESCAPE_STOP_MS */
pub const ESCAPE_STOP_PRESSES: usize = 3;
pub const ESCAPE_STOP_MS: u64 = 1_000;

/** Counts physical Escape presses; `press` says when the third within ESCAPE_STOP_MS came */
#[derive(Debug, Default)]
pub struct EscapeCounter {
    presses: Vec<u64>,
    down: bool,
}

impl EscapeCounter {
    /** Escape went down at `now` (a repeat while it is held is not a press) */
    pub fn down(&mut self, now: u64) -> bool {
        if self.down {
            return false;
        }
        self.down = true;
        self.presses
            .retain(|at| now.saturating_sub(*at) < ESCAPE_STOP_MS);
        self.presses.push(now);
        if self.presses.len() >= ESCAPE_STOP_PRESSES {
            self.presses.clear();
            return true;
        }
        false
    }

    pub fn up(&mut self) {
        self.down = false;
    }
}

#[cfg(target_os = "windows")]
pub use windows::Watch;

/** Where there is no hook yet (macOS, Linux: N5), watching does nothing */
#[cfg(not(target_os = "windows"))]
pub struct Watch;

#[cfg(not(target_os = "windows"))]
impl Watch {
    pub fn start(_on_escape: impl Fn() + Send + 'static) -> Option<Self> {
        None
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::sync::Mutex;
    use std::time::Instant;

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use super::EscapeCounter;

    /** What the hook callback reaches: the counter and what to do on the third press */
    struct Hooked {
        counter: EscapeCounter,
        clock: Instant,
        on_escape: Box<dyn Fn() + Send>,
    }

    static HOOKED: Mutex<Option<Hooked>> = Mutex::new(None);

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let event = &*(lparam as *const KBDLLHOOKSTRUCT);
            // Escape and nothing else; an injected one is the controller's and does not count
            if event.vkCode == VK_ESCAPE as u32 && event.flags & LLKHF_INJECTED == 0 {
                let message = wparam as u32;
                if let Ok(mut hooked) = HOOKED.try_lock() {
                    if let Some(hooked) = hooked.as_mut() {
                        if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                            let now = hooked.clock.elapsed().as_millis() as u64;
                            if hooked.counter.down(now) {
                                (hooked.on_escape)();
                            }
                        } else if message == WM_KEYUP || message == WM_SYSKEYUP {
                            hooked.counter.up();
                        }
                    }
                }
            }
        }
        // Always passed on: the hook never swallows or changes a key
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /** The hook, on a thread of its own with the message loop a low-level hook needs */
    pub struct Watch {
        thread: u32,
    }

    impl Watch {
        pub fn start(on_escape: impl Fn() + Send + 'static) -> Option<Self> {
            *HOOKED.lock().unwrap() = Some(Hooked {
                counter: EscapeCounter::default(),
                clock: Instant::now(),
                on_escape: Box::new(on_escape),
            });
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || unsafe {
                let handle = SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(hook),
                    GetModuleHandleW(std::ptr::null()),
                    0,
                );
                let _ = tx.send((!handle.is_null()).then(|| GetCurrentThreadId()));
                if handle.is_null() {
                    return;
                }
                let mut message: MSG = std::mem::zeroed();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {}
                UnhookWindowsHookEx(handle);
            });
            match rx.recv().ok().flatten() {
                Some(thread) => Some(Self { thread }),
                None => {
                    *HOOKED.lock().unwrap() = None;
                    None
                }
            }
        }
    }

    impl Drop for Watch {
        /** The grant ended: the hook goes away with its thread, and the counter with it */
        fn drop(&mut self) {
            unsafe {
                PostThreadMessageW(self.thread, WM_QUIT, 0, 0);
            }
            *HOOKED.lock().unwrap() = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_presses_within_a_second_stop() {
        let mut counter = EscapeCounter::default();
        assert!(!counter.down(0));
        counter.up();
        assert!(!counter.down(300));
        counter.up();
        assert!(counter.down(900));
        counter.up();
        // Counting starts again
        assert!(!counter.down(1_000));
    }

    #[test]
    fn slow_presses_do_not() {
        let mut counter = EscapeCounter::default();
        for at in [0, 600, 1_200, 1_800, 2_400] {
            assert!(!counter.down(at));
            counter.up();
        }
        // The last two were within the second; a third close by does it
        assert!(counter.down(2_500));
    }

    #[test]
    fn a_held_escape_repeating_is_one_press() {
        let mut counter = EscapeCounter::default();
        for at in [0, 30, 60, 90, 120, 150] {
            assert!(!counter.down(at));
        }
        counter.up();
        assert!(!counter.down(200));
        counter.up();
        assert!(counter.down(300));
    }
}

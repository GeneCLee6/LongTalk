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
// macOS (N5, threat model Q12): a listen-only event tap on key down and up, which needs the 輸入監控
// (Input Monitoring) permission; the window's permission guide asks for it, as optional. Without it
// the tap cannot be made, `start` returns None, and a Mac stops with the floating 中斷 button and the
// tray. The agent's own posted events carry inject/macos.rs INJECTED_MARK and do not count. The tap
// is listen-only: it cannot hold, change or drop any key.
// Linux (N5): X11 has no listen-only global hook an ordinary client may use without reading every
// key of every window (XRecord), which is more than this needs; Linux stops with the floating 中斷
// button and the tray, as the threat model allows (§5.4).

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

#[cfg(target_os = "macos")]
pub use macos::Watch;

/** Where there is no hook (Linux: see above), watching does nothing */
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub struct Watch;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl Watch {
    pub fn start(_on_escape: impl Fn() + Send + 'static) -> Option<Self> {
        None
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::time::Instant;

    use core_foundation::runloop::CFRunLoop;
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult, EventField,
    };

    use super::EscapeCounter;
    use crate::inject::macos::INJECTED_MARK;

    /** kVK_Escape */
    const ESCAPE_KEYCODE: i64 = 0x35;

    /** The tap's thread runs its run loop until the grant ends (Drop stops the loop) */
    pub struct Watch {
        run_loop: CFRunLoop,
    }

    impl Watch {
        pub fn start(on_escape: impl Fn() + Send + 'static) -> Option<Self> {
            let (tx, rx) = std::sync::mpsc::channel::<Option<CFRunLoop>>();
            std::thread::spawn(move || {
                let counter = RefCell::new(EscapeCounter::default());
                let clock = Instant::now();
                let ready = tx.clone();
                let made = CGEventTap::with_enabled(
                    CGEventTapLocation::HID,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::ListenOnly,
                    vec![CGEventType::KeyDown, CGEventType::KeyUp],
                    move |_proxy, kind, event| {
                        // Escape and nothing else; one the agent posted is the controller's
                        if event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE)
                            == ESCAPE_KEYCODE
                            && event.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA)
                                != INJECTED_MARK
                        {
                            let mut counter = counter.borrow_mut();
                            match kind {
                                CGEventType::KeyDown => {
                                    let now = clock.elapsed().as_millis() as u64;
                                    if counter.down(now) {
                                        on_escape();
                                    }
                                }
                                CGEventType::KeyUp => counter.up(),
                                _ => {}
                            }
                        }
                        // Listen-only: the key goes on unchanged whatever is returned
                        CallbackResult::Keep
                    },
                    move || {
                        let _ = ready.send(Some(CFRunLoop::get_current()));
                        CFRunLoop::run_current();
                    },
                );
                if made.is_err() {
                    // No 輸入監控 permission: no tap (the 中斷 button and the tray still stop it)
                    let _ = tx.send(None);
                }
            });
            rx.recv().ok().flatten().map(|run_loop| Self { run_loop })
        }
    }

    impl Drop for Watch {
        /** The grant ended: the run loop stops, the tap is removed with its thread */
        fn drop(&mut self) {
            self.run_loop.stop();
        }
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

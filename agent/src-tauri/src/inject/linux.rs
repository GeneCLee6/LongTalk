// Linux: XTest on an X11 display (N5, e9-t08; f-remote-control-security.md §5.12).
// NOT RUN ON A REAL DESKTOP YET: built and unit-tested in CI on Ubuntu (.github/workflows/agent-ci.yml),
// tried by hand in DEPLOY.md §5 step 40. Wayland has no injection an ordinary program may use (the
// RemoteDesktop portal brings a system dialog and a protocol of its own): in a Wayland session
// without an X11 display the agent injects nothing, says so in its window (permissions.rs) and in
// the log (`refusedByOs`). XWayland windows would take XTest input, but only they, so a Wayland
// session is treated as unsupported rather than half working.
// - keys by X keycode (keymap.rs linux_key: evdev + 8), so this computer's layout decides what they
//   type;
// - text (an input method's result): XTest can only press keys, so each character's keysym is put on
//   a spare keycode (one with no keysym at all), pressed, and the keycode emptied again; the same
//   trick xdotool uses;
// - the pointer in root window coordinates (X11 pixels), buttons 1–3, the wheel as buttons 4–7;
// - the agent's own windows: X11 tells no window which client sent an event, so there is no
//   per-window refusal here (on Windows and macOS there is). Nothing is injected while the consent
//   dialog or the hourly question is up (control.rs pauses), and every other window of the agent
//   can only make control smaller (中斷, 不允許貼上, 暫停接受請求, 離開).
// - a locked session (loginctl's LockedHint) ends control, checked at most once a second.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::xproto::{
    ConnectionExt as _, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, KEY_PRESS_EVENT,
    KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

use super::keymap::linux_key;
use super::{skip, Action, Injector, Screen, Skipped};
use crate::control::MouseButton;

/** Browser wheel pixels per click of an X11 wheel button */
const PIXELS_PER_CLICK: i32 = 100;
/** At most this many wheel clicks for one event (MAX_WHEEL_DELTA is 1200 px) */
const MAX_CLICKS: i32 = 12;
/** How long a remapped keycode is given before it is pressed (clients read the new mapping) */
const REMAP_SETTLE: Duration = Duration::from_millis(3);

pub struct X11Injector {
    conn: RustConnection,
    root: u32,
    min_keycode: u8,
    max_keycode: u8,
}

impl X11Injector {
    /** The X11 display ($DISPLAY) with the XTEST extension; None in a Wayland-only session */
    pub fn connect() -> Option<Self> {
        std::env::var_os("DISPLAY")?;
        let (conn, screen) = RustConnection::connect(None).ok()?;
        conn.xtest_get_version(2, 2).ok()?.reply().ok()?;
        let setup = conn.setup();
        let root = setup.roots.get(screen)?.root;
        let (min_keycode, max_keycode) = (setup.min_keycode, setup.max_keycode);
        Some(Self {
            conn,
            root,
            min_keycode,
            max_keycode,
        })
    }

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), Skipped> {
        self.conn
            .xtest_fake_input(kind, detail, x11rb::CURRENT_TIME, self.root, x, y, 0)
            .map(|_| ())
            .map_err(|_| Skipped::Refused)
    }

    /** Waits until the server has handled everything sent so far */
    fn sync(&self) -> Result<(), Skipped> {
        self.conn
            .get_input_focus()
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|_| ())
            .ok_or(Skipped::Refused)
    }

    /** A keycode with no keysym at all, for typing text (the highest one, as xdotool does) */
    fn spare_keycode(&self) -> Option<(u8, u8)> {
        let count = self.max_keycode.checked_sub(self.min_keycode)? + 1;
        let mapping = self
            .conn
            .get_keyboard_mapping(self.min_keycode, count)
            .ok()?
            .reply()
            .ok()?;
        let per = mapping.keysyms_per_keycode as usize;
        if per == 0 {
            return None;
        }
        mapping
            .keysyms
            .chunks(per)
            .enumerate()
            .rev()
            .find(|(_, syms)| syms.iter().all(|sym| *sym == 0))
            .map(|(index, _)| (self.min_keycode + index as u8, mapping.keysyms_per_keycode))
    }

    fn type_text(&self, text: &str) -> Result<(), Skipped> {
        let (spare, per) = self.spare_keycode().ok_or(Skipped::Refused)?;
        let empty = vec![0u32; per as usize];
        let mut result = Ok(());
        for c in text.chars() {
            let mut syms = empty.clone();
            syms[0] = keysym(c);
            if per > 1 {
                syms[1] = syms[0];
            }
            let step = (|| {
                self.conn
                    .change_keyboard_mapping(1, spare, per, &syms)
                    .map_err(|_| Skipped::Refused)?;
                self.sync()?;
                std::thread::sleep(REMAP_SETTLE);
                self.fake(KEY_PRESS_EVENT, spare, 0, 0)?;
                self.fake(KEY_RELEASE_EVENT, spare, 0, 0)?;
                self.sync()
            })();
            if step.is_err() {
                result = step;
                break;
            }
        }
        // The spare keycode empty again, whatever happened
        let _ = self.conn.change_keyboard_mapping(1, spare, per, &empty);
        let _ = self.conn.flush();
        result
    }

    fn perform_one(&self, action: &Action) -> Result<(), Skipped> {
        match action {
            Action::MoveTo { x, y } => {
                let clamp = |v: i32| v.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                self.fake(MOTION_NOTIFY_EVENT, 0, clamp(*x), clamp(*y))
            }
            Action::Button { button, down } => {
                let detail = match button {
                    MouseButton::Left => 1,
                    MouseButton::Middle => 2,
                    MouseButton::Right => 3,
                };
                let kind = if *down {
                    BUTTON_PRESS_EVENT
                } else {
                    BUTTON_RELEASE_EVENT
                };
                self.fake(kind, detail, 0, 0)
            }
            Action::Wheel { dx, dy } => {
                // Positive dy is down (button 5), positive dx is right (button 7)
                for (delta, negative, positive) in [(*dy, 4, 5), (*dx, 6, 7)] {
                    let clicks = wheel_clicks(delta);
                    let detail = if delta < 0 { negative } else { positive };
                    for _ in 0..clicks {
                        self.fake(BUTTON_PRESS_EVENT, detail, 0, 0)?;
                        self.fake(BUTTON_RELEASE_EVENT, detail, 0, 0)?;
                    }
                }
                Ok(())
            }
            Action::Key { code, down } => {
                let keycode = linux_key(code).ok_or(Skipped::UnknownKey)?;
                let kind = if *down {
                    KEY_PRESS_EVENT
                } else {
                    KEY_RELEASE_EVENT
                };
                self.fake(kind, keycode, 0, 0)
            }
            Action::Text(text) => self.type_text(text),
        }
    }
}

/** Wheel clicks for a browser delta in pixels: at least one for any movement, at most MAX_CLICKS */
fn wheel_clicks(delta: i32) -> i32 {
    if delta == 0 {
        return 0;
    }
    ((delta.abs() + PIXELS_PER_CLICK / 2) / PIXELS_PER_CLICK).clamp(1, MAX_CLICKS)
}

/**
 * The X keysym of a character: Latin-1 characters are their own keysym, everything else is
 * 0x01000000 + its code point (the X11 Unicode keysyms)
 */
fn keysym(c: char) -> u32 {
    let code = c as u32;
    if (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code) {
        code
    } else {
        0x0100_0000 + code
    }
}

impl Injector for X11Injector {
    fn perform(&mut self, actions: &[Action]) -> Vec<Skipped> {
        let mut skipped = Vec::new();
        for action in actions {
            if let Err(kind) = self.perform_one(action) {
                skip(&mut skipped, kind);
            }
        }
        if self.conn.flush().is_err() {
            skip(&mut skipped, Skipped::Refused);
        }
        skipped
    }

    fn screens(&self) -> Vec<Screen> {
        let monitors = self
            .conn
            .randr_get_monitors(self.root, true)
            .ok()
            .and_then(|cookie| cookie.reply().ok());
        if let Some(reply) = monitors {
            let screens: Vec<Screen> = reply
                .monitors
                .iter()
                .map(|m| Screen {
                    x: m.x.into(),
                    y: m.y.into(),
                    width: m.width.into(),
                    height: m.height.into(),
                    pixel_width: m.width.into(),
                    pixel_height: m.height.into(),
                    primary: m.primary,
                })
                .collect();
            if !screens.is_empty() {
                return screens;
            }
        }
        // No RandR 1.5: the whole root window is one screen
        let setup = self.conn.setup();
        setup
            .roots
            .iter()
            .find(|s| s.root == self.root)
            .map(|s| Screen {
                x: 0,
                y: 0,
                width: s.width_in_pixels.into(),
                height: s.height_in_pixels.into(),
                pixel_width: s.width_in_pixels.into(),
                pixel_height: s.height_in_pixels.into(),
                primary: true,
            })
            .into_iter()
            .collect()
    }
}

/** The last answer of `session_locked` and when it was asked (loginctl is a process: once a second) */
static LOCKED: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

/** The session is locked (systemd-logind's LockedHint, which GNOME, KDE and most lockers set) */
pub fn session_locked() -> bool {
    let mut last = LOCKED.lock().unwrap();
    if let Some((at, locked)) = *last {
        if at.elapsed() < Duration::from_secs(1) {
            return locked;
        }
    }
    let session = std::env::var("XDG_SESSION_ID").unwrap_or_else(|_| "self".to_owned());
    let locked = std::process::Command::new("loginctl")
        .args(["show-session", &session, "--property=LockedHint", "--value"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "yes")
        .unwrap_or(false);
    *last = Some((Instant::now(), locked));
    locked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keysyms_are_latin1_or_unicode() {
        assert_eq!(keysym('a'), 0x61);
        assert_eq!(keysym('é'), 0xe9);
        assert_eq!(keysym('中'), 0x0100_4e2d);
        assert_eq!(keysym('👍'), 0x0101_f44d);
    }

    #[test]
    fn wheel_clicks_follow_the_pixels() {
        assert_eq!(wheel_clicks(0), 0);
        assert_eq!(wheel_clicks(3), 1);
        assert_eq!(wheel_clicks(-100), 1);
        assert_eq!(wheel_clicks(260), 3);
        assert_eq!(wheel_clicks(1_200), MAX_CLICKS);
    }
}

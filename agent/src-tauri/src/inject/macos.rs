// macOS: CGEvent posted at the HID level (N4, e9-t06; f-remote-control-security.md §5.12).
// NOT RUN ON A MAC YET: compiled and unit-tested on macOS in CI (.github/workflows/agent-ci.yml, N5)
// and tried by hand in DEPLOY.md §5 step 40. Without the 輔助使用 (Accessibility) permission macOS
// drops every posted event silently; the window's permission guide (permissions.rs, N5) says which
// permission is missing and opens its page in System Settings.
// - keys by virtual key code (keymap.rs), with the held modifiers as the event's flags (a posted
//   key does not pick up modifiers posted before it on every macOS version);
// - text (an input method's result) as a key event carrying the string, 20 UTF-16 units at a time;
// - the pointer in global display points (CGDisplay bounds), dragged while a button is held, the
//   wheel in pixels;
// - the agent's own windows (§5.8, TH-30; N5): a press is not posted when the window under the
//   pointer (a button, the wheel) or the frontmost ordinary window (a key, text) belongs to this
//   process, from CGWindowListCopyWindowInfo (no extra permission: owner and bounds only, never
//   titles or pictures). Releases always go. Nothing is injected while the consent dialog or the
//   hourly question is up either (control.rs pauses).
// - every posted event carries INJECTED_MARK in its user data, so the Escape ×3 watch (escape.rs)
//   counts only the physical keyboard.

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
    ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use core_graphics::geometry::CGRect;
use core_graphics::window::{
    kCGWindowBounds, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
    kCGWindowListOptionOnScreenOnly, kCGWindowOwnerPID,
};

use super::keymap::macos_key;
use super::{is_press, skip, Action, Injector, Screen, Skipped};
use crate::control::MouseButton;

/** At most this many UTF-16 units in one key event's string (CGEventKeyboardSetUnicodeString) */
const TEXT_CHUNK: usize = 20;

/**
 * Written into kCGEventSourceUserData of every event the agent posts (N5): escape.rs's watch skips
 * an Escape carrying it, so the controller's Escape never counts toward 中斷
 */
pub const INJECTED_MARK: i64 = 0x4c54_4147; // "LTAG"

/** Marks an event as the agent's own and posts it */
fn post(event: &CGEvent) {
    event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, INJECTED_MARK);
    event.post(CGEventTapLocation::HID);
}

/** One on-screen window: who owns it, where it is, at which level */
struct WindowInfo {
    pid: i64,
    layer: i64,
    bounds: CGRect,
}

/** The on-screen windows, front to back (owner, layer and bounds only) */
fn windows_front_to_back() -> Vec<WindowInfo> {
    let Some(list) = CGDisplay::window_list_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        None,
    ) else {
        return Vec::new();
    };
    let list: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_get_rule(list.as_concrete_TypeRef()) };
    let key = |raw| unsafe { CFString::wrap_under_get_rule(raw) };
    let (pid_key, layer_key, bounds_key) = unsafe {
        (
            key(kCGWindowOwnerPID),
            key(kCGWindowLayer),
            key(kCGWindowBounds),
        )
    };
    list.iter()
        .filter_map(|window| {
            let number = |k: &CFString| {
                window
                    .find(k)
                    .and_then(|v| v.downcast::<CFNumber>())
                    .and_then(|n| n.to_i64())
            };
            let bounds = window
                .find(&bounds_key)
                .and_then(|v| v.downcast::<CFDictionary>())
                .and_then(|d| CGRect::from_dict_representation(&d))?;
            Some(WindowInfo {
                pid: number(&pid_key)?,
                layer: number(&layer_key).unwrap_or(0),
                bounds,
            })
        })
        .collect()
}

pub struct MacInjector {
    pointer: CGPoint,
    held_buttons: [bool; 3],
    flags: CGEventFlags,
    pid: i64,
}

impl MacInjector {
    pub fn new() -> Self {
        Self {
            pointer: CGPoint::new(0.0, 0.0),
            held_buttons: [false; 3],
            flags: CGEventFlags::CGEventFlagNull,
            pid: i64::from(std::process::id()),
        }
    }

    /**
     * Whether a press would land on one of the agent's own windows (§5.8): the topmost window under
     * the pointer for a button or the wheel, the frontmost ordinary (layer 0) window for a key or
     * text, or any of the agent's floating windows under the pointer (the 中斷 button, the border)
     */
    fn aimed_at_agent(&self, action: &Action) -> bool {
        let windows = windows_front_to_back();
        match action {
            Action::Button { .. } | Action::Wheel { .. } => windows
                .iter()
                .find(|w| w.bounds.contains(&self.pointer))
                .is_some_and(|w| w.pid == self.pid),
            Action::Key { .. } | Action::Text(_) => windows
                .iter()
                .find(|w| w.layer == 0)
                .is_some_and(|w| w.pid == self.pid),
            Action::MoveTo { .. } => false,
        }
    }

    fn source() -> Option<CGEventSource> {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()
    }

    fn flag_of(code: &str) -> CGEventFlags {
        match code {
            "ShiftLeft" | "ShiftRight" => CGEventFlags::CGEventFlagShift,
            "ControlLeft" | "ControlRight" => CGEventFlags::CGEventFlagControl,
            "AltLeft" | "AltRight" => CGEventFlags::CGEventFlagAlternate,
            "MetaLeft" | "MetaRight" => CGEventFlags::CGEventFlagCommand,
            _ => CGEventFlags::CGEventFlagNull,
        }
    }

    fn mouse(&self, kind: CGEventType, button: CGMouseButton) -> bool {
        let Some(source) = Self::source() else {
            return false;
        };
        match CGEvent::new_mouse_event(source, kind, self.pointer, button) {
            Ok(event) => {
                event.set_flags(self.flags);
                post(&event);
                true
            }
            Err(_) => false,
        }
    }

    fn perform_one(&mut self, action: &Action) -> Result<(), Skipped> {
        match action {
            Action::MoveTo { x, y } => {
                self.pointer = CGPoint::new(f64::from(*x), f64::from(*y));
                let (kind, button) = if self.held_buttons[0] {
                    (CGEventType::LeftMouseDragged, CGMouseButton::Left)
                } else if self.held_buttons[2] {
                    (CGEventType::RightMouseDragged, CGMouseButton::Right)
                } else if self.held_buttons[1] {
                    (CGEventType::OtherMouseDragged, CGMouseButton::Center)
                } else {
                    (CGEventType::MouseMoved, CGMouseButton::Left)
                };
                self.mouse(kind, button)
                    .then_some(())
                    .ok_or(Skipped::Refused)
            }
            Action::Button { button, down } => {
                let (index, kind, cg) = match (button, down) {
                    (MouseButton::Left, true) => {
                        (0, CGEventType::LeftMouseDown, CGMouseButton::Left)
                    }
                    (MouseButton::Left, false) => {
                        (0, CGEventType::LeftMouseUp, CGMouseButton::Left)
                    }
                    (MouseButton::Middle, true) => {
                        (1, CGEventType::OtherMouseDown, CGMouseButton::Center)
                    }
                    (MouseButton::Middle, false) => {
                        (1, CGEventType::OtherMouseUp, CGMouseButton::Center)
                    }
                    (MouseButton::Right, true) => {
                        (2, CGEventType::RightMouseDown, CGMouseButton::Right)
                    }
                    (MouseButton::Right, false) => {
                        (2, CGEventType::RightMouseUp, CGMouseButton::Right)
                    }
                };
                self.held_buttons[index] = *down;
                self.mouse(kind, cg).then_some(()).ok_or(Skipped::Refused)
            }
            Action::Wheel { dx, dy } => {
                let source = Self::source().ok_or(Skipped::Refused)?;
                // The browser's positive is down and right; a Mac's wheel1 positive is up
                let event =
                    CGEvent::new_scroll_event(source, ScrollEventUnit::PIXEL, 2, -dy, -dx, 0)
                        .map_err(|_| Skipped::Refused)?;
                post(&event);
                Ok(())
            }
            Action::Key { code, down } => {
                let key = macos_key(code).ok_or(Skipped::UnknownKey)?;
                let flag = Self::flag_of(code);
                if flag != CGEventFlags::CGEventFlagNull {
                    if *down {
                        self.flags |= flag;
                    } else {
                        self.flags.remove(flag);
                    }
                }
                let source = Self::source().ok_or(Skipped::Refused)?;
                let event = CGEvent::new_keyboard_event(source, key, *down)
                    .map_err(|_| Skipped::Refused)?;
                event.set_flags(self.flags);
                post(&event);
                Ok(())
            }
            Action::Text(text) => {
                let units: Vec<u16> = text.encode_utf16().collect();
                for chunk in units.chunks(TEXT_CHUNK) {
                    let chunk = String::from_utf16_lossy(chunk);
                    for down in [true, false] {
                        let source = Self::source().ok_or(Skipped::Refused)?;
                        let event = CGEvent::new_keyboard_event(source, 0, down)
                            .map_err(|_| Skipped::Refused)?;
                        event.set_string(&chunk);
                        post(&event);
                    }
                }
                Ok(())
            }
        }
    }
}

impl Injector for MacInjector {
    fn perform(&mut self, actions: &[Action]) -> Vec<Skipped> {
        let mut skipped = Vec::new();
        for action in actions {
            if is_press(action) && self.aimed_at_agent(action) {
                skip(&mut skipped, Skipped::AgentWindow);
                continue;
            }
            if let Err(kind) = self.perform_one(action) {
                skip(&mut skipped, kind);
            }
        }
        skipped
    }

    fn screens(&self) -> Vec<Screen> {
        CGDisplay::active_displays()
            .unwrap_or_default()
            .into_iter()
            .map(|id| {
                let display = CGDisplay::new(id);
                let bounds = display.bounds();
                Screen {
                    x: bounds.origin.x.round() as i32,
                    y: bounds.origin.y.round() as i32,
                    width: bounds.size.width.round() as u32,
                    height: bounds.size.height.round() as u32,
                    pixel_width: display.pixels_wide() as u32,
                    pixel_height: display.pixels_high() as u32,
                    primary: display.is_main(),
                }
            })
            .collect()
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
}

/** The screen is locked (§5.3 step 5: control ends, `locked`) */
pub fn session_locked() -> bool {
    let reference = unsafe { CGSessionCopyCurrentDictionary() };
    if reference.is_null() {
        return false;
    }
    let dictionary: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_create_rule(reference) };
    dictionary
        .find(CFString::from_static_string("CGSSessionScreenIsLocked"))
        .and_then(|value| value.downcast::<CFBoolean>())
        .map(bool::from)
        .unwrap_or(false)
}

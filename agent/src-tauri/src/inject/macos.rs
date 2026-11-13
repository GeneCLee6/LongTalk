// macOS: CGEvent posted at the HID level (N4, e9-t06; f-remote-control-security.md §5.12).
// NOT RUN YET: N4 was built and tested on Windows only; this file is compiled for macOS in the
// release workflow (.github/workflows/agent.yml) and tried on a Mac in N5 (e9-t08), with the
// 輔助使用 (Accessibility) permission guide. Without that permission macOS drops every posted
// event silently; N5's guide asks for it before control can start.
// - keys by virtual key code (keymap.rs), with the held modifiers as the event's flags (a posted
//   key does not pick up modifiers posted before it on every macOS version);
// - text (an input method's result) as a key event carrying the string, 20 UTF-16 units at a time;
// - the pointer in global display points (CGDisplay bounds), dragged while a button is held, the
//   wheel in pixels;
// - the agent's own windows (§5.8): on a Mac, nothing is injected while the consent dialog or the
//   hourly question is up (control.rs pauses), and the other agent windows can only stop control
//   or pause requests. A per-window check like Windows' is N5's, with the 輸入監控 permission.

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;

use super::keymap::macos_key;
use super::{skip, Action, Injector, Screen, Skipped};
use crate::control::MouseButton;

/** At most this many UTF-16 units in one key event's string (CGEventKeyboardSetUnicodeString) */
const TEXT_CHUNK: usize = 20;

pub struct MacInjector {
    pointer: CGPoint,
    held_buttons: [bool; 3],
    flags: CGEventFlags,
}

impl MacInjector {
    pub fn new() -> Self {
        Self {
            pointer: CGPoint::new(0.0, 0.0),
            held_buttons: [false; 3],
            flags: CGEventFlags::CGEventFlagNull,
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
                event.post(CGEventTapLocation::HID);
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
                event.post(CGEventTapLocation::HID);
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
                event.post(CGEventTapLocation::HID);
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
                        event.post(CGEventTapLocation::HID);
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

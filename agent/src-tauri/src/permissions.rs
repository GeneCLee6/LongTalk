// What the OS must allow before remote control can work here (N5, e9-t08; AC-9.5, T-24,
// f-remote-control-security.md §5.12), for the window's permission guide:
// - macOS: 螢幕錄製 (Screen Recording: the share), 輔助使用 (Accessibility: without it every posted
//   event is dropped without a word), and, optional, 輸入監控 (Input Monitoring: Escape ×3,
//   escape.rs). Each one the guide says is missing has a button that asks macOS (the first time it
//   shows its own prompt) and opens that page of System Settings. An update with a new ad-hoc
//   signature may make macOS forget them (§5.9): the guide shows them missing again.
// - Linux: an X11 display (XTest). A Wayland session without one cannot be controlled (§5.12:
//   best effort, not built); the guide says so instead of failing silently.
// - Windows: nothing to grant (UIPI and the secure desktop are limits, not permissions).
// Nothing here changes a setting by itself: asking is always the person's own press, and macOS
// decides.

use serde::Serialize;

/** One permission's state, as the guide shows it */
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Granted,
    Missing,
    /** This OS has no such permission */
    NotNeeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub screen: Access,
    pub accessibility: Access,
    pub input_monitoring: Access,
    /** Linux: an X11 display to inject into */
    pub x11: Access,
}

/** What the guide may ask for (macOS only) */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Screen,
    Accessibility,
    InputMonitoring,
}

impl Kind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "screen" => Some(Kind::Screen),
            "accessibility" => Some(Kind::Accessibility),
            "inputMonitoring" => Some(Kind::InputMonitoring),
            _ => None,
        }
    }

    /** Its page in System Settings (fixed addresses: nothing from outside picks what is opened) */
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn settings_url(self) -> &'static str {
        match self {
            Kind::Screen => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            Kind::Accessibility => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            Kind::InputMonitoring => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
        }
    }
}

const NONE: Permissions = Permissions {
    screen: Access::NotNeeded,
    accessibility: Access::NotNeeded,
    input_monitoring: Access::NotNeeded,
    x11: Access::NotNeeded,
};

fn access(granted: bool) -> Access {
    if granted {
        Access::Granted
    } else {
        Access::Missing
    }
}

/** The state now */
pub fn current() -> Permissions {
    #[cfg(target_os = "macos")]
    return Permissions {
        screen: access(macos::screen()),
        accessibility: access(macos::accessibility(false)),
        input_monitoring: access(macos::input_monitoring()),
        ..NONE
    };
    #[cfg(target_os = "linux")]
    return Permissions {
        x11: access(std::env::var_os("DISPLAY").is_some()),
        ..NONE
    };
    #[allow(unreachable_code)]
    {
        let _ = access;
        NONE
    }
}

/**
 * The guide's button for `kind`: macOS asks (its own prompt, the first time) and its System Settings
 * page opens. False where there is nothing to ask for.
 */
pub fn request(kind: Kind) -> bool {
    #[cfg(target_os = "macos")]
    {
        match kind {
            Kind::Screen => {
                macos::request_screen();
            }
            Kind::Accessibility => {
                macos::accessibility(true);
            }
            Kind::InputMonitoring => {
                macos::request_input_monitoring();
            }
        }
        return std::process::Command::new("open")
            .arg(kind.settings_url())
            .spawn()
            .is_ok();
    }
    #[allow(unreachable_code)]
    {
        let _ = kind;
        false
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::access::ScreenCaptureAccess;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    /** IOKit's IOHIDRequestType kIOHIDRequestTypeListenEvent, IOHIDAccessType kIOHIDAccessTypeGranted */
    const LISTEN_EVENT: u32 = 1;
    const ACCESS_GRANTED: u32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request: u32) -> u32;
        fn IOHIDRequestAccess(request: u32) -> bool;
    }

    pub fn screen() -> bool {
        ScreenCaptureAccess.preflight()
    }

    pub fn request_screen() -> bool {
        ScreenCaptureAccess.request()
    }

    /** Accessibility; with `prompt`, macOS shows its own 「打開系統設定」 prompt when not granted */
    pub fn accessibility(prompt: bool) -> bool {
        if !prompt {
            return unsafe { AXIsProcessTrusted() };
        }
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
    }

    pub fn input_monitoring() -> bool {
        unsafe { IOHIDCheckAccess(LISTEN_EVENT) == ACCESS_GRANTED }
    }

    pub fn request_input_monitoring() -> bool {
        unsafe { IOHIDRequestAccess(LISTEN_EVENT) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_the_three_macos_permissions() {
        assert_eq!(Kind::parse("screen"), Some(Kind::Screen));
        assert_eq!(Kind::parse("accessibility"), Some(Kind::Accessibility));
        assert_eq!(Kind::parse("inputMonitoring"), Some(Kind::InputMonitoring));
        assert_eq!(Kind::parse("camera"), None);
        assert_eq!(Kind::parse("https://evil.example"), None);
        for kind in [Kind::Screen, Kind::Accessibility, Kind::InputMonitoring] {
            assert!(kind
                .settings_url()
                .starts_with("x-apple.systempreferences:com.apple.preference.security?Privacy_"));
        }
    }

    #[test]
    fn the_guide_reads_camel_case() {
        let json = serde_json::to_value(NONE).unwrap();
        assert_eq!(json["inputMonitoring"], "notNeeded");
        assert_eq!(serde_json::to_value(Access::Missing).unwrap(), "missing");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_needs_nothing() {
        assert_eq!(current(), NONE);
        assert!(!request(Kind::Accessibility));
    }
}

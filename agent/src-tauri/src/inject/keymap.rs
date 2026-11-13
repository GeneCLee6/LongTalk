// KeyboardEvent.code (shared/control.ts CONTROL_KEY_CODES) to the key each OS presses: a Windows
// scan code (with the E0 prefix as the extended flag) and a macOS virtual key code. Physical keys,
// not characters (threat model Q9): the controlled computer's keyboard layout decides what a key
// types, which is what makes shortcuts land on the right key. The tables follow Chromium's
// ui/events/keycodes/dom/dom_code_data.inc, the same source the browser's `code` comes from.

/** A Windows scan code; `extended` sends KEYEVENTF_EXTENDEDKEY (the E0 prefix) */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WinKey {
    pub scan: u16,
    pub extended: bool,
}

const fn k(scan: u16) -> Option<WinKey> {
    Some(WinKey {
        scan,
        extended: false,
    })
}

const fn e(scan: u16) -> Option<WinKey> {
    Some(WinKey {
        scan,
        extended: true,
    })
}

/** The Windows scan code of a control key code; None for a code it does not know */
pub fn windows_key(code: &str) -> Option<WinKey> {
    if let Some(letter) = code.strip_prefix("Key") {
        const LETTERS: [u16; 26] = [
            0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31,
            0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
        ];
        let byte = *letter.as_bytes().first()?;
        if letter.len() != 1 || !byte.is_ascii_uppercase() {
            return None;
        }
        return k(LETTERS[(byte - b'A') as usize]);
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return match digit.parse::<u16>().ok().filter(|_| digit.len() == 1)? {
            0 => k(0x0b),
            n => k(0x01 + n),
        };
    }
    if let Some(n) = code.strip_prefix("F") {
        if n.len() <= 2 && !n.starts_with('0') {
            if let Ok(n) = n.parse::<u16>() {
                return match n {
                    1..=10 => k(0x3a + n),
                    11 => k(0x57),
                    12 => k(0x58),
                    _ => None,
                };
            }
        }
    }
    match code {
        "Numpad0" => k(0x52),
        "Numpad1" => k(0x4f),
        "Numpad2" => k(0x50),
        "Numpad3" => k(0x51),
        "Numpad4" => k(0x4b),
        "Numpad5" => k(0x4c),
        "Numpad6" => k(0x4d),
        "Numpad7" => k(0x47),
        "Numpad8" => k(0x48),
        "Numpad9" => k(0x49),
        "NumpadAdd" => k(0x4e),
        "NumpadSubtract" => k(0x4a),
        "NumpadMultiply" => k(0x37),
        "NumpadDivide" => e(0x35),
        "NumpadDecimal" => k(0x53),
        "NumpadEnter" => e(0x1c),
        "NumLock" => e(0x45),
        "Backquote" => k(0x29),
        "Minus" => k(0x0c),
        "Equal" => k(0x0d),
        "BracketLeft" => k(0x1a),
        "BracketRight" => k(0x1b),
        "Backslash" => k(0x2b),
        "Semicolon" => k(0x27),
        "Quote" => k(0x28),
        "Comma" => k(0x33),
        "Period" => k(0x34),
        "Slash" => k(0x35),
        "IntlBackslash" => k(0x56),
        "IntlRo" => k(0x73),
        "IntlYen" => k(0x7d),
        "Space" => k(0x39),
        "Enter" => k(0x1c),
        "Tab" => k(0x0f),
        "Backspace" => k(0x0e),
        "Escape" => k(0x01),
        "CapsLock" => k(0x3a),
        "ContextMenu" => e(0x5d),
        "ArrowUp" => e(0x48),
        "ArrowDown" => e(0x50),
        "ArrowLeft" => e(0x4b),
        "ArrowRight" => e(0x4d),
        "Insert" => e(0x52),
        "Delete" => e(0x53),
        "Home" => e(0x47),
        "End" => e(0x4f),
        "PageUp" => e(0x49),
        "PageDown" => e(0x51),
        "PrintScreen" => e(0x37),
        "Convert" => k(0x79),
        "NonConvert" => k(0x7b),
        "KanaMode" => k(0x70),
        "Lang1" => k(0x72),
        "Lang2" => k(0x71),
        "ShiftLeft" => k(0x2a),
        "ShiftRight" => k(0x36),
        "ControlLeft" => k(0x1d),
        "ControlRight" => e(0x1d),
        "AltLeft" => k(0x38),
        "AltRight" => e(0x38),
        "MetaLeft" => e(0x5b),
        "MetaRight" => e(0x5c),
        _ => None,
    }
}

/**
 * The macOS virtual key code (Carbon kVK_*) of a control key code; None for a key a Mac keyboard
 * does not have (PrintScreen, Convert, NonConvert, KanaMode): those are not pressed, and the log
 * says so once.
 */
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_key(code: &str) -> Option<u16> {
    if let Some(letter) = code.strip_prefix("Key") {
        const LETTERS: [u16; 26] = [
            0x00, 0x0b, 0x08, 0x02, 0x0e, 0x03, 0x05, 0x04, 0x22, 0x26, 0x28, 0x25, 0x2e, 0x2d,
            0x1f, 0x23, 0x0c, 0x0f, 0x01, 0x11, 0x20, 0x09, 0x0d, 0x07, 0x10, 0x06,
        ];
        let byte = *letter.as_bytes().first()?;
        if letter.len() != 1 || !byte.is_ascii_uppercase() {
            return None;
        }
        return Some(LETTERS[(byte - b'A') as usize]);
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        const DIGITS: [u16; 10] = [0x1d, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1a, 0x1c, 0x19];
        let n = digit.parse::<usize>().ok().filter(|_| digit.len() == 1)?;
        return Some(DIGITS[n]);
    }
    if let Some(n) = code.strip_prefix("Numpad") {
        if n.len() == 1 {
            const PAD: [u16; 10] = [0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5b, 0x5c];
            return n.parse::<usize>().ok().map(|n| PAD[n]);
        }
    }
    if let Some(n) = code.strip_prefix("F") {
        if n.len() <= 2 && !n.starts_with('0') {
            if let Ok(n) = n.parse::<usize>() {
                const FN: [u16; 12] = [
                    0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f,
                ];
                return (1..=12).contains(&n).then(|| FN[n - 1]);
            }
        }
    }
    match code {
        "NumpadAdd" => Some(0x45),
        "NumpadSubtract" => Some(0x4e),
        "NumpadMultiply" => Some(0x43),
        "NumpadDivide" => Some(0x4b),
        "NumpadDecimal" => Some(0x41),
        "NumpadEnter" => Some(0x4c),
        // kVK_ANSI_KeypadClear: where a Mac keyboard has NumLock
        "NumLock" => Some(0x47),
        "Backquote" => Some(0x32),
        "Minus" => Some(0x1b),
        "Equal" => Some(0x18),
        "BracketLeft" => Some(0x21),
        "BracketRight" => Some(0x1e),
        "Backslash" => Some(0x2a),
        "Semicolon" => Some(0x29),
        "Quote" => Some(0x27),
        "Comma" => Some(0x2b),
        "Period" => Some(0x2f),
        "Slash" => Some(0x2c),
        "IntlBackslash" => Some(0x0a),
        "IntlRo" => Some(0x5e),
        "IntlYen" => Some(0x5d),
        "Space" => Some(0x31),
        "Enter" => Some(0x24),
        "Tab" => Some(0x30),
        "Backspace" => Some(0x33),
        "Escape" => Some(0x35),
        "CapsLock" => Some(0x39),
        "ContextMenu" => Some(0x6e),
        "ArrowUp" => Some(0x7e),
        "ArrowDown" => Some(0x7d),
        "ArrowLeft" => Some(0x7b),
        "ArrowRight" => Some(0x7c),
        // kVK_Help: where a Mac keyboard has Insert
        "Insert" => Some(0x72),
        "Delete" => Some(0x75),
        "Home" => Some(0x73),
        "End" => Some(0x77),
        "PageUp" => Some(0x74),
        "PageDown" => Some(0x79),
        // kVK_JIS_Kana, kVK_JIS_Eisu
        "Lang1" => Some(0x68),
        "Lang2" => Some(0x66),
        "ShiftLeft" => Some(0x38),
        "ShiftRight" => Some(0x3c),
        "ControlLeft" => Some(0x3b),
        "ControlRight" => Some(0x3e),
        "AltLeft" => Some(0x3a),
        "AltRight" => Some(0x3d),
        "MetaLeft" => Some(0x37),
        "MetaRight" => Some(0x36),
        _ => None,
    }
}

/** Every code shared/control.ts CONTROL_KEY_CODES has (the tests check both tables against it) */
#[cfg(test)]
pub fn all_control_codes() -> Vec<String> {
    let mut codes: Vec<String> = ('A'..='Z').map(|c| format!("Key{c}")).collect();
    codes.extend((0..=9).map(|n| format!("Digit{n}")));
    codes.extend((0..=9).map(|n| format!("Numpad{n}")));
    codes.extend((1..=12).map(|n| format!("F{n}")));
    codes.extend(
        [
            "NumpadAdd",
            "NumpadSubtract",
            "NumpadMultiply",
            "NumpadDivide",
            "NumpadDecimal",
            "NumpadEnter",
            "NumLock",
            "Backquote",
            "Minus",
            "Equal",
            "BracketLeft",
            "BracketRight",
            "Backslash",
            "Semicolon",
            "Quote",
            "Comma",
            "Period",
            "Slash",
            "IntlBackslash",
            "IntlRo",
            "IntlYen",
            "Space",
            "Enter",
            "Tab",
            "Backspace",
            "Escape",
            "CapsLock",
            "ContextMenu",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Insert",
            "Delete",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "PrintScreen",
            "Convert",
            "NonConvert",
            "KanaMode",
            "Lang1",
            "Lang2",
            "ShiftLeft",
            "ShiftRight",
            "ControlLeft",
            "ControlRight",
            "AltLeft",
            "AltRight",
            "MetaLeft",
            "MetaRight",
        ]
        .iter()
        .map(|c| c.to_string()),
    );
    codes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::is_control_key_code;
    use std::collections::HashSet;

    #[test]
    fn the_list_is_the_control_key_codes() {
        let codes = all_control_codes();
        assert!(codes.iter().all(|c| is_control_key_code(c)));
        assert_eq!(codes.len(), codes.iter().collect::<HashSet<_>>().len());
        assert!(!is_control_key_code("F13"));
    }

    #[test]
    fn windows_presses_every_control_key_and_each_its_own() {
        let mut seen = HashSet::new();
        for code in all_control_codes() {
            let key = windows_key(&code).unwrap_or_else(|| panic!("{code} has no scan code"));
            assert!(seen.insert((key.scan, key.extended)), "{code} shares a key");
        }
        assert_eq!(
            windows_key("KeyA"),
            Some(WinKey {
                scan: 0x1e,
                extended: false
            })
        );
        assert_eq!(windows_key("Digit1").unwrap().scan, 0x02);
        assert_eq!(windows_key("Digit0").unwrap().scan, 0x0b);
        assert_eq!(windows_key("F10").unwrap().scan, 0x44);
        assert_eq!(windows_key("F11").unwrap().scan, 0x57);
        assert!(windows_key("MetaLeft").unwrap().extended);
        assert!(windows_key("Delete").unwrap().extended);
        for bad in ["F13", "F0", "F01", "Keya", "KeyAB", "Digit10", "Power", ""] {
            assert_eq!(windows_key(bad), None, "{bad}");
        }
    }

    #[test]
    fn macos_presses_every_key_a_mac_has() {
        let missing: HashSet<&str> = ["PrintScreen", "Convert", "NonConvert", "KanaMode"]
            .into_iter()
            .collect();
        let mut seen = HashSet::new();
        for code in all_control_codes() {
            match macos_key(&code) {
                Some(key) => assert!(seen.insert(key), "{code} shares a key"),
                None => assert!(missing.contains(code.as_str()), "{code} has no key code"),
            }
        }
        assert_eq!(macos_key("KeyA"), Some(0x00));
        assert_eq!(macos_key("KeyQ"), Some(0x0c));
        assert_eq!(macos_key("Digit0"), Some(0x1d));
        assert_eq!(macos_key("F1"), Some(0x7a));
        assert_eq!(macos_key("Escape"), Some(0x35));
        assert_eq!(macos_key("F13"), None);
    }
}

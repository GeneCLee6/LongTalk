// Putting a paste on this computer's clipboard (N5, e9-t09; f-remote-control-security.md §5.11,
// TH-27, T-22). Write only: nothing in the agent ever reads the clipboard (it often holds a password
// copied a moment ago), and there is no function here that could. The text comes from control.rs
// `on_paste` (the live grant, the person's own tick in the consent dialog), is written, and dropped;
// the agent log gets its length, never the text.
//
// One clipboard handle lives for the whole agent: on Linux (X11) the program that set the clipboard
// has to keep answering for it, so dropping the handle right after writing could empty it again.

use std::sync::Mutex;

static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

/** Puts `text` on the clipboard; false when the OS refused (nothing is retried or kept) */
pub fn write_text(text: &str) -> bool {
    let mut handle = CLIPBOARD.lock().unwrap();
    if handle.is_none() {
        *handle = arboard::Clipboard::new().ok();
    }
    match handle.as_mut() {
        Some(clipboard) => clipboard.set_text(text.to_owned()).is_ok(),
        None => false,
    }
}

// The windows remote control opens on the controlled computer (N3, e9-t04; f-remote-control-
// security.md §5.2 step 3, §5.4). Each is a native window of its own, always on top, loading only
// the bundled UI (agent/ui, its `#consent`, `#stop` or `#border` view), never a div in the main
// window that something could cover:
// - `consent`: the system-level question (a request, or the hourly 「還要繼續嗎？」); it cannot be
//   closed, only answered or left to run out. The only window granted control_answer
//   (capabilities/consent.json);
// - `control-stop`: the floating 中斷 button, top centre of the main monitor, while control is on;
// - `border-<monitor>-<side>`: four thin red strips around every monitor while control is on (no
//   transparent window needed, so the same on Windows, macOS and Linux), which the mouse goes
//   through.
// None of them takes an injected press (N4: inject/ does not send a press aimed at any window of
// this process, on Windows; on macOS nothing is injected while the dialog is up: T-04, TH-30).

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

pub const CONSENT: &str = "consent";
pub const STOP: &str = "control-stop";
const BORDER_PREFIX: &str = "border-";
/** The red border's width, in logical pixels */
const BORDER_LOGICAL: f64 = 6.0;

/** Opens or closes the control windows to match: `dialog` up, `granted` on (main thread) */
pub fn sync(app: &AppHandle, dialog: bool, granted: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        set_consent(&handle, dialog);
        set_stop(&handle, granted);
        set_border(&handle, granted);
    });
}

fn set_consent(app: &AppHandle, open: bool) {
    match (app.get_webview_window(CONSENT), open) {
        (Some(window), true) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        (Some(window), false) => {
            let _ = window.destroy();
        }
        (None, true) => {
            let built = WebviewWindowBuilder::new(
                app,
                CONSENT,
                WebviewUrl::App("index.html#consent".into()),
            )
            .title("LongTalk")
            .inner_size(460.0, 520.0)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .closable(false)
            .always_on_top(true)
            .center()
            .focused(true)
            .build();
            if let Ok(window) = built {
                let _ = window.set_focus();
            }
        }
        (None, false) => {}
    }
}

fn set_stop(app: &AppHandle, open: bool) {
    match (app.get_webview_window(STOP), open) {
        (Some(_), true) | (None, false) => {}
        (Some(window), false) => {
            let _ = window.destroy();
        }
        (None, true) => {
            let mut builder =
                WebviewWindowBuilder::new(app, STOP, WebviewUrl::App("index.html#stop".into()))
                    .title("LongTalk")
                    .inner_size(300.0, 64.0)
                    .decorations(false)
                    .resizable(false)
                    .closable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focused(false);
            if let Some(monitor) = app.primary_monitor().ok().flatten() {
                let scale = monitor.scale_factor();
                let position = monitor.position().to_logical::<f64>(scale);
                let size = monitor.size().to_logical::<f64>(scale);
                builder =
                    builder.position(position.x + (size.width - 300.0) / 2.0, position.y + 12.0);
            }
            let _ = builder.build();
        }
    }
}

fn set_border(app: &AppHandle, open: bool) {
    let existing: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(BORDER_PREFIX))
        .collect();
    if !open {
        for (_, window) in existing {
            let _ = window.destroy();
        }
        return;
    }
    if !existing.is_empty() {
        return;
    }
    let monitors = app.available_monitors().unwrap_or_default();
    for (index, monitor) in monitors.iter().enumerate() {
        let PhysicalPosition { x, y } = *monitor.position();
        let PhysicalSize { width, height } = *monitor.size();
        let thick = (BORDER_LOGICAL * monitor.scale_factor()).round().max(2.0) as u32;
        let (w, h) = (width as i32, height as i32);
        let t = thick as i32;
        let strips = [
            ("top", x, y, width, thick),
            ("bottom", x, y + h - t, width, thick),
            ("left", x, y, thick, height),
            ("right", x + w - t, y, thick, height),
        ];
        for (side, sx, sy, sw, sh) in strips {
            let label = format!("{BORDER_PREFIX}{index}-{side}");
            let built =
                WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#border".into()))
                    .title("LongTalk")
                    .decorations(false)
                    .resizable(false)
                    .closable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focused(false)
                    .shadow(false)
                    .build();
            if let Ok(window) = built {
                let _ = window.set_position(PhysicalPosition::new(sx, sy));
                let _ = window.set_size(PhysicalSize::new(sw, sh));
                // The mouse goes through: the border marks the screen, it never covers it
                let _ = window.set_ignore_cursor_events(true);
            }
        }
    }
}

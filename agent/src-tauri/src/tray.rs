// The tray icon and its menu (E9 需求「系統托盤顯示狀態」): a status line, 「打開 LongTalk 代理」,
// 「分享我的螢幕」 (a switch, only in a room after the confirmation), 「離開房間」 and 「結束」. The
// share switch only asks the window: the screen is picked in the WebView (getDisplayMedia, the
// person chooses which monitor), so turning it on brings the window up. Labels follow the system
// language (zh-TW, otherwise English), like the window.
//
// While someone controls this computer (N3, §5.4) the first item is 「中斷控制」 and the status says
// who controls it; 「暫停接受控制請求」 offers 「不再接受請求 N 分鐘」 (and back) at any time.
//
// N4 (e9-t07): the icon turns red while someone controls this computer (the app icon tinted with
// the design's danger colour, made here: no second set of icon files); 「開啟日誌」 opens the agent
// log's folder; the notification at the start of control is worded here too. The tray menu is the
// agent's own window: a press the injector aims at it is not sent (inject/, §5.8).

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::control::{ControlView, StopReason};
use crate::session::Phase;
use crate::AgentState;

/** What the window is asked to do from the tray (the `agent://tray` event) */
pub const TRAY_EVENT: &str = "agent://tray";

struct Labels {
    open: &'static str,
    share: &'static str,
    leave: &'static str,
    quit: &'static str,
    idle: &'static str,
    connecting: &'static str,
    confirming: &'static str,
    in_room: &'static str,
    sharing: &'static str,
    tooltip: &'static str,
    stop_control: &'static str,
    controlled: fn(&str) -> String,
    mute: &'static str,
    mute_for: [&'static str; 3],
    unmute: &'static str,
    open_log: &'static str,
    started_title: fn(&str) -> String,
    /** How to stop it: with Escape ×3 where the agent sees a physical Escape (Windows) */
    started_body: [&'static str; 2],
}

const ZH_TW: Labels = Labels {
    open: "打開 LongTalk 代理",
    share: "分享我的螢幕",
    leave: "離開房間",
    quit: "結束",
    idle: "未加入會議室",
    connecting: "連線中…",
    confirming: "等你確認加入",
    in_room: "已加入會議室",
    sharing: "正在分享你的螢幕",
    tooltip: "LongTalk 代理",
    stop_control: "中斷控制",
    controlled: |name| format!("{name} 正在控制這台電腦"),
    mute: "暫停接受控制請求",
    mute_for: ["10 分鐘", "30 分鐘", "60 分鐘"],
    unmute: "重新接受控制請求",
    open_log: "開啟日誌",
    started_title: |name| format!("{name} 開始控制這台電腦"),
    started_body: [
        "按畫面上方的「中斷」、托盤的「中斷控制」，或連按三下 Esc，就會停止。",
        "按畫面上方的「中斷」或托盤的「中斷控制」，就會停止。",
    ],
};

const EN: Labels = Labels {
    open: "Open LongTalk agent",
    share: "Share my screen",
    leave: "Leave the room",
    quit: "Quit",
    idle: "Not in a room",
    connecting: "Connecting…",
    confirming: "Waiting for you to confirm",
    in_room: "In a room",
    sharing: "Sharing your screen",
    tooltip: "LongTalk agent",
    stop_control: "Stop control",
    controlled: |name| format!("{name} is controlling this computer"),
    mute: "Pause control requests",
    mute_for: ["10 minutes", "30 minutes", "60 minutes"],
    unmute: "Take control requests again",
    open_log: "Open the log",
    started_title: |name| format!("{name} started controlling this computer"),
    started_body: [
        "To stop it, press Stop at the top of the screen, Stop control in the tray, or Esc three times.",
        "To stop it, press Stop at the top of the screen or Stop control in the tray.",
    ],
};

/** The notification when control starts: title, body (`escape`: Escape ×3 works here) */
pub fn notification(controller: &str, escape: bool) -> (String, &'static str) {
    let text = labels();
    (
        (text.started_title)(controller),
        text.started_body[usize::from(!escape)],
    )
}

/** styles/tokens.ts `danger` (light): the tray icon's colour while controlled */
const DANGER: [u8; 3] = [0xDC, 0x26, 0x26];

/**
 * The app icon in the danger colour: every pixel keeps its alpha and its lightness, so the shape
 * stays readable on a light or a dark taskbar
 */
pub fn tinted(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|pixel| {
            let light =
                (u32::from(pixel[0]) * 299 + u32::from(pixel[1]) * 587 + u32::from(pixel[2]) * 114)
                    / 1000;
            // Dark parts take the colour, light parts stay light
            let mix = |channel: u8| {
                (u32::from(channel) * (255 - light) / 255 + light * light / 255).min(255) as u8
            };
            [mix(DANGER[0]), mix(DANGER[1]), mix(DANGER[2]), pixel[3]]
        })
        .collect()
}

fn labels() -> &'static Labels {
    let locale = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    if locale.starts_with("zh") {
        &ZH_TW
    } else {
        &EN
    }
}

pub struct Tray {
    _icon: TrayIcon<Wry>,
    /** The normal icon and the red one (N4) */
    normal: Option<Image<'static>>,
    red: Option<Image<'static>>,
    status: MenuItem<Wry>,
    share: CheckMenuItem<Wry>,
    leave: MenuItem<Wry>,
    stop_control: MenuItem<Wry>,
    mute: Submenu<Wry>,
    /** Who controls this computer now: the status line says so over the session's (N3) */
    controlled: Mutex<Option<String>>,
}

pub fn build(app: &AppHandle) -> tauri::Result<Tray> {
    let text = labels();
    let status = MenuItem::with_id(app, "status", text.idle, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", text.open, true, None::<&str>)?;
    let share = CheckMenuItem::with_id(app, "share", text.share, false, false, None::<&str>)?;
    let leave = MenuItem::with_id(app, "leave", text.leave, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", text.quit, true, None::<&str>)?;
    let open_log = MenuItem::with_id(app, "open-log", text.open_log, true, None::<&str>)?;
    let stop_control =
        MenuItem::with_id(app, "stop-control", text.stop_control, false, None::<&str>)?;
    let mute = Submenu::with_items(
        app,
        text.mute,
        false,
        &[
            &MenuItem::with_id(app, "mute-600000", text.mute_for[0], true, None::<&str>)?,
            &MenuItem::with_id(app, "mute-1800000", text.mute_for[1], true, None::<&str>)?,
            &MenuItem::with_id(app, "mute-3600000", text.mute_for[2], true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "mute-0", text.unmute, true, None::<&str>)?,
        ],
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &stop_control,
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &share,
            &mute,
            &leave,
            &PredefinedMenuItem::separator(app)?,
            &open_log,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip(text.tooltip)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main(tray.app_handle());
            }
        });
    let normal = app
        .default_window_icon()
        .map(|icon| icon.clone().to_owned());
    let red = normal
        .as_ref()
        .map(|icon| Image::new_owned(tinted(icon.rgba()), icon.width(), icon.height()));
    if let Some(icon) = &normal {
        builder = builder.icon(icon.clone());
    }
    let icon = builder.build(app)?;
    Ok(Tray {
        _icon: icon,
        normal,
        red,
        status,
        share,
        leave,
        stop_control,
        mute,
        controlled: Mutex::new(None),
    })
}

/** The menu follows remote control (N3): 中斷控制 and who controls, while someone does */
pub fn sync_control(tray: &Tray, view: &ControlView) {
    let text = labels();
    let controller = match view {
        ControlView::Granted {
            controller_name, ..
        } => Some(controller_name.clone()),
        _ => None,
    };
    let _ = tray.stop_control.set_enabled(controller.is_some());
    if let Some(name) = &controller {
        let _ = tray.status.set_text((text.controlled)(name));
    }
    let was = std::mem::replace(&mut *tray.controlled.lock().unwrap(), controller.clone());
    if was.is_some() != controller.is_some() {
        let icon = if controller.is_some() {
            &tray.red
        } else {
            &tray.normal
        };
        let _ = tray._icon.set_icon(icon.clone());
    }
    let _ = tray._icon.set_tooltip(Some(match &controller {
        Some(name) => (text.controlled)(name),
        None => text.tooltip.to_owned(),
    }));
    // Back to the session's line once it ends
    if was.is_some() && controller.is_none() {
        let _ = tray.status.set_text(text.in_room);
    }
}

/** The menu follows the session: the switch and 離開房間 only in a room, the switch's tick */
pub fn sync(tray: &Tray, phase: &Phase) {
    let text = labels();
    let (status, in_room, sharing) = match phase {
        Phase::Idle => (text.idle, false, false),
        Phase::Connecting => (text.connecting, false, false),
        Phase::Confirming { .. } => (text.confirming, false, false),
        Phase::InRoom { sharing, .. } => (
            if *sharing { text.sharing } else { text.in_room },
            true,
            *sharing,
        ),
    };
    if let Some(name) = tray.controlled.lock().unwrap().as_ref() {
        let _ = tray.status.set_text((text.controlled)(name));
    } else {
        let _ = tray.status.set_text(status);
    }
    let _ = tray.share.set_enabled(in_room);
    let _ = tray.mute.set_enabled(in_room);
    let _ = tray.share.set_checked(sharing);
    let _ = tray
        .leave
        .set_enabled(!matches!(phase, Phase::Idle | Phase::Connecting));
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => crate::show_main(app),
        "share" => {
            let sharing = app.state::<AgentState>().session.lock().unwrap().sharing();
            if sharing {
                let _ = app.emit(TRAY_EVENT, "unshare");
            } else {
                // The picker opens in the window: bring it up first
                crate::show_main(app);
                let _ = app.emit(TRAY_EVENT, "share");
            }
            // The tick follows the session, not the click
            crate::notify(app);
        }
        "leave" => {
            let _ = app.emit(TRAY_EVENT, "leave");
        }
        "quit" => crate::quit(app),
        "open-log" => crate::open_log(app),
        "stop-control" => crate::stop_control_from(app, StopReason::Tray),
        id => {
            if let Some(ms) = id
                .strip_prefix("mute-")
                .and_then(|ms| ms.parse::<u64>().ok())
            {
                crate::mute_from_tray(app, ms);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_red_icon_keeps_the_shape() {
        // A transparent pixel, a black one, a white one
        let icon = [0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255];
        let red = tinted(&icon);
        assert_eq!(red.len(), icon.len());
        assert_eq!(red[3], 0);
        assert_eq!(&red[4..8], &[DANGER[0], DANGER[1], DANGER[2], 255]);
        assert_eq!(&red[8..12], &[255, 255, 255, 255]);
    }

    #[test]
    fn the_notification_says_how_to_stop() {
        let (title, body) = notification("Bob", true);
        assert!(title.contains("Bob"));
        assert!(body.contains("Esc"));
        let (_, body) = notification("Bob", false);
        assert!(!body.contains("Esc"));
    }
}

// The tray icon and its menu (E9 需求「系統托盤顯示狀態」): a status line, 「打開 LongTalk 代理」,
// 「分享我的螢幕」 (a switch, only in a room after the confirmation), 「離開房間」 and 「結束」. The
// share switch only asks the window: the screen is picked in the WebView (getDisplayMedia, the
// person chooses which monitor), so turning it on brings the window up. Labels follow the system
// language (zh-TW, otherwise English), like the window.
//
// While someone controls this computer (N3, §5.4) the first item is 「中斷控制」 and the status says
// who controls it; 「暫停接受控制請求」 offers 「不再接受請求 N 分鐘」 (and back) at any time.
//
// TODO(N4, e9-t07): the tray menu, like every agent window, must ignore injected input
// (f-remote-control-security.md §5.8, T-04): nothing is injected before N4, so nothing to filter yet.
// TODO(N4): a red tray icon while controlled (needs its own icon files).

use std::sync::Mutex;

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
};

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
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let icon = builder.build(app)?;
    Ok(Tray {
        _icon: icon,
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

// The tray icon and its menu (E9 需求「系統托盤顯示狀態」): a status line, 「打開 LongTalk 代理」,
// 「分享我的螢幕」 (a switch, only in a room after the confirmation), 「離開房間」 and 「結束」. The
// share switch only asks the window: the screen is picked in the WebView (getDisplayMedia, the
// person chooses which monitor), so turning it on brings the window up. Labels follow the system
// language (zh-TW, otherwise English), like the window.
//
// TODO(N4, e9-t07): the tray menu, like every agent window, must ignore injected input
// (f-remote-control-security.md §5.8, T-04): nothing is injected before N4, so nothing to filter yet.

use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

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
}

pub fn build(app: &AppHandle) -> tauri::Result<Tray> {
    let text = labels();
    let status = MenuItem::with_id(app, "status", text.idle, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", text.open, true, None::<&str>)?;
    let share = CheckMenuItem::with_id(app, "share", text.share, false, false, None::<&str>)?;
    let leave = MenuItem::with_id(app, "leave", text.leave, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", text.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &share,
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
    })
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
    let _ = tray.status.set_text(status);
    let _ = tray.share.set_enabled(in_room);
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
        _ => {}
    }
}

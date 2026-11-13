// The LongTalk desktop agent (E9, N2: e9-t02 skeleton, e9-t03 the screen). The threat model is
// docs/PRD/f-remote-control-security.md; §5.1 (pairing, the local confirmation) and §5.8 (local
// attack surface) are what this file is built around:
// - no listening port of any kind: the room socket (socket.rs) and the API calls below are
//   outgoing connections to the one domain written into the build (origin.rs);
// - the window loads only the bundled UI (agent/ui, tauri.conf.json `frontendDist`, a strict CSP),
//   and can call only the commands listed in build.rs, granted in capabilities/main.json: no
//   shell, no file system, no opener, no plugin APIs;
// - one instance (the single-instance plugin: a second launch brings this window up);
// - closing the window hides it to the tray; 結束 in the tray quits (leaving the room first).
//
// The UI is a WebView (WebView2 on Windows, Chromium): the screen is captured there with
// getDisplayMedia and published by the same TypeScript MediaTransport the web app uses (CLAUDE.md
// rule 2), whose HTTP calls come here (api_fetch) so that the agent token never reaches the page
// and nothing is published before the person confirms (session.rs).
//
// Remote control (N3, control.rs, §5.2–§5.4): the room's control frames go to control.rs and never
// to the page; the consent dialog, the red border and the floating 中斷 button are windows of their
// own (control_windows.rs), and only the consent window may answer (capabilities/consent.json).

mod control;
mod control_windows;
mod origin;
mod session;
mod socket;
mod tray;
#[cfg(feature = "updater")]
mod updater;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use control::{Control, ControlRefusal, ControlView, Decision, Effects, StopReason};
use session::{Outgoing, Phase, Refusal, Session};
use socket::{Out, SocketEvent, SocketHandle};

/** The session's phase, sent to the window after every change */
pub const SESSION_EVENT: &str = "agent://session";
/** Remote control's state (control.rs ControlView), sent to every window after every change */
pub const CONTROL_EVENT: &str = "agent://control";
/** How often the control clock runs (dialog deadlines, time limits, releasing held input) */
const CONTROL_TICK_MS: u64 = 200;

pub struct AgentState {
    pub session: Mutex<Session>,
    pub control: Mutex<Control>,
    pub socket: Mutex<Option<SocketHandle>>,
    pub tray: Mutex<Option<tray::Tray>>,
    next_socket: AtomicU32,
    clock: Instant,
    http: reqwest::Client,
}

impl AgentState {
    fn new() -> Self {
        Self {
            session: Mutex::new(Session::new()),
            control: Mutex::new(Control::new()),
            socket: Mutex::new(None),
            tray: Mutex::new(None),
            next_socket: AtomicU32::new(1),
            clock: Instant::now(),
            // No redirects: a response can never send the agent to another host
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()
                .expect("HTTP client"),
        }
    }

    /** Milliseconds on a monotonic clock (the confirmation's arming) */
    pub fn now(&self) -> u64 {
        self.clock.elapsed().as_millis() as u64
    }

    /** Sends a frame on the open socket, if any (Rust's own frames: no may_send check) */
    fn send_raw(&self, out: Out) {
        if let Some(socket) = self.socket.lock().unwrap().as_ref() {
            let _ = socket.tx.send(out);
        }
    }

    /**
     * What a control step asks for: its frames to the room. Its `release` is what N4 will inject
     * (nothing is injected before N4); the windows follow `changed` (notify_control)
     */
    fn apply(&self, effects: &Effects) {
        for frame in &effects.send {
            self.send_raw(Out::Text(frame.clone()));
        }
    }

    /** `leave`, then close the socket: the room removes the member at once */
    fn leave_and_close(&self) {
        self.send_raw(Out::Text(json!({ "t": "leave" }).to_string()));
        self.send_raw(Out::Close);
        *self.socket.lock().unwrap() = None;
    }
}

/** Tells the window and the tray what the session is now */
pub fn notify(app: &AppHandle) {
    let state = app.state::<AgentState>();
    let phase = state.session.lock().unwrap().phase().clone();
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        tray::sync(tray, &phase);
    }
    let _ = app.emit(SESSION_EVENT, phase);
}

/** Tells every window and the tray where control is, and opens or closes its windows */
pub fn notify_control(app: &AppHandle) {
    let state = app.state::<AgentState>();
    let (view, dialog, granted) = {
        let control = state.control.lock().unwrap();
        (
            control.view(state.now()),
            control.dialog(),
            control.granted(),
        )
    };
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        tray::sync_control(tray, &view);
    }
    control_windows::sync(app, dialog, granted);
    let _ = app.emit(CONTROL_EVENT, view);
}

/** A control frame from the room (socket.rs): to control.rs, never to the page */
pub fn on_control_frame(app: &AppHandle, kind: &str, value: &serde_json::Value, raw: &str) {
    let state = app.state::<AgentState>();
    let now = state.now();
    let changed = {
        let mut control = state.control.lock().unwrap();
        match kind {
            "controlAsk" => control.on_ask(value, now),
            "controlAskEnd" => value
                .get("request")
                .and_then(|r| r.as_str())
                .is_some_and(|request| control.on_ask_end(request)),
            "controlStart" => control.on_start(value, now),
            "controlEnd" => {
                let grant = value.get("grant").and_then(|g| g.as_str()).unwrap_or("");
                let effects = control.on_end(grant);
                state.apply(&effects);
                effects.changed
            }
            "controlForward" => {
                // N4 injects `release` then `events`; until then a batch only moves the seq and the
                // held set. What it carried is never logged or kept (D11)
                let _ = control.on_forward(raw, now);
                false
            }
            _ => false,
        }
    };
    if changed {
        notify_control(app);
    }
}

/** The control clock: runs every CONTROL_TICK_MS for the life of the agent */
fn start_control_clock(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(CONTROL_TICK_MS));
        loop {
            interval.tick().await;
            let state = app.state::<AgentState>();
            let effects = state.control.lock().unwrap().tick(state.now());
            state.apply(&effects);
            if effects.changed {
                notify_control(&app);
            }
        }
    });
}

/** 中斷控制 in the tray */
pub fn stop_control_from(app: &AppHandle, reason: StopReason) {
    stop_control(app, reason);
}

/** 「暫停接受控制請求」 in the tray: no requests for `ms` (0: take them again) */
pub fn mute_from_tray(app: &AppHandle, ms: u64) {
    let state = app.state::<AgentState>();
    if !state.session.lock().unwrap().in_room() {
        return;
    }
    let frame = state.control.lock().unwrap().mute(ms);
    if let Ok(frame) = frame {
        state.send_raw(Out::Text(frame));
    }
}

/** Ends any control before the agent leaves the room or quits (the room is told first) */
fn stop_control(app: &AppHandle, reason: StopReason) {
    let state = app.state::<AgentState>();
    let effects = state.control.lock().unwrap().stop(reason);
    state.apply(&effects);
    if effects.changed {
        notify_control(app);
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/** 結束: leave the room (if in one), give the frame a moment to go out, quit */
pub fn quit(app: &AppHandle) {
    stop_control(app, StopReason::Quit);
    let state = app.state::<AgentState>();
    let had_room = state.session.lock().unwrap().leave();
    if had_room {
        state.leave_and_close();
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if had_room {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        app.exit(0);
    });
}

fn refusal(refusal: Refusal) -> String {
    serde_json::to_value(refusal)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "refused".into())
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

// ── Commands (each listed in build.rs and granted in capabilities/main.json) ─────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentInfo {
    /** The computer's name, the join form's default for the device name */
    device: String,
    platform: &'static str,
    build: &'static str,
    /** The one origin this build talks to: the join form rejects links of any other */
    origin: &'static str,
}

#[tauri::command]
fn agent_info() -> AgentInfo {
    AgentInfo {
        device: gethostname::gethostname().to_string_lossy().into_owned(),
        platform: platform(),
        build: env!("CARGO_PKG_VERSION"),
        origin: origin::origin(),
    }
}

#[tauri::command]
fn session_state(state: State<'_, AgentState>) -> Phase {
    state.session.lock().unwrap().phase().clone()
}

/** shared/control.ts normalizePairingCode's output: 8 symbols of Crockford base32 */
fn is_pairing_code(code: &str) -> bool {
    const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    code.len() == 8 && code.chars().all(|c| ALPHABET.contains(c))
}

/**
 * Opens the room socket. With `pairing` (normalized by the page) it starts a session in `room`;
 * without, it reconnects the session there is, with its token (in Rust only). `device` is the
 * computer's name after shared/control.ts normalizeLabel.
 */
#[tauri::command]
fn socket_connect(
    app: AppHandle,
    state: State<'_, AgentState>,
    room: Option<String>,
    pairing: Option<String>,
    device: String,
    on_event: Channel<SocketEvent>,
) -> Result<(), String> {
    if device.trim().is_empty() || device.chars().count() > 40 {
        return Err("bad_device".into());
    }
    let (room, pairing, token) = {
        let mut session = state.session.lock().unwrap();
        match pairing {
            Some(code) => {
                if !is_pairing_code(&code) {
                    return Err("bad_pairing".into());
                }
                let room = room.ok_or("bad_room")?;
                session.start(&room).map_err(refusal)?;
                (room, Some(code), None)
            }
            None => {
                let token = session.reconnect_token().ok_or("no_session")?.to_owned();
                let room = session.room().ok_or("no_session")?.to_owned();
                (room, None, Some(token))
            }
        }
    };
    notify(&app);
    let Some(url) = origin::agent_socket_url(&room) else {
        state.session.lock().unwrap().leave();
        notify(&app);
        return Err("bad_room".into());
    };
    let hello = json!({
        "t": "agentHello",
        "pairing": pairing,
        "token": token,
        "device": device,
        "platform": platform(),
        "build": env!("CARGO_PKG_VERSION"),
    })
    .to_string();
    let id = state.next_socket.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    // Replacing the handle drops the old sender: that socket closes itself
    *state.socket.lock().unwrap() = Some(SocketHandle { id, tx });
    tauri::async_runtime::spawn(socket::run(app.clone(), id, url, hello, rx, on_event));
    Ok(())
}

/** A frame from the page: only what the session allows now (session.rs may_send) */
#[tauri::command]
fn socket_send(state: State<'_, AgentState>, text: String) -> Result<(), String> {
    if text.len() > 4_096 {
        return Err("too_large".into());
    }
    let frame = Outgoing::classify(&text);
    if !state.session.lock().unwrap().may_send(&frame) {
        return Err("refused".into());
    }
    match state.socket.lock().unwrap().as_ref() {
        Some(socket) => socket
            .tx
            .send(Out::Text(text))
            .map_err(|_| "closed".to_string()),
        None => Err("closed".into()),
    }
}

/** The local confirmation's 加入 (`accept`) or 取消 (which leaves the room) */
#[tauri::command]
fn confirm_join(app: AppHandle, state: State<'_, AgentState>, accept: bool) -> Result<(), String> {
    let now = state.now();
    if accept {
        state
            .session
            .lock()
            .unwrap()
            .confirm(now)
            .map_err(refusal)?;
    } else {
        state.session.lock().unwrap().cancel(now).map_err(refusal)?;
        state.leave_and_close();
    }
    notify(&app);
    Ok(())
}

/** The person's 「分享我的螢幕」 switch (session.rs: only in the room, after the confirmation) */
#[tauri::command]
fn set_sharing(app: AppHandle, state: State<'_, AgentState>, on: bool) -> Result<(), String> {
    state
        .session
        .lock()
        .unwrap()
        .set_sharing(on)
        .map_err(refusal)?;
    // Nobody controls a screen nobody sees: turning the share off ends control (N3)
    let effects = state.control.lock().unwrap().set_sharing(on);
    state.apply(&effects);
    notify(&app);
    if effects.changed {
        notify_control(&app);
    }
    Ok(())
}

/** 離開房間: `leave`, close, forget the token */
#[tauri::command]
fn leave_room(app: AppHandle, state: State<'_, AgentState>) {
    stop_control(&app, StopReason::Quit);
    let had_room = state.session.lock().unwrap().leave();
    if had_room {
        state.leave_and_close();
    }
    notify(&app);
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
}

/**
 * The transport's HTTP calls (CloudflareRealtimeTransport's `fetch`) and TURN: only the paths of
 * the room the agent is in (origin.rs classify_api_call), only once confirmed, only publishing
 * while the share switch is on, with the agent token added here.
 */
#[tauri::command]
async fn api_fetch(
    state: State<'_, AgentState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<ApiResponse, String> {
    let token = {
        let session = state.session.lock().unwrap();
        let room = session.room().ok_or("no_session")?;
        let call = origin::classify_api_call(&method, &path, room).ok_or("forbidden_path")?;
        let allowed = match call {
            origin::ApiCall::Sfu { adds_tracks } => session.may_call_api(adds_tracks),
            origin::ApiCall::Turn => session.may_call_api(false),
        };
        if !allowed {
            return Err("refused".into());
        }
        session.token().ok_or("no_session")?.to_owned()
    };
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "bad_method")?;
    let mut request = state
        .http
        .request(method, origin::api_url(&path))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body);
    }
    let response = request.send().await.map_err(|_| "network".to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok(ApiResponse { status, body })
}

fn control_refusal(refusal: ControlRefusal) -> String {
    serde_json::to_value(refusal)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "refused".into())
}

/** Where control is now (every control window reads it when it opens) */
#[tauri::command]
fn control_state(state: State<'_, AgentState>) -> ControlView {
    state.control.lock().unwrap().view(state.now())
}

/**
 * The consent dialog's answer: 允許 10 分鐘, 允許直到我中斷 or 拒絕 (with 「不再接受請求 N 分鐘」,
 * `mute_ms`). Granted to the consent window only (capabilities/consent.json): the main window and
 * the page cannot answer (T-04). control.rs refuses it for CONSENT_DIALOG_ARM_MS and after the
 * dialog's deadline.
 */
#[tauri::command]
fn control_answer(
    app: AppHandle,
    state: State<'_, AgentState>,
    request: String,
    decision: String,
    mute_ms: Option<u64>,
) -> Result<(), String> {
    let decision = Decision::parse(&decision).ok_or("bad_decision")?;
    let effects = state
        .control
        .lock()
        .unwrap()
        .answer(&request, decision, mute_ms, state.now())
        .map_err(control_refusal);
    notify_control(&app);
    let effects = effects?;
    state.apply(&effects);
    Ok(())
}

/** 「繼續讓對方控制」 on the hourly question (consent window only) */
#[tauri::command]
fn control_keep_going(app: AppHandle, state: State<'_, AgentState>) -> Result<(), String> {
    let result = state
        .control
        .lock()
        .unwrap()
        .keep_going(state.now())
        .map_err(control_refusal);
    notify_control(&app);
    result.map(|_| ())
}

/** 中斷: the floating button, the main window, the hourly question's 停止 */
#[tauri::command]
fn control_stop(app: AppHandle) {
    stop_control(&app, StopReason::Button);
}

/** 「不再接受請求 N 分鐘」 from the main window (0 takes requests again) */
#[tauri::command]
fn control_mute(state: State<'_, AgentState>, ms: u64) -> Result<(), String> {
    let frame = state
        .control
        .lock()
        .unwrap()
        .mute(ms)
        .map_err(control_refusal)?;
    if !state.session.lock().unwrap().in_room() {
        return Err("no_session".into());
    }
    state.send_raw(Out::Text(frame));
    Ok(())
}

/**
 * TODO(N4, e9-t07): agent windows ignore injected input (§5.8, T-04): a low-level mouse and
 * keyboard hook that drops events flagged LLMHF_INJECTED / LLKHF_INJECTED while an agent window
 * has focus (Windows), the event source pid check on macOS. Nothing is injected before N4.
 */
fn guard_against_injected_input(_app: &AppHandle) {}

pub fn run() {
    tauri::Builder::default()
        // First: a second launch only brings this one's window up (§5.8)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .manage(AgentState::new())
        .invoke_handler(tauri::generate_handler![
            agent_info,
            session_state,
            socket_connect,
            socket_send,
            confirm_join,
            set_sharing,
            leave_room,
            api_fetch,
            control_state,
            control_answer,
            control_keep_going,
            control_stop,
            control_mute,
        ])
        .setup(|app| {
            let handle = app.handle();
            let tray = tray::build(handle)?;
            *app.state::<AgentState>().tray.lock().unwrap() = Some(tray);
            notify(handle);
            start_control_clock(handle);
            guard_against_injected_input(handle);
            #[cfg(feature = "updater")]
            updater::start(handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the agent in the tray (and in the room); the control windows
            // cannot be closed at all: the dialog is answered or runs out, the border and the 中斷
            // button stay while someone controls this computer (§5.4)
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the LongTalk agent");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_codes_are_the_normalized_form() {
        assert!(is_pairing_code("7K3MQ9TD"));
        assert!(!is_pairing_code("7K3M-Q9TD"));
        assert!(!is_pairing_code("7k3mq9td"));
        assert!(!is_pairing_code("7K3MQ9TU")); // U is not in Crockford base32
        assert!(!is_pairing_code("7K3MQ9T"));
    }

    #[test]
    fn refusals_are_codes_for_the_page() {
        assert_eq!(refusal(Refusal::NotArmed), "notArmed");
        assert_eq!(refusal(Refusal::WrongPhase), "wrongPhase");
    }
}

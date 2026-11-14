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
//
// Injection (N4, inject/, escape.rs, agent_log.rs; §5.4, §5.6, §5.8, §5.10): an accepted batch is
// planned against what is held (blocked combinations are not pressed, shown ones are named on the
// 中斷 window) and performed by the OS's injector, which refuses presses aimed at the agent's own
// windows; while someone controls this computer a physical Escape ×3 stops it (Windows), so does a
// locked session; it starts with a system notification and a red tray icon; every request,
// answer, start, end and blocked or shown combination goes to the agent log, nothing typed ever.
//
// N5 (e9-t08, e9-t09; §5.11, §5.12): Linux injects with XTest (inject/linux.rs), macOS has its
// per-window check and Escape ×3 with Input Monitoring; the window guides the person through what
// the OS must allow (permissions.rs); a paste the person allowed in the consent dialog goes on the
// clipboard (clipboard.rs, write only, never logged but its length); the secure desktop pauses
// injection and the room is told (`controlStatus`); when several screens fit the share, the
// person picks which one the pointer aims at (choose_screen, never while controlled).

mod agent_log;
mod clipboard;
mod control;
mod control_windows;
mod escape;
mod inject;
mod origin;
mod permissions;
mod session;
mod socket;
mod tray;
#[cfg(feature = "updater")]
mod updater;

use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use agent_log::{AgentLog, Entry};
use control::{Control, ControlEvent, ControlRefusal, ControlView, Decision, Effects, StopReason};
use inject::{Injector, Platform, Screen, Skipped};
use session::{Outgoing, Phase, Refusal, Session};
use socket::{Out, SocketEvent, SocketHandle};
use tauri_plugin_notification::NotificationExt;

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
    /** N4: the OS's injector, and which screen the share shows (from the captured size) */
    injector: Mutex<Box<dyn Injector>>,
    captured: Mutex<Option<(u32, u32)>>,
    screen: Mutex<Option<Screen>>,
    /** N5: the screen the person picked when several fit the share (choose_screen) */
    chosen: Mutex<Option<Screen>>,
    pub log: Mutex<AgentLog>,
    /** The physical Escape ×3 hook, only while someone controls this computer (escape.rs) */
    escape: Mutex<Option<escape::Watch>>,
    /** What was logged once for the live grant (a skip, a dropped batch) */
    logged_once: Mutex<HashSet<&'static str>>,
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
            injector: Mutex::new(inject::injector()),
            captured: Mutex::new(None),
            screen: Mutex::new(None),
            chosen: Mutex::new(None),
            log: Mutex::new(AgentLog::new(None)),
            escape: Mutex::new(None),
            logged_once: Mutex::new(HashSet::new()),
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
     * What a control step asks for: what it releases is injected first (nothing stays held), then
     * its frames go to the room, and a grant that ended is logged; the windows follow `changed`
     * (notify_control)
     */
    pub(crate) fn apply(&self, effects: &Effects) {
        if !effects.release.is_empty() {
            self.inject(&effects.release, &[], &control::Held::new());
        }
        for frame in &effects.send {
            self.send_raw(Out::Text(frame.clone()));
        }
        if let Some(ended) = &effects.ended {
            self.log.lock().unwrap().write(&Entry::Ended {
                grant: &ended.grant,
                reason: &ended.reason,
            });
        }
    }

    /** Writes `what` to the log once for the live grant */
    fn log_once(&self, what: &'static str) {
        if self.logged_once.lock().unwrap().insert(what) {
            self.log.lock().unwrap().write(&Entry::Skipped { what });
        }
    }

    /**
     * Plans and performs `release` then `events` (inject/), logs what it blocked or skipped, and
     * returns the names of the combinations to show on the 中斷 window
     */
    fn inject(
        &self,
        release: &[ControlEvent],
        events: &[ControlEvent],
        held_before: &control::Held,
    ) -> Vec<String> {
        let screen = *self.screen.lock().unwrap();
        let plan = inject::plan(
            release,
            events,
            held_before,
            screen.as_ref(),
            Platform::current(),
        );
        {
            let mut log = self.log.lock().unwrap();
            for entry in agent_log::entries_for(&plan) {
                log.write(&entry);
            }
        }
        if plan.no_screen {
            self.log_once("noScreen");
        }
        let skipped = self.injector.lock().unwrap().perform(&plan.actions);
        for kind in skipped {
            self.log_once(match kind {
                Skipped::AgentWindow => "agentWindow",
                Skipped::SecureDesktop => "secureDesktop",
                Skipped::UnknownKey => "unknownKey",
                Skipped::Refused => "refusedByOs",
            });
        }
        plan.warned
    }

    /**
     * The screen the share shows, for the pointer (inject::pick_screen_chosen): the person's choice
     * while it fits the share, else the best fit
     */
    fn pick_screen(&self) {
        let captured = *self.captured.lock().unwrap();
        let chosen = *self.chosen.lock().unwrap();
        let screens = self.injector.lock().unwrap().screens();
        *self.screen.lock().unwrap() = inject::pick_screen_chosen(&screens, captured, chosen);
    }

    fn room(&self) -> String {
        self.session
            .lock()
            .unwrap()
            .room()
            .unwrap_or_default()
            .to_owned()
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
    sync_escape(app, granted);
    let _ = app.emit(CONTROL_EVENT, view);
}

/**
 * The Escape hook lives exactly as long as a grant (escape.rs, T-17): started when control starts,
 * dropped (unhooked) when it ends
 */
fn sync_escape(app: &AppHandle, granted: bool) {
    let state = app.state::<AgentState>();
    let mut watch = state.escape.lock().unwrap();
    match (granted, watch.is_some()) {
        (true, false) => {
            let app = app.clone();
            *watch = escape::Watch::start(move || {
                // From the hook's thread: hand it to the runtime, never stop inside the hook
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    stop_control(&app, StopReason::Escape);
                });
            });
        }
        (false, true) => *watch = None,
        _ => {}
    }
}

/** Control just started: the log, the screen to aim at, a system notification (§5.4) */
fn on_grant_started(app: &AppHandle) {
    let state = app.state::<AgentState>();
    let (grant, controller, minutes) = {
        let control = state.control.lock().unwrap();
        let Some(grant) = control.grant() else {
            return;
        };
        (
            grant.grant.clone(),
            grant.controller_name.clone(),
            grant
                .ends_at
                .map(|end| end.saturating_sub(grant.started_at) / 60_000),
        )
    };
    state.logged_once.lock().unwrap().clear();
    state.pick_screen();
    state.log.lock().unwrap().write(&Entry::Started {
        room: &state.room(),
        grant: &grant,
        controller: &controller,
        minutes,
    });
    // Escape ×3 works on Windows, and on a Mac that gave Input Monitoring (escape.rs, N5)
    let escape = cfg!(target_os = "windows")
        || (cfg!(target_os = "macos")
            && permissions::current().input_monitoring == permissions::Access::Granted);
    let (title, body) = tray::notification(&controller, escape);
    let _ = app.notification().builder().title(title).body(body).show();
}

/** A control frame from the room (socket.rs): to control.rs, never to the page */
pub fn on_control_frame(app: &AppHandle, kind: &str, value: &serde_json::Value, raw: &str) {
    let state = app.state::<AgentState>();
    let now = state.now();
    let str_of = |name: &str| value.get(name).and_then(|v| v.as_str()).unwrap_or("");
    let mut started = false;
    let changed = match kind {
        "controlAsk" => {
            let asked = state.control.lock().unwrap().on_ask(value, now);
            if asked {
                let from = value.get("from");
                let from_field = |name: &str| {
                    from.and_then(|f| f.get(name))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                };
                state.log.lock().unwrap().write(&Entry::Asked {
                    room: &state.room(),
                    request: str_of("request"),
                    from_name: from_field("name"),
                    from_id: from_field("id"),
                });
            }
            asked
        }
        "controlAskEnd" => state.control.lock().unwrap().on_ask_end(str_of("request")),
        "controlStart" => {
            started = state.control.lock().unwrap().on_start(value, now);
            if !started {
                state.log.lock().unwrap().write(&Entry::StartRefused);
            }
            started
        }
        "controlEnd" => {
            let effects = state
                .control
                .lock()
                .unwrap()
                .on_end(str_of("grant"), str_of("reason"));
            state.apply(&effects);
            effects.changed
        }
        "controlForward" => {
            let accepted = state.control.lock().unwrap().on_forward(raw, now);
            match accepted {
                Ok(batch) => {
                    // Injected, then forgotten: what a batch carried is never logged or kept (D11)
                    let warned = state.inject(&batch.release, &batch.events, &batch.held_before);
                    let mut control = state.control.lock().unwrap();
                    let mut shown = false;
                    for name in warned {
                        shown |= control.hint(name, now);
                    }
                    shown
                }
                Err(dropped) => {
                    match dropped {
                        control::Dropped::Malformed => state.log_once("malformedBatch"),
                        control::Dropped::OtherGrant => state.log_once("otherGrantBatch"),
                        control::Dropped::Stale => state.log_once("staleBatch"),
                        control::Dropped::Invalid => state.log_once("invalidBatch"),
                        // After the end, or while the hourly question is up: expected
                        control::Dropped::NotGranted
                        | control::Dropped::Paused
                        | control::Dropped::NoClipboard => {}
                    }
                    false
                }
            }
        }
        // N5 (e9-t09): onto the clipboard, then forgotten; the log gets the length only (T-22)
        "controlPaste" => {
            let pasted = state.control.lock().unwrap().on_paste(raw, now);
            match pasted {
                Ok(text) => {
                    let written = clipboard::write_text(&text);
                    state.log.lock().unwrap().write(&Entry::Pasted {
                        chars: text.encode_utf16().count(),
                        written,
                    });
                    true
                }
                Err(control::Dropped::NoClipboard) => {
                    state.log_once("pasteNotAllowed");
                    false
                }
                Err(control::Dropped::Malformed) => {
                    state.log_once("malformedPaste");
                    false
                }
                Err(_) => false,
            }
        }
        _ => false,
    };
    if started {
        on_grant_started(app);
    }
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
            // A locked session or a screen saver ends control (§5.3 step 5); unlocking does not
            // bring it back
            let granted = state.control.lock().unwrap().granted();
            if granted && inject::session_locked() {
                stop_control(&app, StopReason::Locked);
                continue;
            }
            // N5 (§5.12, T-16): the secure desktop pauses injection; the controller is told, and
            // told again when it is gone
            if granted {
                let secure = inject::secure_desktop();
                let effects = state.control.lock().unwrap().set_blocked(secure);
                if effects.changed {
                    state
                        .log
                        .lock()
                        .unwrap()
                        .write(&Entry::SecureDesktop { on: secure });
                    state.apply(&effects);
                    notify_control(&app);
                }
            }
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
    clipboard: Option<bool>,
) -> Result<(), String> {
    let decision = Decision::parse(&decision).ok_or("bad_decision")?;
    // N5: 「也允許對方貼上文字到這台電腦」, off unless ticked; it counts only with an allow
    let clipboard = clipboard == Some(true) && decision != Decision::Deny;
    let effects = state
        .control
        .lock()
        .unwrap()
        .answer_with(&request, decision, mute_ms, clipboard, state.now())
        .map_err(control_refusal);
    notify_control(&app);
    let effects = effects?;
    state.log.lock().unwrap().write(&Entry::Answered {
        request: &request,
        decision: decision.wire(),
        mute_ms,
        clipboard,
    });
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
 * The captured share's size (the page reads it from the track's settings), so the pointer lands
 * on the screen it shows (inject::pick_screen); `monitor` false (a window or a tab) or no size
 * keeps the pointer still. It only aims: it cannot start, widen or extend control.
 */
#[tauri::command]
fn shared_screen(
    state: State<'_, AgentState>,
    width: Option<u32>,
    height: Option<u32>,
    monitor: bool,
) {
    let size = match (monitor, width, height) {
        (true, Some(w), Some(h)) if w > 0 && h > 0 && w <= 16_384 && h <= 16_384 => Some((w, h)),
        _ => None,
    };
    *state.captured.lock().unwrap() = size;
    state.pick_screen();
}

/**
 * 「不允許貼上」 (N5): the 中斷 window, the main window or the tray turn pasting off for the rest of
 * this grant. Only ever off: turning it on is the consent dialog's alone, so even a press the
 * controller managed to inject here could only take pasting away.
 */
#[tauri::command]
fn control_clipboard_off(app: AppHandle, state: State<'_, AgentState>) {
    clipboard_off(&app, &state);
}

fn clipboard_off(app: &AppHandle, state: &AgentState) {
    let effects = state.control.lock().unwrap().clipboard_off();
    if effects.changed {
        state.log.lock().unwrap().write(&Entry::ClipboardOff);
        state.apply(&effects);
        notify_control(app);
    }
}

/** 「不允許貼上」 in the tray (N5) */
pub fn clipboard_off_from_tray(app: &AppHandle) {
    let state = app.state::<AgentState>();
    clipboard_off(app, &state);
}

/** One screen for the main window's 「你分享的是哪一個螢幕？」 (N5) */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenChoice {
    /** Its place in `screens`' answer, for choose_screen */
    index: usize,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    primary: bool,
    /** The pointer aims at this one now */
    aimed: bool,
}

/**
 * The screens that fit the share (inject::candidates), when there is a choice to make: two or more
 * screens of the captured size. Empty otherwise (nothing to choose).
 */
#[tauri::command]
fn screens(state: State<'_, AgentState>) -> Vec<ScreenChoice> {
    let captured = *state.captured.lock().unwrap();
    let all = state.injector.lock().unwrap().screens();
    let fitting = inject::candidates(&all, captured);
    if fitting.len() < 2 {
        return Vec::new();
    }
    let aimed = *state.screen.lock().unwrap();
    fitting
        .iter()
        .enumerate()
        .map(|(index, s)| ScreenChoice {
            index,
            width: s.pixel_width,
            height: s.pixel_height,
            x: s.x,
            y: s.y,
            primary: s.primary,
            aimed: aimed == Some(*s),
        })
        .collect()
}

/**
 * 「你分享的是哪一個螢幕？」 (N5, e9-t09): which of the screens that fit the share the pointer aims at
 * (`index` into `screens`' answer; None: let the agent guess). Refused while someone controls this
 * computer: the controller's own clicks could otherwise point the pointer at a screen nobody sees.
 */
#[tauri::command]
fn choose_screen(state: State<'_, AgentState>, index: Option<usize>) -> Result<(), String> {
    if state.control.lock().unwrap().granted() {
        return Err("controlled".into());
    }
    let chosen = match index {
        None => None,
        Some(index) => {
            let captured = *state.captured.lock().unwrap();
            let all = state.injector.lock().unwrap().screens();
            Some(
                *inject::candidates(&all, captured)
                    .get(index)
                    .ok_or("bad_screen")?,
            )
        }
    };
    *state.chosen.lock().unwrap() = chosen;
    state.pick_screen();
    Ok(())
}

/** What the OS must allow for control to work here (N5, the window's guide) */
#[tauri::command]
fn permissions_state() -> permissions::Permissions {
    permissions::current()
}

/** The guide's 「打開設定」 for one macOS permission (the person's own press; macOS decides) */
#[tauri::command]
fn request_permission(kind: String) -> Result<bool, String> {
    let kind = permissions::Kind::parse(&kind).ok_or("bad_permission")?;
    Ok(permissions::request(kind))
}

/** 「開啟日誌」 in the tray: the agent log's folder */
pub fn open_log(app: &AppHandle) {
    let state = app.state::<AgentState>();
    let dir = state.log.lock().unwrap().dir().map(|d| d.to_path_buf());
    if let Some(dir) = dir {
        agent_log::open_folder(&dir);
    }
}

pub fn run() {
    tauri::Builder::default()
        // First: a second launch only brings this one's window up (§5.8)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_notification::init())
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
            shared_screen,
            control_clipboard_off,
            screens,
            choose_screen,
            permissions_state,
            request_permission,
        ])
        .setup(|app| {
            let handle = app.handle();
            *app.state::<AgentState>().log.lock().unwrap() =
                AgentLog::new(handle.path().app_log_dir().ok());
            let tray = tray::build(handle)?;
            *app.state::<AgentState>().tray.lock().unwrap() = Some(tray);
            notify(handle);
            start_control_clock(handle);
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

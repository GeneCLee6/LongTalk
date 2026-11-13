// The room socket, owned by Rust (not the WebView's WebSocket) for three reasons:
// - the agent only ever connects to origin.rs's domain: the page names a room, never a URL;
// - the session (session.rs) sees every frame: `agentWelcome` moves it to the confirmation, and a
//   frame from the page that would publish before the person confirmed is refused here;
// - the agent token stays in Rust (memory only, §5.1 step 6): the page gets the welcome without it.
// One socket at a time. What the page gets: `open`, each frame (`message`, the welcome without its
// token) and `close` with the code; heartbeat and reconnecting are the page's (agent/ui).

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri::Manager;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

use crate::session::Welcome;
use crate::AgentState;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SocketEvent {
    Open,
    Message { data: String },
    Close { code: u16, reason: String },
}

pub enum Out {
    Text(String),
    Close,
}

pub struct SocketHandle {
    pub id: u32,
    pub tx: mpsc::UnboundedSender<Out>,
}

/** Close codes after which the room will not take this agent back (shared/protocol.ts CloseCode) */
pub fn closed_for_good(code: u16) -> bool {
    // 44xx: refused or removed, except `stale` (4408), after which the browser reconnects too
    (4400..=4499).contains(&code) && code != 4408
}

/**
 * Reads `agentWelcome` (shared/control.ts AgentWelcomeMessage): the welcome for the session, and
 * the frame the page gets (the same, without the token). None when it is not a welcome.
 */
pub fn read_welcome(text: &str) -> Option<(Welcome, String)> {
    let mut value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("t")?.as_str()? != "agentWelcome" {
        return None;
    }
    let field = |name: &str| value.get(name).and_then(|v| v.as_str()).map(str::to_owned);
    // A string or null; None (not a welcome) for anything else or a missing field
    let optional = |name: &str| match value.get(name)? {
        serde_json::Value::Null => Some(None),
        serde_json::Value::String(text) => Some(Some(text.clone())),
        _ => None,
    };
    let welcome = Welcome {
        member_id: field("memberId")?,
        token: field("token")?,
        owner_name: field("ownerName")?,
        room_name: optional("roomName")?,
        created_by: optional("createdBy")?,
    };
    value.as_object_mut()?.remove("token");
    Some((welcome, value.to_string()))
}

/** Opens the socket and runs it until it closes; `hello` is the first frame */
pub async fn run(
    app: AppHandle,
    id: u32,
    url: String,
    hello: String,
    mut rx: mpsc::UnboundedReceiver<Out>,
    events: Channel<SocketEvent>,
) {
    let ws = match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok((ws, _)) => ws,
        Err(_) => return finish(&app, id, 1006, "connect_failed", &events),
    };
    let (mut write, mut read) = ws.split();
    if write.send(Message::text(hello)).await.is_err() {
        return finish(&app, id, 1006, "send_failed", &events);
    }
    let _ = events.send(SocketEvent::Open);
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(Out::Text(text)) => {
                    if write.send(Message::text(text)).await.is_err() {
                        return finish(&app, id, 1006, "send_failed", &events);
                    }
                }
                // Asked to close, or replaced by a newer socket (the sender was dropped)
                Some(Out::Close) | None => {
                    let frame = CloseFrame { code: CloseCode::Normal, reason: "".into() };
                    let _ = write.send(Message::Close(Some(frame))).await;
                    return finish(&app, id, 1000, "closed", &events);
                }
            },
            message = read.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let data = incoming(&app, text.as_str());
                    let _ = events.send(SocketEvent::Message { data });
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.as_str().to_owned()))
                        .unwrap_or((1005, String::new()));
                    return finish(&app, id, code, &reason, &events);
                }
                // Pings are answered by tungstenite; the room sends no binary frames
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return finish(&app, id, 1006, "dropped", &events),
            },
        }
    }
}

/** A frame from the room: the welcome goes to the session first; returns what the page gets */
fn incoming(app: &AppHandle, text: &str) -> String {
    let Some((welcome, forwarded)) = read_welcome(text) else {
        return text.to_owned();
    };
    let state = app.state::<AgentState>();
    let now = state.now();
    let changed = state.session.lock().unwrap().on_welcome(welcome, now);
    if changed {
        crate::notify(app);
    }
    forwarded
}

fn finish(app: &AppHandle, id: u32, code: u16, reason: &str, events: &Channel<SocketEvent>) {
    let state = app.state::<AgentState>();
    let current = {
        let mut socket = state.socket.lock().unwrap();
        if socket.as_ref().map(|s| s.id) == Some(id) {
            *socket = None;
            true
        } else {
            false
        }
    };
    if current {
        let ended = state
            .session
            .lock()
            .unwrap()
            .on_socket_closed(closed_for_good(code));
        if ended {
            crate::notify(app);
        }
    }
    let _ = events.send(SocketEvent::Close {
        code,
        reason: reason.to_owned(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_welcome_reaches_the_page_without_its_token() {
        let token = "A".repeat(43);
        let text = format!(
            r#"{{"t":"agentWelcome","memberId":"m1","token":"{token}","owner":"o1","ownerName":"Alice","roomName":"週五讀書會","createdBy":"Alice"}}"#
        );
        let (welcome, forwarded) = read_welcome(&text).unwrap();
        assert_eq!(welcome.token, token);
        assert_eq!(welcome.owner_name, "Alice");
        assert_eq!(welcome.room_name.as_deref(), Some("週五讀書會"));
        assert_eq!(welcome.created_by.as_deref(), Some("Alice"));
        let unnamed = r#"{"t":"agentWelcome","memberId":"m1","token":"x","owner":"o1","ownerName":"Alice","roomName":null,"createdBy":"Bob"}"#;
        let (welcome, _) = read_welcome(unnamed).unwrap();
        assert_eq!(welcome.room_name, None);
        assert_eq!(welcome.created_by.as_deref(), Some("Bob"));
        assert!(!forwarded.contains(&token));
        assert!(forwarded.contains("\"ownerName\":\"Alice\""));
        assert!(read_welcome(r#"{"t":"patch"}"#).is_none());
        assert!(read_welcome(r#"{"t":"agentWelcome","memberId":"m1"}"#).is_none());
        assert!(read_welcome("pong").is_none());
    }

    #[test]
    fn which_closes_are_for_good() {
        assert!(closed_for_good(4400)); // versionMismatch
        assert!(closed_for_good(4403)); // removed
        assert!(closed_for_good(4411)); // ended
        assert!(closed_for_good(4420)); // rateLimited
        assert!(!closed_for_good(4408)); // stale: reconnect
        assert!(!closed_for_good(1006));
        assert!(!closed_for_good(1000));
    }
}

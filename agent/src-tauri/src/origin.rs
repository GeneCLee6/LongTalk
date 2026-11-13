// The one server this agent talks to (docs/PRD/f-remote-control-security.md §5.8): written into
// the build, never taken from a pasted link. A PR-preview build sets LONGTALK_AGENT_ORIGIN when it
// is compiled (`LONGTALK_AGENT_ORIGIN=https://… npm run agent:build`); a release build is always
// the production domain. Every room socket and every API call goes through the helpers below, which
// only ever build URLs on this origin, for paths of the room the agent is in.

/** The production Worker */
pub const PRODUCTION_ORIGIN: &str = "https://longtalk.genelee-pro.workers.dev";

/** The origin this build talks to: the production domain unless the build said otherwise */
pub fn origin() -> &'static str {
    match option_env!("LONGTALK_AGENT_ORIGIN") {
        Some(value) if is_https_origin(value) => value,
        _ => PRODUCTION_ORIGIN,
    }
}

/** `https://host` with no path, query, credentials or port games */
fn is_https_origin(value: &str) -> bool {
    let Some(host) = value.strip_prefix("https://") else {
        return false;
    };
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/**
 * A room's address as the agent accepts it: a random id or a persistent room's slug (shared/
 * room-id.ts, shared/slug.ts), both made of ASCII letters, digits and hyphens. The room checks the
 * real rules; this only keeps anything else (slashes, `..`, query strings) out of the URLs.
 */
pub fn is_room_key(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/** shared/control.ts AGENT_PROTOCOL_VERSION */
pub const AGENT_PROTOCOL_VERSION: u32 = 1;

/** The room's agent socket: wss://<origin>/api/rooms/<room>/agent?v=AGENT_PROTOCOL_VERSION */
pub fn agent_socket_url(room: &str) -> Option<String> {
    if !is_room_key(room) {
        return None;
    }
    let host = origin().strip_prefix("https://")?;
    Some(format!(
        "wss://{host}/api/rooms/{room}/agent?v={AGENT_PROTOCOL_VERSION}"
    ))
}

/** What an API path the bundled UI asks for is allowed to be */
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ApiCall {
    /** The SFU proxy (worker/sfu.ts); `adds_tracks`: POST …/tracks (publishing or subscribing) */
    Sfu { adds_tracks: bool },
    /** TURN credentials for the room (worker/turn.ts) */
    Turn,
}

/**
 * The calls the transport makes, for the room the agent is in, and nothing else: POST
 * /api/sfu/<room>/sessions, POST|PUT /api/sfu/<room>/sessions/<id>/…, GET for a session's state,
 * and POST /api/turn/<room>. None for anything else (another room, another path, `..`).
 */
pub fn classify_api_call(method: &str, path: &str, room: &str) -> Option<ApiCall> {
    if !is_room_key(room) {
        return None;
    }
    if path.contains("..") || path.contains('?') || path.contains('#') || path.contains("//") {
        return None;
    }
    if path == format!("/api/turn/{room}") {
        return (method == "POST").then_some(ApiCall::Turn);
    }
    let rest = path.strip_prefix(&format!("/api/sfu/{room}/sessions"))?;
    if !matches!(method, "GET" | "POST" | "PUT") {
        return None;
    }
    if rest.is_empty() {
        return (method == "POST").then_some(ApiCall::Sfu { adds_tracks: false });
    }
    let rest = rest.strip_prefix('/')?;
    let valid = rest
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_'));
    if !valid {
        return None;
    }
    let adds_tracks = method == "POST" && rest.ends_with("/tracks");
    Some(ApiCall::Sfu { adds_tracks })
}

/** The full URL of an allowed path (call classify_api_call first) */
pub fn api_url(path: &str) -> String {
    format!("{}{}", origin(), path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_defaults_to_production() {
        if option_env!("LONGTALK_AGENT_ORIGIN").is_none() {
            assert_eq!(origin(), PRODUCTION_ORIGIN);
        }
        assert!(is_https_origin(PRODUCTION_ORIGIN));
        assert!(!is_https_origin("http://longtalk.genelee-pro.workers.dev"));
        assert!(!is_https_origin("https://evil.example/path"));
        assert!(!is_https_origin("https://user@evil.example"));
        assert!(!is_https_origin("https://evil.example:8443"));
    }

    #[test]
    fn socket_url_only_for_room_keys() {
        let url = agent_socket_url("Ab3dEf7hJk").unwrap();
        assert!(url.starts_with("wss://"));
        assert!(url.ends_with("/api/rooms/Ab3dEf7hJk/agent?v=1"));
        assert_eq!(agent_socket_url("../admin"), None);
        assert_eq!(agent_socket_url("a/b"), None);
        assert_eq!(agent_socket_url(""), None);
    }

    #[test]
    fn api_calls_are_limited_to_the_room() {
        let room = "Ab3dEf7hJk";
        assert_eq!(
            classify_api_call("POST", "/api/sfu/Ab3dEf7hJk/sessions", room),
            Some(ApiCall::Sfu { adds_tracks: false })
        );
        assert_eq!(
            classify_api_call("POST", "/api/sfu/Ab3dEf7hJk/sessions/abc123/tracks", room),
            Some(ApiCall::Sfu { adds_tracks: true })
        );
        assert_eq!(
            classify_api_call(
                "PUT",
                "/api/sfu/Ab3dEf7hJk/sessions/abc123/tracks/close",
                room
            ),
            Some(ApiCall::Sfu { adds_tracks: false })
        );
        assert_eq!(
            classify_api_call("POST", "/api/turn/Ab3dEf7hJk", room),
            Some(ApiCall::Turn)
        );
        // Another room, another API, path tricks
        assert_eq!(
            classify_api_call("POST", "/api/sfu/Other12345/sessions", room),
            None
        );
        assert_eq!(
            classify_api_call("POST", "/api/turn/Other12345", room),
            None
        );
        assert_eq!(classify_api_call("GET", "/api/account/me", room), None);
        assert_eq!(
            classify_api_call("POST", "/api/sfu/Ab3dEf7hJk/sessions/../../admin", room),
            None
        );
        assert_eq!(
            classify_api_call("POST", "/api/sfu/Ab3dEf7hJk/sessions/a?x=1", room),
            None
        );
        assert_eq!(
            classify_api_call("DELETE", "/api/sfu/Ab3dEf7hJk/sessions/a", room),
            None
        );
        assert_eq!(
            classify_api_call("POST", "/api/sfu/Ab3dEf7hJk/sessionsX", room),
            None
        );
    }
}

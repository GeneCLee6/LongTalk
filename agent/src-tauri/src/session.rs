// The agent's session in a room and the local confirmation before anything is published
// (docs/PRD/f-remote-control-security.md §5.1 step 4, test T-01a). Kept in Rust, not in the
// WebView's TypeScript, because Rust is where the agent's network boundary is: the room socket
// (socket.rs) and every SFU call (lib.rs api_fetch) ask this state machine before they let a frame
// or a request out, so a bug or an injected script in the page still cannot publish a screen the
// person did not agree to share. The tray menu (tray.rs) reads it too, and N4's input injection will
// be gated on it in the same place.
//
//   Idle ──start──▶ Connecting ──agentWelcome──▶ Confirming ──confirm (≥ 1 s)──▶ InRoom{sharing: off}
//     ▲                 │                           │                               │  set_sharing
//     └──── cancel / leave / a socket closed for good ◀─────────────────────────────┘
//
// - Nothing that publishes (`share`, `tracks` with a track, an SFU call that adds tracks) is let
//   out before InRoom, and only while the person's own 「分享我的螢幕」 switch is on.
// - The switch starts off on every confirmation; the confirmation's buttons do nothing for
//   CONSENT_DIALOG_ARM_MS after it appears (a click meant for something else).
// - Cancel leaves the room (the caller sends `leave` and closes the socket).
// - A socket that drops and comes back (the token, in memory only) keeps the phase; the token is
//   forgotten whenever the session goes back to Idle.

use serde::Serialize;

/** shared/control.ts CONSENT_DIALOG_ARM_MS */
pub const CONSENT_DIALOG_ARM_MS: u64 = 1_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    /** Not in a room */
    Idle,
    /** The socket is open (or opening) with a pairing code; no `agentWelcome` yet */
    Connecting,
    /** The room accepted the code; the local confirmation is showing. Nothing is published. */
    #[serde(rename_all = "camelCase")]
    Confirming {
        owner_name: String,
        /** null: the room has no name; the page shows 「{created_by} 的房間」 as browsers do */
        room_name: Option<String>,
        created_by: Option<String>,
    },
    /** The person pressed 加入. `sharing`: their 「分享我的螢幕」 switch (off until they turn it on) */
    #[serde(rename_all = "camelCase")]
    InRoom {
        owner_name: String,
        room_name: Option<String>,
        created_by: Option<String>,
        sharing: bool,
    },
}

#[derive(Debug, PartialEq, Eq, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    /** Not possible in this phase */
    WrongPhase,
    /** The confirmation's buttons are not armed yet (CONSENT_DIALOG_ARM_MS) */
    NotArmed,
    /** The room key is not one */
    BadRoom,
}

/** The welcome as the socket read it (the token stays in Rust) */
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Welcome {
    pub member_id: String,
    pub token: String,
    pub owner_name: String,
    pub room_name: Option<String>,
    pub created_by: Option<String>,
}

#[derive(Debug)]
pub struct Session {
    phase: Phase,
    room: Option<String>,
    member_id: Option<String>,
    /** The agent token from `agentWelcome`: memory only, for reconnecting and the SFU proxy */
    token: Option<String>,
    /** When the confirmation appeared, on the caller's monotonic clock (ms) */
    confirm_shown_at: Option<u64>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            phase: Phase::Idle,
            room: None,
            member_id: None,
            token: None,
            confirm_shown_at: None,
        }
    }

    pub fn phase(&self) -> &Phase {
        &self.phase
    }

    pub fn room(&self) -> Option<&str> {
        self.room.as_deref()
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn member_id(&self) -> Option<&str> {
        self.member_id.as_deref()
    }

    /** In a room, confirmed (InRoom): the phase where the agent is a visible member */
    pub fn in_room(&self) -> bool {
        matches!(self.phase, Phase::InRoom { .. })
    }

    /** The person's share switch is on (only ever in InRoom) */
    pub fn sharing(&self) -> bool {
        matches!(self.phase, Phase::InRoom { sharing: true, .. })
    }

    /** 加入 with a pairing code: from Idle only */
    pub fn start(&mut self, room: &str) -> Result<(), Refusal> {
        if self.phase != Phase::Idle {
            return Err(Refusal::WrongPhase);
        }
        if !crate::origin::is_room_key(room) {
            return Err(Refusal::BadRoom);
        }
        *self = Self::new();
        self.room = Some(room.to_owned());
        self.phase = Phase::Connecting;
        Ok(())
    }

    /**
     * The token to reconnect with after the socket dropped: only once welcomed (Confirming or
     * InRoom). A drop before the welcome is a failed pairing, never retried with the code.
     */
    pub fn reconnect_token(&self) -> Option<&str> {
        match self.phase {
            Phase::Confirming { .. } | Phase::InRoom { .. } => self.token.as_deref(),
            _ => None,
        }
    }

    /**
     * `agentWelcome` arrived. The first one shows the confirmation (from `now`); one after a
     * reconnect keeps the phase (and the share switch) and refreshes the token. Returns whether the
     * phase changed.
     */
    pub fn on_welcome(&mut self, welcome: Welcome, now: u64) -> bool {
        match &self.phase {
            Phase::Connecting => {
                self.member_id = Some(welcome.member_id);
                self.token = Some(welcome.token);
                self.confirm_shown_at = Some(now);
                self.phase = Phase::Confirming {
                    owner_name: welcome.owner_name,
                    room_name: welcome.room_name,
                    created_by: welcome.created_by,
                };
                true
            }
            Phase::Confirming { .. } | Phase::InRoom { .. } => {
                // The same member coming back: the room keeps who it is
                self.member_id = Some(welcome.member_id);
                self.token = Some(welcome.token);
                false
            }
            Phase::Idle => false,
        }
    }

    /** 加入 on the confirmation: armed CONSENT_DIALOG_ARM_MS after it appeared; the share stays off */
    pub fn confirm(&mut self, now: u64) -> Result<(), Refusal> {
        let Phase::Confirming {
            owner_name,
            room_name,
            created_by,
        } = &self.phase
        else {
            return Err(Refusal::WrongPhase);
        };
        let shown = self.confirm_shown_at.ok_or(Refusal::WrongPhase)?;
        if now.saturating_sub(shown) < CONSENT_DIALOG_ARM_MS {
            return Err(Refusal::NotArmed);
        }
        self.phase = Phase::InRoom {
            owner_name: owner_name.clone(),
            room_name: room_name.clone(),
            created_by: created_by.clone(),
            sharing: false,
        };
        Ok(())
    }

    /**
     * 取消 on the confirmation (armed like 加入), or 離開房間 / 結束: back to Idle, the token forgotten.
     * Returns whether there was a room to leave (the caller sends `leave` and closes the socket).
     */
    pub fn leave(&mut self) -> bool {
        let had_room = self.phase != Phase::Idle;
        *self = Self::new();
        had_room
    }

    /** 取消 on the confirmation: armed like 加入 so a stray click does not decide either way */
    pub fn cancel(&mut self, now: u64) -> Result<(), Refusal> {
        if !matches!(self.phase, Phase::Confirming { .. }) {
            return Err(Refusal::WrongPhase);
        }
        let shown = self.confirm_shown_at.unwrap_or(0);
        if now.saturating_sub(shown) < CONSENT_DIALOG_ARM_MS {
            return Err(Refusal::NotArmed);
        }
        self.leave();
        Ok(())
    }

    /** The person's 「分享我的螢幕」 switch: only in the room, after the confirmation */
    pub fn set_sharing(&mut self, on: bool) -> Result<(), Refusal> {
        match &mut self.phase {
            Phase::InRoom { sharing, .. } => {
                *sharing = on;
                Ok(())
            }
            _ if !on => Ok(()),
            _ => Err(Refusal::WrongPhase),
        }
    }

    /**
     * The socket closed. `for_good`: the room will not take this agent back (a 44xx close other
     * than `stale`, or a close before the welcome, which is a refused pairing). Otherwise the phase
     * stays while the UI reconnects with the token. Returns whether the session ended.
     */
    pub fn on_socket_closed(&mut self, for_good: bool) -> bool {
        if for_good || self.phase == Phase::Connecting {
            return self.leave();
        }
        false
    }

    /** Whether a frame the UI asks to send on the room socket may go out now */
    pub fn may_send(&self, frame: &Outgoing) -> bool {
        match frame {
            Outgoing::Ping => self.phase != Phase::Idle,
            // Ending a share, or leaving, is always allowed
            Outgoing::Unshare | Outgoing::Leave => self.phase != Phase::Idle,
            Outgoing::Share => self.sharing(),
            Outgoing::Tracks { publishes } => {
                if *publishes {
                    self.sharing()
                } else {
                    self.in_room()
                }
            }
            // agentHello is written by socket.rs itself; control answers arrive with N3 through
            // their own Rust paths (never as raw text from the page: T-04)
            Outgoing::Other => false,
        }
    }

    /** Whether an SFU proxy or TURN call may go out now (`adds_tracks`: POST …/tracks) */
    pub fn may_call_api(&self, adds_tracks: bool) -> bool {
        if adds_tracks {
            self.sharing()
        } else {
            self.in_room()
        }
    }
}

/** A frame the page asks to send, as may_send sorts it */
#[derive(Debug, PartialEq, Eq)]
pub enum Outgoing {
    Ping,
    Share,
    Unshare,
    Leave,
    /** `publishes`: the list names at least one track */
    Tracks {
        publishes: bool,
    },
    Other,
}

impl Outgoing {
    /** Sorts a text frame from the page: `ping`, or JSON with `t` */
    pub fn classify(text: &str) -> Self {
        if text == "ping" {
            return Outgoing::Ping;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return Outgoing::Other;
        };
        match value.get("t").and_then(|t| t.as_str()) {
            Some("share") => Outgoing::Share,
            Some("unshare") => Outgoing::Unshare,
            Some("leave") => Outgoing::Leave,
            Some("tracks") => match value.get("tracks").and_then(|t| t.as_array()) {
                Some(list) => Outgoing::Tracks {
                    publishes: !list.is_empty(),
                },
                None => Outgoing::Other,
            },
            _ => Outgoing::Other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "Ab3dEf7hJk";

    fn welcome() -> Welcome {
        Welcome {
            member_id: "m1".into(),
            token: "t".repeat(43),
            owner_name: "Alice".into(),
            room_name: Some("週五讀書會".into()),
            created_by: Some("Alice".into()),
        }
    }

    fn tracks(publishes: bool) -> Outgoing {
        Outgoing::Tracks { publishes }
    }

    /** Every way the page could try to publish, and whether one got out */
    fn anything_publishes(session: &Session) -> bool {
        session.may_send(&Outgoing::Share)
            || session.may_send(&tracks(true))
            || session.may_call_api(true)
    }

    fn confirming(now: u64) -> Session {
        let mut session = Session::new();
        session.start(ROOM).unwrap();
        assert!(session.on_welcome(welcome(), now));
        session
    }

    // T-01a: nothing is published after agentWelcome and before 加入
    #[test]
    fn nothing_is_published_before_the_person_confirms() {
        let mut session = Session::new();
        assert!(!anything_publishes(&session));
        session.start(ROOM).unwrap();
        assert_eq!(session.phase(), &Phase::Connecting);
        assert!(!anything_publishes(&session));
        // Not even an SFU session or TURN before the confirmation
        assert!(!session.may_call_api(false));
        assert!(session.on_welcome(welcome(), 0));
        assert_eq!(
            session.phase(),
            &Phase::Confirming {
                owner_name: "Alice".into(),
                room_name: Some("週五讀書會".into()),
                created_by: Some("Alice".into()),
            }
        );
        assert!(!anything_publishes(&session));
        assert!(!session.may_call_api(false));
        assert!(!session.may_send(&tracks(false)));
        // The share switch cannot be turned on from the confirmation
        assert_eq!(session.set_sharing(true), Err(Refusal::WrongPhase));
        assert!(!anything_publishes(&session));
    }

    // T-01a: the confirmation names who issued the code and the room (what the UI shows)
    #[test]
    fn the_confirmation_carries_the_owner_and_the_room() {
        let session = confirming(0);
        let json = serde_json::to_value(session.phase()).unwrap();
        assert_eq!(json["phase"], "confirming");
        assert_eq!(json["ownerName"], "Alice");
        assert_eq!(json["roomName"], "週五讀書會");
        // The token never reaches the page through the phase
        assert!(!json.to_string().contains(&"t".repeat(43)));
    }

    // T-01a: the share switch defaults off after 加入
    #[test]
    fn the_share_switch_starts_off() {
        let mut session = confirming(0);
        session.confirm(CONSENT_DIALOG_ARM_MS).unwrap();
        assert!(session.in_room());
        assert!(!session.sharing());
        assert!(!anything_publishes(&session));
        // In the room: an SFU session, TURN and an empty track list are fine
        assert!(session.may_call_api(false));
        assert!(session.may_send(&tracks(false)));
        session.set_sharing(true).unwrap();
        assert!(session.may_send(&Outgoing::Share));
        assert!(session.may_send(&tracks(true)));
        assert!(session.may_call_api(true));
        session.set_sharing(false).unwrap();
        assert!(!anything_publishes(&session));
        // Unsharing is always allowed
        assert!(session.may_send(&Outgoing::Unshare));
    }

    // T-01a: cancel leaves the room
    #[test]
    fn cancel_leaves() {
        let mut session = confirming(0);
        session.cancel(CONSENT_DIALOG_ARM_MS).unwrap();
        assert_eq!(session.phase(), &Phase::Idle);
        assert_eq!(session.token(), None);
        assert_eq!(session.room(), None);
        assert_eq!(session.reconnect_token(), None);
        assert!(!anything_publishes(&session));
        // And cannot be confirmed afterwards
        assert_eq!(
            session.confirm(10 * CONSENT_DIALOG_ARM_MS),
            Err(Refusal::WrongPhase)
        );
    }

    #[test]
    fn the_buttons_are_armed_after_one_second() {
        let mut session = confirming(5_000);
        assert_eq!(session.confirm(5_000), Err(Refusal::NotArmed));
        assert_eq!(session.confirm(5_999), Err(Refusal::NotArmed));
        assert_eq!(session.cancel(5_500), Err(Refusal::NotArmed));
        assert!(matches!(session.phase(), Phase::Confirming { .. }));
        // A clock that went backwards is not armed either
        assert_eq!(session.confirm(1_000), Err(Refusal::NotArmed));
        session.confirm(6_000).unwrap();
        assert!(session.in_room());
    }

    #[test]
    fn a_new_confirmation_turns_the_share_off_again() {
        let mut session = confirming(0);
        session.confirm(CONSENT_DIALOG_ARM_MS).unwrap();
        session.set_sharing(true).unwrap();
        assert!(session.leave());
        session.start(ROOM).unwrap();
        session.on_welcome(welcome(), 0);
        session.confirm(CONSENT_DIALOG_ARM_MS).unwrap();
        assert!(!session.sharing());
    }

    #[test]
    fn a_reconnect_keeps_the_phase_and_the_switch() {
        let mut session = confirming(0);
        session.confirm(CONSENT_DIALOG_ARM_MS).unwrap();
        session.set_sharing(true).unwrap();
        // The socket dropped (not for good): the token is there to come back with
        assert!(!session.on_socket_closed(false));
        assert_eq!(session.reconnect_token(), Some("t".repeat(43).as_str()));
        let again = Welcome {
            token: "u".repeat(43),
            ..welcome()
        };
        assert!(!session.on_welcome(again, 99_000));
        assert!(session.sharing());
        assert_eq!(session.token(), Some("u".repeat(43).as_str()));
    }

    #[test]
    fn a_close_before_the_welcome_is_a_failed_pairing() {
        let mut session = Session::new();
        session.start(ROOM).unwrap();
        assert_eq!(session.reconnect_token(), None);
        assert!(session.on_socket_closed(false));
        assert_eq!(session.phase(), &Phase::Idle);
    }

    #[test]
    fn a_close_for_good_ends_the_session() {
        let mut session = confirming(0);
        session.confirm(CONSENT_DIALOG_ARM_MS).unwrap();
        session.set_sharing(true).unwrap();
        assert!(session.on_socket_closed(true));
        assert_eq!(session.phase(), &Phase::Idle);
        assert_eq!(session.token(), None);
        assert!(!anything_publishes(&session));
    }

    #[test]
    fn start_only_from_idle_and_with_a_room_key() {
        let mut session = Session::new();
        assert_eq!(session.start("../x"), Err(Refusal::BadRoom));
        session.start(ROOM).unwrap();
        assert_eq!(session.start(ROOM), Err(Refusal::WrongPhase));
    }

    #[test]
    fn a_welcome_when_idle_is_ignored() {
        let mut session = Session::new();
        assert!(!session.on_welcome(welcome(), 0));
        assert_eq!(session.phase(), &Phase::Idle);
        assert_eq!(session.token(), None);
    }

    #[test]
    fn frames_from_the_page_are_sorted() {
        assert_eq!(Outgoing::classify("ping"), Outgoing::Ping);
        assert_eq!(Outgoing::classify(r#"{"t":"share"}"#), Outgoing::Share);
        assert_eq!(Outgoing::classify(r#"{"t":"unshare"}"#), Outgoing::Unshare);
        assert_eq!(Outgoing::classify(r#"{"t":"leave"}"#), Outgoing::Leave);
        assert_eq!(
            Outgoing::classify(r#"{"t":"tracks","sessionId":"s","tracks":[]}"#),
            tracks(false)
        );
        assert_eq!(
            Outgoing::classify(
                r#"{"t":"tracks","sessionId":"s","tracks":[{"trackName":"a","kind":"screen","muted":false}]}"#
            ),
            tracks(true)
        );
        // The page never writes agentHello or a control answer (T-04: no path to consent from it)
        for frame in [
            r#"{"t":"agentHello","pairing":null,"token":"x"}"#,
            r#"{"t":"controlAnswer","request":"r","decision":"allow10"}"#,
            r#"{"t":"controlMute","ms":0}"#,
            r#"{"t":"tracks"}"#,
            "not json",
        ] {
            assert_eq!(Outgoing::classify(frame), Outgoing::Other, "{frame}");
        }
        let mut session = confirming(0);
        session.confirm(CONSENT_DIALOG_ARM_MS).unwrap();
        session.set_sharing(true).unwrap();
        assert!(!session.may_send(&Outgoing::Other));
    }
}

// Remote control on the controlled computer (N3: e9-t04 consent, e9-t05 the channel; threat model
// docs/PRD/f-remote-control-security.md §5.2–§5.6). The agent's half of shared/control.ts, in Rust
// because Rust is where the agent's boundary is: the socket (socket.rs) hands every control frame
// here and nowhere else, and the page cannot send a `controlAnswer` (session.rs may_send).
//
//   Idle ──controlAsk──▶ Asking ──answer(allow*, armed)──▶ Awaiting ──controlStart (valid)──▶ Granted
//     ▲                    │ deny / controlAskEnd / ttl         │ anything else                 │
//     └────────────────────┴────────────────────────────────────┴── stop / controlEnd / expiry ─┘
//
// What it guarantees, each pinned by a test below:
// - a grant only ever follows the person's own answer in the consent dialog (T-04): `answer` is
//   the only way out of Asking, it is refused for CONSENT_DIALOG_ARM_MS after the dialog appeared
//   and after the dialog's own deadline, and nothing else in the agent answers (no setting, no
//   argument, no URL, no IPC of the main window: capabilities/consent.json grants control_answer to
//   the consent window alone);
// - the dialog closes on its own clock, never later than CONTROL_REQUEST_TTL_MS (clampAskTtl);
// - `controlStart` is accepted only for the request just allowed and with the duration the
//   person's own decision gives (validateControlStart: a room cannot turn 10 minutes into until
//   stopped), and the agent ends `allow10` on its own clock (T-05, T-12);
// - `allowUntilStop` asks again every CONTROL_RECONFIRM_MS, and no answer within
//   CONTROL_RECONFIRM_ANSWER_MS ends it (`reconfirm`); nothing is taken while it asks (§5.3);
// - a forwarded batch counts only for the live grant, within MAX_FORWARD_CHARS, every event valid,
//   in seq order (acceptSeq: a `gap` releases what is held first, `stale` and `invalid` are
//   dropped), and everything held is released after CONTROL_IDLE_RELEASE_MS without a batch, when
//   the grant ends and before any dialog (T-06, T-12).
// Injecting what a batch says is N4 (e9-t06): `on_forward` returns the events, and the held set is
// kept here already so the releases are right from the first injected key.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::{json, Value};

use crate::session::CONSENT_DIALOG_ARM_MS;

/** shared/control.ts CONTROL_REQUEST_TTL_MS */
pub const CONTROL_REQUEST_TTL_MS: u64 = 60_000;
/** shared/control.ts CONTROL_GRANT_MS.allow10 */
pub const ALLOW10_MS: u64 = 10 * 60_000;
/** shared/control.ts CONTROL_RECONFIRM_MS, CONTROL_RECONFIRM_ANSWER_MS */
pub const CONTROL_RECONFIRM_MS: u64 = 60 * 60_000;
pub const CONTROL_RECONFIRM_ANSWER_MS: u64 = 60_000;
/** shared/control.ts CONTROL_IDLE_RELEASE_MS */
pub const CONTROL_IDLE_RELEASE_MS: u64 = 1_000;
/** shared/control.ts MAX_FORWARD_CHARS (UTF-16 units there; bytes here, so never looser) */
pub const MAX_FORWARD_CHARS: usize = 8_192;
/** shared/control.ts MAX_CONTROL_BATCH, MAX_CONTROL_SEQ_GAP, MAX_TEXT_CHARS, MAX_WHEEL_DELTA */
pub const MAX_CONTROL_BATCH: usize = 30;
pub const MAX_CONTROL_SEQ_GAP: u64 = 256;
pub const MAX_TEXT_CHARS: usize = 64;
pub const MAX_WHEEL_DELTA: f64 = 1_200.0;
/** shared/control.ts CONTROL_MUTE_OPTIONS_MS */
pub const CONTROL_MUTE_OPTIONS_MS: [u64; 4] = [0, 10 * 60_000, 30 * 60_000, 60 * 60_000];

// ── Ids, decisions, seq ──────────────────────────────────────────────────────────────────────

/** shared/control.ts isControlId: 22 characters of base64url */
pub fn is_control_id(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Allow10,
    AllowUntilStop,
    Deny,
}

impl Decision {
    pub fn wire(self) -> &'static str {
        match self {
            Decision::Allow10 => "allow10",
            Decision::AllowUntilStop => "allowUntilStop",
            Decision::Deny => "deny",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow10" => Some(Decision::Allow10),
            "allowUntilStop" => Some(Decision::AllowUntilStop),
            "deny" => Some(Decision::Deny),
            _ => None,
        }
    }
}

/**
 * shared/control.ts agentGrantMs: how long the person's own decision grants. Some(None): until
 * stopped; None for a deny (no grant at all)
 */
pub fn agent_grant_ms(decision: Decision) -> Option<Option<u64>> {
    match decision {
        Decision::Allow10 => Some(Some(ALLOW10_MS)),
        Decision::AllowUntilStop => Some(None),
        Decision::Deny => None,
    }
}

/** shared/control.ts clampAskTtl: the room's ttlMs, never more than CONTROL_REQUEST_TTL_MS */
pub fn clamp_ask_ttl(value: &Value) -> Option<u64> {
    let ttl = value.as_f64()?;
    if !ttl.is_finite() || ttl <= 0.0 {
        return None;
    }
    Some((ttl.min(CONTROL_REQUEST_TTL_MS as f64)) as u64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeqVerdict {
    Next,
    Gap,
    Stale,
    Invalid,
}

/** shared/control.ts acceptSeq */
pub fn accept_seq(last: u64, seq: &Value) -> SeqVerdict {
    let Some(n) = seq.as_u64().filter(|n| *n >= 1 && *n < (1u64 << 53)) else {
        return SeqVerdict::Invalid;
    };
    if n <= last {
        SeqVerdict::Stale
    } else if n == last + 1 {
        SeqVerdict::Next
    } else if n - last <= MAX_CONTROL_SEQ_GAP {
        SeqVerdict::Gap
    } else {
        SeqVerdict::Invalid
    }
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

impl MouseButton {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "left" => Some(MouseButton::Left),
            "middle" => Some(MouseButton::Middle),
            "right" => Some(MouseButton::Right),
            _ => None,
        }
    }

    fn entry(self) -> &'static str {
        match self {
            MouseButton::Left => "button:left",
            MouseButton::Middle => "button:middle",
            MouseButton::Right => "button:right",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ControlEvent {
    Move { x: f64, y: f64 },
    Button { button: MouseButton, down: bool },
    Wheel { dx: i64, dy: i64 },
    Key { code: String, down: bool, mods: u8 },
    Text { text: String },
}

const MODIFIER_CODES: [&str; 8] = [
    "ShiftLeft",
    "ShiftRight",
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
];

const OTHER_KEY_CODES: &[&str] = &[
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadMultiply",
    "NumpadDivide",
    "NumpadDecimal",
    "NumpadEnter",
    "NumLock",
    "Backquote",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Comma",
    "Period",
    "Slash",
    "IntlBackslash",
    "IntlRo",
    "IntlYen",
    "Space",
    "Enter",
    "Tab",
    "Backspace",
    "Escape",
    "CapsLock",
    "ContextMenu",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Insert",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "PrintScreen",
    "Convert",
    "NonConvert",
    "KanaMode",
    "Lang1",
    "Lang2",
];

/** shared/control.ts CONTROL_KEY_CODES */
pub fn is_control_key_code(code: &str) -> bool {
    if code.is_empty() {
        return false;
    }
    let numbered = |prefix: &str, max: u32, min: u32| {
        code.strip_prefix(prefix)
            .and_then(|n| {
                // No leading zeros, no signs: "F01" or "Digit+1" are not codes
                if n.len() > 1 && n.starts_with('0') {
                    return None;
                }
                n.parse::<u32>().ok()
            })
            .is_some_and(|n| n >= min && n <= max)
    };
    let letter = code
        .strip_prefix("Key")
        .is_some_and(|rest| rest.len() == 1 && rest.as_bytes()[0].is_ascii_uppercase());
    letter
        || numbered("Digit", 9, 0)
        || numbered("Numpad", 9, 0)
        || numbered("F", 12, 1)
        || MODIFIER_CODES.contains(&code)
        || OTHER_KEY_CODES.contains(&code)
}

const MOD_ALL: u64 = 1 | 2 | 4 | 8;

/** shared/control.ts normalizeControlText's checks (the room already NFC-normalized it) */
fn control_text(text: &str) -> Option<String> {
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return None;
    }
    let unsafe_char = |c: char| {
        c.is_control()
            || ('\u{202A}'..='\u{202E}').contains(&c)
            || ('\u{2066}'..='\u{2069}').contains(&c)
    };
    if text.chars().any(unsafe_char) {
        return None;
    }
    Some(text.to_owned())
}

fn unit(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
}

fn wheel_delta(value: Option<&Value>) -> Option<i64> {
    let v = value?.as_f64().filter(|v| v.is_finite())?;
    Some(v.clamp(-MAX_WHEEL_DELTA, MAX_WHEEL_DELTA).round() as i64)
}

/** shared/control.ts parseControlEvent */
pub fn parse_event(value: &Value) -> Option<ControlEvent> {
    let event = value.as_object()?;
    match event.get("type")?.as_str()? {
        "move" => Some(ControlEvent::Move {
            x: unit(event.get("x"))?,
            y: unit(event.get("y"))?,
        }),
        "button" => Some(ControlEvent::Button {
            button: MouseButton::parse(event.get("button")?.as_str()?)?,
            down: event.get("down")?.as_bool()?,
        }),
        "wheel" => {
            let dx = wheel_delta(event.get("dx"))?;
            let dy = wheel_delta(event.get("dy"))?;
            if dx == 0 && dy == 0 {
                return None;
            }
            Some(ControlEvent::Wheel { dx, dy })
        }
        "key" => {
            let code = event.get("code")?.as_str()?;
            if !is_control_key_code(code) {
                return None;
            }
            let mods = event.get("mods")?.as_u64().filter(|m| m & !MOD_ALL == 0)?;
            Some(ControlEvent::Key {
                code: code.to_owned(),
                down: event.get("down")?.as_bool()?,
                mods: mods as u8,
            })
        }
        "text" => Some(ControlEvent::Text {
            text: control_text(event.get("text")?.as_str()?)?,
        }),
        _ => None,
    }
}

/** A `controlForward` that passed parseControlForward's rules */
#[derive(Clone, Debug, PartialEq)]
pub struct Forward {
    pub grant: String,
    pub seq: Value,
    pub events: Vec<ControlEvent>,
}

/** shared/control.ts parseControlForward: one bad event refuses the whole batch */
pub fn parse_forward(raw: &str) -> Option<Forward> {
    if raw.len() > MAX_FORWARD_CHARS {
        return None;
    }
    let value: Value = serde_json::from_str(raw).ok()?;
    if value.get("t")?.as_str()? != "controlForward" {
        return None;
    }
    let grant = value.get("grant")?.as_str()?;
    if !is_control_id(grant) {
        return None;
    }
    let list = value.get("events")?.as_array()?;
    if list.is_empty() || list.len() > MAX_CONTROL_BATCH {
        return None;
    }
    let events = list.iter().map(parse_event).collect::<Option<Vec<_>>>()?;
    let seq = value.get("seq")?.clone();
    if !seq.as_u64().is_some_and(|n| n >= 1) {
        return None;
    }
    Some(Forward {
        grant: grant.to_owned(),
        seq,
        events,
    })
}

/** What is held down: key codes, and `button:left` / `button:middle` / `button:right` */
pub type Held = BTreeSet<String>;

/** shared/control.ts nextHeld */
pub fn next_held(held: &mut Held, event: &ControlEvent) {
    let (entry, down) = match event {
        ControlEvent::Key { code, down, .. } => (code.as_str(), *down),
        ControlEvent::Button { button, down } => (button.entry(), *down),
        _ => return,
    };
    if down {
        held.insert(entry.to_owned());
    } else {
        held.remove(entry);
    }
}

/** shared/control.ts releaseHeld: other keys, then modifiers, then buttons */
pub fn release_held(held: &Held) -> Vec<ControlEvent> {
    let keys = held.iter().filter(|e| !e.starts_with("button:"));
    let (modifiers, others): (Vec<&String>, Vec<&String>) =
        keys.partition(|code| MODIFIER_CODES.contains(&code.as_str()));
    let mut events: Vec<ControlEvent> = others
        .into_iter()
        .chain(modifiers)
        .map(|code| ControlEvent::Key {
            code: code.clone(),
            down: false,
            mods: 0,
        })
        .collect();
    for button in [MouseButton::Left, MouseButton::Middle, MouseButton::Right] {
        if held.contains(button.entry()) {
            events.push(ControlEvent::Button {
                button,
                down: false,
            });
        }
    }
    events
}

// ── The state machine ────────────────────────────────────────────────────────────────────────

/** Why the agent stopped control (shared/control.ts AgentStopReason) */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    Button,
    Tray,
    Reconfirm,
    Quit,
}

impl StopReason {
    pub fn wire(self) -> &'static str {
        match self {
            StopReason::Button => "button",
            StopReason::Tray => "tray",
            StopReason::Reconfirm => "reconfirm",
            StopReason::Quit => "quit",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ask {
    pub request: String,
    pub from_id: String,
    pub from_name: String,
    pub room_name: Option<String>,
    pub created_by: Option<String>,
    pub shown_at: u64,
    pub deadline: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub grant: String,
    pub request: String,
    pub controller_name: String,
    pub decision: Decision,
    pub started_at: u64,
    /** On the agent's own clock; None: until stopped */
    pub ends_at: Option<u64>,
    /** The last seq accepted (acceptSeq's `last`) */
    pub last: u64,
    pub held: Held,
    pub last_batch_at: u64,
    /** When the next 「還要繼續嗎？」 is due (allowUntilStop) */
    pub reconfirm_at: Option<u64>,
    /** The hourly question is showing: since when, until when */
    pub reconfirming: Option<(u64, u64)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Asking(Ask),
    /** The person allowed `request`; waiting for the room's controlStart */
    Awaiting {
        request: String,
        decision: Decision,
        controller_name: String,
    },
    Granted(Grant),
}

/** What the windows show (the `agent://control` event, and control_state) */
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum ControlView {
    Idle,
    #[serde(rename_all = "camelCase")]
    Asking {
        request: String,
        from_name: String,
        room_name: Option<String>,
        created_by: Option<String>,
        /** ms left, and ms until the buttons work, as of `control_state` */
        left_ms: u64,
        arm_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Granted {
        controller_name: String,
        until_stopped: bool,
        left_ms: Option<u64>,
        /** The hourly question is up: ms left to answer, ms until its buttons work */
        reconfirm: Option<(u64, u64)>,
    },
}

/** What the caller does after a step: frames for the room, and whether to release held input */
#[derive(Debug, Default, PartialEq)]
pub struct Effects {
    pub send: Vec<String>,
    /** Up events to inject now (N4 injects them; N3 has injected nothing) */
    pub release: Vec<ControlEvent>,
    pub changed: bool,
}

/** Why a forwarded batch was not taken (for the log in N4; never its content) */
#[derive(Debug, PartialEq, Eq)]
pub enum Dropped {
    NotGranted,
    Malformed,
    OtherGrant,
    Paused,
    Stale,
    Invalid,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlRefusal {
    WrongPhase,
    NotArmed,
    TooLate,
    BadMute,
}

#[derive(Debug)]
pub struct Control {
    phase: Phase,
    /** Whether the agent shares its screen now: nobody controls what they cannot see */
    sharing: bool,
}

impl Default for Control {
    fn default() -> Self {
        Self::new()
    }
}

impl Control {
    pub fn new() -> Self {
        Self {
            phase: Phase::Idle,
            sharing: false,
        }
    }

    pub fn view(&self, now: u64) -> ControlView {
        match &self.phase {
            Phase::Idle | Phase::Awaiting { .. } => ControlView::Idle,
            Phase::Asking(ask) => ControlView::Asking {
                request: ask.request.clone(),
                from_name: ask.from_name.clone(),
                room_name: ask.room_name.clone(),
                created_by: ask.created_by.clone(),
                left_ms: ask.deadline.saturating_sub(now),
                arm_ms: (ask.shown_at + CONSENT_DIALOG_ARM_MS).saturating_sub(now),
            },
            Phase::Granted(grant) => ControlView::Granted {
                controller_name: grant.controller_name.clone(),
                until_stopped: grant.ends_at.is_none(),
                left_ms: grant.ends_at.map(|end| end.saturating_sub(now)),
                reconfirm: grant.reconfirming.map(|(shown, deadline)| {
                    (
                        deadline.saturating_sub(now),
                        (shown + CONSENT_DIALOG_ARM_MS).saturating_sub(now),
                    )
                }),
            },
        }
    }

    /** The consent dialog should be up: a request, or the hourly question */
    pub fn dialog(&self) -> bool {
        match &self.phase {
            Phase::Asking(_) => true,
            Phase::Granted(grant) => grant.reconfirming.is_some(),
            _ => false,
        }
    }

    /** Someone controls this computer: the red border, the 中斷 button, the tray */
    pub fn granted(&self) -> bool {
        matches!(self.phase, Phase::Granted(_))
    }

    /** The share switch (session.rs): off ends whatever is asked or granted */
    pub fn set_sharing(&mut self, on: bool) -> Effects {
        self.sharing = on;
        if on {
            return Effects::default();
        }
        self.stop_any(StopReason::Button)
    }

    /**
     * `controlAsk`. Ignored unless the agent is idle and shares its screen, the ids are well formed
     * and the ttl is a positive number; the dialog is up for at most CONTROL_REQUEST_TTL_MS. A
     * request while control is on (an honest room never sends one) is ignored too.
     */
    pub fn on_ask(&mut self, message: &Value, now: u64) -> bool {
        if !matches!(self.phase, Phase::Idle) || !self.sharing {
            return false;
        }
        let text = |name: &str| message.get(name).and_then(Value::as_str).map(str::to_owned);
        let optional = |name: &str| match message.get(name) {
            Some(Value::String(text)) => Some(Some(text.clone())),
            Some(Value::Null) | None => Some(None),
            _ => None,
        };
        let (Some(request), Some(ttl)) = (
            text("request"),
            message.get("ttlMs").and_then(clamp_ask_ttl),
        ) else {
            return false;
        };
        let from = message.get("from");
        let from_id = from.and_then(|f| f.get("id")).and_then(Value::as_str);
        let from_name = from.and_then(|f| f.get("name")).and_then(Value::as_str);
        let (Some(from_id), Some(from_name), Some(room_name), Some(created_by)) = (
            from_id,
            from_name,
            optional("roomName"),
            optional("createdBy"),
        ) else {
            return false;
        };
        if !is_control_id(&request) || from_name.trim().is_empty() {
            return false;
        }
        self.phase = Phase::Asking(Ask {
            request,
            from_id: from_id.to_owned(),
            from_name: from_name.chars().take(40).collect(),
            room_name,
            created_by,
            shown_at: now,
            deadline: now + ttl,
        });
        true
    }

    /** `controlAskEnd`: the request ended before the person answered; the dialog closes */
    pub fn on_ask_end(&mut self, request: &str) -> bool {
        match &self.phase {
            Phase::Asking(ask) if ask.request == request => {
                self.phase = Phase::Idle;
                true
            }
            Phase::Awaiting {
                request: allowed, ..
            } if allowed == request => {
                self.phase = Phase::Idle;
                true
            }
            _ => false,
        }
    }

    /**
     * The person pressed a button in the consent dialog (the only caller: lib.rs control_answer,
     * which only the consent window may invoke). Armed CONSENT_DIALOG_ARM_MS after the dialog
     * appeared, refused once its deadline passed (that is a deny already). Returns the frames for
     * the room: the answer, and with `mute_ms`, 「不再接受請求 N 分鐘」 after a deny.
     */
    pub fn answer(
        &mut self,
        request: &str,
        decision: Decision,
        mute_ms: Option<u64>,
        now: u64,
    ) -> Result<Effects, ControlRefusal> {
        if let Some(ms) = mute_ms {
            if decision != Decision::Deny || !CONTROL_MUTE_OPTIONS_MS.contains(&ms) || ms == 0 {
                return Err(ControlRefusal::BadMute);
            }
        }
        let Phase::Asking(ask) = &self.phase else {
            return Err(ControlRefusal::WrongPhase);
        };
        if ask.request != request {
            return Err(ControlRefusal::WrongPhase);
        }
        if now.saturating_sub(ask.shown_at) < CONSENT_DIALOG_ARM_MS || now < ask.shown_at {
            return Err(ControlRefusal::NotArmed);
        }
        if now >= ask.deadline {
            self.phase = Phase::Idle;
            return Err(ControlRefusal::TooLate);
        }
        let mut effects = Effects {
            changed: true,
            ..Effects::default()
        };
        effects.send.push(
            json!({ "t": "controlAnswer", "request": request, "decision": decision.wire() })
                .to_string(),
        );
        if let Some(ms) = mute_ms {
            effects
                .send
                .push(json!({ "t": "controlMute", "ms": ms }).to_string());
        }
        self.phase = match decision {
            Decision::Deny => Phase::Idle,
            _ => Phase::Awaiting {
                request: ask.request.clone(),
                decision,
                controller_name: ask.from_name.clone(),
            },
        };
        Ok(effects)
    }

    /**
     * `controlStart` (validateControlStart): only for the request just allowed, a well-formed grant
     * id, and `durationMs` exactly what the person's decision gives. Anything else is refused and
     * nothing is ever injected for it. The time limit then runs on this computer's clock.
     */
    pub fn on_start(&mut self, message: &Value, now: u64) -> bool {
        let Phase::Awaiting {
            request,
            decision,
            controller_name,
        } = &self.phase
        else {
            return false;
        };
        let Some(grant) = message.get("grant").and_then(Value::as_str) else {
            return false;
        };
        if message.get("request").and_then(Value::as_str) != Some(request.as_str())
            || !is_control_id(grant)
        {
            return false;
        }
        let Some(expected) = agent_grant_ms(*decision) else {
            return false;
        };
        let duration = match message.get("durationMs") {
            Some(Value::Null) => None,
            Some(value) => match value.as_u64() {
                Some(ms) => Some(ms),
                None => return false,
            },
            None => return false,
        };
        if duration != expected {
            return false;
        }
        let name = message
            .get("controller")
            .and_then(|c| c.get("name"))
            .and_then(Value::as_str)
            .map(|n| n.chars().take(40).collect())
            .unwrap_or_else(|| controller_name.clone());
        self.phase = Phase::Granted(Grant {
            grant: grant.to_owned(),
            request: request.clone(),
            controller_name: name,
            decision: *decision,
            started_at: now,
            ends_at: expected.map(|ms| now + ms),
            last: 0,
            held: Held::new(),
            last_batch_at: now,
            reconfirm_at: expected.is_none().then_some(now + CONTROL_RECONFIRM_MS),
            reconfirming: None,
        });
        true
    }

    /**
     * `controlForward`: the events to inject (N4), after the up events of whatever was held when
     * this batch is a `gap`. Dropped, with why, unless it is the live grant's next batch.
     */
    pub fn on_forward(
        &mut self,
        raw: &str,
        now: u64,
    ) -> Result<(Vec<ControlEvent>, Vec<ControlEvent>), Dropped> {
        let Phase::Granted(grant) = &mut self.phase else {
            return Err(Dropped::NotGranted);
        };
        let forward = parse_forward(raw).ok_or(Dropped::Malformed)?;
        if forward.grant != grant.grant {
            return Err(Dropped::OtherGrant);
        }
        if grant.reconfirming.is_some() {
            return Err(Dropped::Paused);
        }
        let release = match accept_seq(grant.last, &forward.seq) {
            SeqVerdict::Stale => return Err(Dropped::Stale),
            SeqVerdict::Invalid => return Err(Dropped::Invalid),
            SeqVerdict::Next => Vec::new(),
            SeqVerdict::Gap => {
                let ups = release_held(&grant.held);
                grant.held.clear();
                ups
            }
        };
        grant.last = forward.seq.as_u64().unwrap_or(grant.last);
        grant.last_batch_at = now;
        for event in &forward.events {
            next_held(&mut grant.held, event);
        }
        Ok((release, forward.events))
    }

    /** `controlEnd`: the room ended the grant (or a start never came); everything held is let go */
    pub fn on_end(&mut self, grant_id: &str) -> Effects {
        match &self.phase {
            Phase::Granted(grant) if grant.grant == grant_id => {
                let release = release_held(&grant.held);
                self.phase = Phase::Idle;
                Effects {
                    release,
                    changed: true,
                    ..Effects::default()
                }
            }
            _ => Effects::default(),
        }
    }

    /**
     * The person stopped it (the 中斷 button, the tray, quitting, turning the share off), or the
     * hourly question went unanswered: injection stops here first, then the room is told
     */
    pub fn stop(&mut self, reason: StopReason) -> Effects {
        let Phase::Granted(grant) = &self.phase else {
            return Effects::default();
        };
        let effects = Effects {
            send: vec![
                json!({ "t": "controlStop", "grant": grant.grant, "reason": reason.wire() })
                    .to_string(),
            ],
            release: release_held(&grant.held),
            changed: true,
        };
        self.phase = Phase::Idle;
        effects
    }

    /** Stops a grant, or closes a dialog without answering (the room counts it as no answer) */
    fn stop_any(&mut self, reason: StopReason) -> Effects {
        match &self.phase {
            Phase::Granted(_) => self.stop(reason),
            Phase::Asking(_) | Phase::Awaiting { .. } => {
                self.phase = Phase::Idle;
                Effects {
                    changed: true,
                    ..Effects::default()
                }
            }
            Phase::Idle => Effects::default(),
        }
    }

    /** 「繼續」 on the hourly question (armed like the consent buttons) */
    pub fn keep_going(&mut self, now: u64) -> Result<Effects, ControlRefusal> {
        let Phase::Granted(grant) = &mut self.phase else {
            return Err(ControlRefusal::WrongPhase);
        };
        let Some((shown, deadline)) = grant.reconfirming else {
            return Err(ControlRefusal::WrongPhase);
        };
        if now.saturating_sub(shown) < CONSENT_DIALOG_ARM_MS || now < shown {
            return Err(ControlRefusal::NotArmed);
        }
        if now >= deadline {
            return Err(ControlRefusal::TooLate);
        }
        grant.reconfirming = None;
        grant.reconfirm_at = Some(now + CONTROL_RECONFIRM_MS);
        grant.last_batch_at = now;
        Ok(Effects {
            changed: true,
            ..Effects::default()
        })
    }

    /** 「不再接受請求 N 分鐘」 from the tray or the window (0 takes requests again) */
    pub fn mute(&self, ms: u64) -> Result<String, ControlRefusal> {
        if !CONTROL_MUTE_OPTIONS_MS.contains(&ms) {
            return Err(ControlRefusal::BadMute);
        }
        Ok(json!({ "t": "controlMute", "ms": ms }).to_string())
    }

    /**
     * The clock: a dialog past its deadline closes (no answer: the room's own timer refuses it); an
     * `allow10` grant ends on time without waiting for the room; `allowUntilStop` asks again every
     * CONTROL_RECONFIRM_MS (releasing what is held first) and ends unanswered; held input is
     * released after CONTROL_IDLE_RELEASE_MS without a batch.
     */
    pub fn tick(&mut self, now: u64) -> Effects {
        match &mut self.phase {
            Phase::Asking(ask) if now >= ask.deadline => {
                self.phase = Phase::Idle;
                Effects {
                    changed: true,
                    ..Effects::default()
                }
            }
            Phase::Granted(grant) => {
                if grant.ends_at.is_some_and(|end| now >= end) {
                    // The room ends it too (`expired`); this side does not wait to stop injecting
                    let release = release_held(&grant.held);
                    self.phase = Phase::Idle;
                    return Effects {
                        release,
                        changed: true,
                        ..Effects::default()
                    };
                }
                if let Some((_, deadline)) = grant.reconfirming {
                    if now >= deadline {
                        return self.stop(StopReason::Reconfirm);
                    }
                    return Effects::default();
                }
                if grant.reconfirm_at.is_some_and(|at| now >= at) {
                    let release = release_held(&grant.held);
                    grant.held.clear();
                    grant.reconfirming = Some((now, now + CONTROL_RECONFIRM_ANSWER_MS));
                    return Effects {
                        release,
                        changed: true,
                        ..Effects::default()
                    };
                }
                if !grant.held.is_empty()
                    && now.saturating_sub(grant.last_batch_at) >= CONTROL_IDLE_RELEASE_MS
                {
                    let release = release_held(&grant.held);
                    grant.held.clear();
                    return Effects {
                        release,
                        ..Effects::default()
                    };
                }
                Effects::default()
            }
            _ => Effects::default(),
        }
    }

    /** The room socket closed: nothing goes on without the room (a reconnect does not resume) */
    pub fn on_socket_closed(&mut self) -> Effects {
        match &self.phase {
            Phase::Idle => Effects::default(),
            Phase::Granted(grant) => {
                let release = release_held(&grant.held);
                self.phase = Phase::Idle;
                Effects {
                    release,
                    changed: true,
                    ..Effects::default()
                }
            }
            _ => {
                self.phase = Phase::Idle;
                Effects {
                    changed: true,
                    ..Effects::default()
                }
            }
        }
    }

    /** For tests and the log: the live grant */
    pub fn grant(&self) -> Option<&Grant> {
        match &self.phase {
            Phase::Granted(grant) => Some(grant),
            _ => None,
        }
    }
}

/**
 * Reads a frame from the room: the control frames are for this module alone (the page never sees
 * them). Returns the `t` of a control frame, None for anything else.
 */
pub fn control_kind(value: &Value) -> Option<&str> {
    match value.get("t")?.as_str()? {
        kind @ ("controlAsk" | "controlAskEnd" | "controlStart" | "controlForward"
        | "controlEnd") => Some(kind),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "RRRRRRRRRRRRRRRRRRRRRR";
    const GRANT: &str = "GGGGGGGGGGGGGGGGGGGGGG";

    fn ask(ttl: Value) -> Value {
        json!({
            "t": "controlAsk",
            "request": REQUEST,
            "from": { "id": "m2", "name": "Bob" },
            "roomName": "週五讀書會",
            "createdBy": "Alice",
            "ttlMs": ttl,
        })
    }

    fn start(duration: Value) -> Value {
        json!({
            "t": "controlStart",
            "request": REQUEST,
            "grant": GRANT,
            "controller": { "id": "m2", "name": "Bob" },
            "durationMs": duration,
        })
    }

    fn sharing() -> Control {
        let mut control = Control::new();
        control.set_sharing(true);
        control
    }

    fn asking(at: u64) -> Control {
        let mut control = sharing();
        assert!(control.on_ask(&ask(json!(60_000)), at));
        control
    }

    fn granted(decision: Decision) -> Control {
        let mut control = asking(0);
        control
            .answer(REQUEST, decision, None, CONSENT_DIALOG_ARM_MS)
            .unwrap();
        let duration = match decision {
            Decision::Allow10 => json!(ALLOW10_MS),
            _ => Value::Null,
        };
        assert!(control.on_start(&start(duration), 2_000));
        control
    }

    fn forward(grant: &str, seq: u64, events: Value) -> String {
        json!({ "t": "controlForward", "grant": grant, "seq": seq, "events": events }).to_string()
    }

    fn key(code: &str, down: bool) -> Value {
        json!({ "type": "key", "code": code, "down": down, "mods": 0 })
    }

    // T-04: nothing but the person's answer makes a grant; the dialog is armed after one second
    #[test]
    fn only_an_armed_answer_in_time_allows() {
        let mut control = asking(5_000);
        assert_eq!(
            control.answer(REQUEST, Decision::Allow10, None, 5_000),
            Err(ControlRefusal::NotArmed)
        );
        assert_eq!(
            control.answer(REQUEST, Decision::Allow10, None, 5_999),
            Err(ControlRefusal::NotArmed)
        );
        // A clock that went backwards is not armed either
        assert_eq!(
            control.answer(REQUEST, Decision::Allow10, None, 1_000),
            Err(ControlRefusal::NotArmed)
        );
        assert_eq!(
            control.answer("XXXXXXXXXXXXXXXXXXXXXX", Decision::Allow10, None, 6_000),
            Err(ControlRefusal::WrongPhase)
        );
        // No start is taken before the answer, whatever the room says
        assert!(!control.on_start(&start(json!(ALLOW10_MS)), 6_000));
        assert!(!control.granted());
        let effects = control
            .answer(REQUEST, Decision::Allow10, None, 6_000)
            .unwrap();
        assert_eq!(
            effects.send,
            vec![
                json!({ "t": "controlAnswer", "request": REQUEST, "decision": "allow10" })
                    .to_string()
            ]
        );
        assert!(!control.granted());
        assert!(control.on_start(&start(json!(ALLOW10_MS)), 6_100));
        assert!(control.granted());
    }

    // T-04: the dialog's deadline is a deny; nothing answers for the person after it
    #[test]
    fn an_unanswered_dialog_closes_and_cannot_be_answered() {
        let mut control = asking(0);
        assert!(control.tick(59_999).send.is_empty());
        assert!(control.dialog());
        assert!(control.tick(60_000).changed);
        assert!(!control.dialog());
        assert_eq!(
            control.answer(REQUEST, Decision::Allow10, None, 60_001),
            Err(ControlRefusal::WrongPhase)
        );
        let mut late = asking(0);
        assert_eq!(
            late.answer(REQUEST, Decision::Allow10, None, 60_000),
            Err(ControlRefusal::TooLate)
        );
        assert!(!late.dialog());
    }

    // T-05: a room asking for a dialog up all day gets CONTROL_REQUEST_TTL_MS
    #[test]
    fn the_dialog_never_stays_longer_than_the_ttl() {
        let mut control = sharing();
        assert!(control.on_ask(&ask(json!(1e9)), 0));
        assert!(matches!(
            control.view(0),
            ControlView::Asking {
                left_ms: 60_000,
                ..
            }
        ));
        control.tick(60_000);
        assert!(!control.dialog());
        for bad in [json!(0), json!(-5), json!("60000"), Value::Null] {
            let mut control = sharing();
            assert!(!control.on_ask(&ask(bad), 0));
        }
        // Not sharing: nobody can control what they cannot see
        let mut hidden = Control::new();
        assert!(!hidden.on_ask(&ask(json!(60_000)), 0));
    }

    #[test]
    fn a_deny_with_a_mute_sends_both() {
        let mut control = asking(0);
        assert_eq!(
            control.answer(REQUEST, Decision::Allow10, Some(600_000), 1_000),
            Err(ControlRefusal::BadMute)
        );
        assert_eq!(
            control.answer(REQUEST, Decision::Deny, Some(5), 1_000),
            Err(ControlRefusal::BadMute)
        );
        let effects = control
            .answer(REQUEST, Decision::Deny, Some(1_800_000), 1_000)
            .unwrap();
        assert_eq!(effects.send.len(), 2);
        assert!(effects.send[1].contains("\"ms\":1800000"));
        assert!(!control.dialog());
        assert!(!control.on_start(&start(json!(ALLOW10_MS)), 1_100));
        assert_eq!(
            control.mute(0).unwrap(),
            json!({ "t": "controlMute", "ms": 0 }).to_string()
        );
        assert_eq!(control.mute(7), Err(ControlRefusal::BadMute));
    }

    // T-12: a start that does not match what the person answered is refused
    #[test]
    fn a_start_must_echo_the_decision() {
        for (decision, bad) in [
            (Decision::Allow10, Value::Null),
            (Decision::Allow10, json!(60 * 60_000)),
            (Decision::Allow10, json!("600000")),
            (Decision::AllowUntilStop, json!(ALLOW10_MS)),
        ] {
            let mut control = asking(0);
            control.answer(REQUEST, decision, None, 1_000).unwrap();
            assert!(
                !control.on_start(&start(bad.clone()), 1_100),
                "{decision:?} {bad}"
            );
            assert!(!control.granted());
        }
        let mut control = asking(0);
        control
            .answer(REQUEST, Decision::Allow10, None, 1_000)
            .unwrap();
        let mut other = start(json!(ALLOW10_MS));
        other["request"] = json!("XXXXXXXXXXXXXXXXXXXXXX");
        assert!(!control.on_start(&other, 1_100));
        let mut short = start(json!(ALLOW10_MS));
        short["grant"] = json!("short");
        assert!(!control.on_start(&short, 1_100));
        assert!(!control.granted());
    }

    // T-05: allow10 ends on this computer's clock, whatever the room keeps forwarding
    #[test]
    fn allow10_ends_on_the_agents_own_clock() {
        let mut control = granted(Decision::Allow10);
        let ends = 2_000 + ALLOW10_MS;
        assert!(control
            .on_forward(&forward(GRANT, 1, json!([key("KeyA", true)])), ends - 10)
            .is_ok());
        let effects = control.tick(ends);
        assert!(effects.changed);
        assert_eq!(
            effects.release,
            vec![ControlEvent::Key {
                code: "KeyA".into(),
                down: false,
                mods: 0
            }]
        );
        assert!(!control.granted());
        assert_eq!(
            control.on_forward(&forward(GRANT, 2, json!([key("KeyB", true)])), ends + 1),
            Err(Dropped::NotGranted)
        );
    }

    // §5.3: until stopped is asked again every hour, and ends unanswered
    #[test]
    fn until_stopped_is_asked_again_every_hour() {
        let mut control = granted(Decision::AllowUntilStop);
        let at = 2_000 + CONTROL_RECONFIRM_MS;
        control
            .on_forward(&forward(GRANT, 1, json!([key("ShiftLeft", true)])), at - 1)
            .unwrap();
        let effects = control.tick(at);
        assert!(control.dialog());
        assert_eq!(effects.release.len(), 1);
        // Nothing is taken while it asks
        assert_eq!(
            control.on_forward(&forward(GRANT, 2, json!([key("KeyA", true)])), at + 1),
            Err(Dropped::Paused)
        );
        assert_eq!(control.keep_going(at + 10), Err(ControlRefusal::NotArmed));
        control.keep_going(at + CONSENT_DIALOG_ARM_MS).unwrap();
        assert!(!control.dialog());
        assert!(control.granted());
        // The next hour, nobody answers
        let next = at + CONSENT_DIALOG_ARM_MS + CONTROL_RECONFIRM_MS;
        control.tick(next);
        assert!(control.dialog());
        let effects = control.tick(next + CONTROL_RECONFIRM_ANSWER_MS);
        assert_eq!(
            effects.send,
            vec![json!({ "t": "controlStop", "grant": GRANT, "reason": "reconfirm" }).to_string()]
        );
        assert!(!control.granted());
    }

    // T-06, T-12: the seq, the grant id and every event checked before anything counts
    #[test]
    fn forwards_are_checked_like_the_room_does() {
        let mut control = granted(Decision::Allow10);
        let ok = control
            .on_forward(&forward(GRANT, 1, json!([key("KeyA", true)])), 3_000)
            .unwrap();
        assert_eq!(ok.0, vec![]);
        assert_eq!(control.grant().unwrap().held.len(), 1);
        assert_eq!(
            control.on_forward(&forward(GRANT, 1, json!([key("KeyA", false)])), 3_001),
            Err(Dropped::Stale)
        );
        assert_eq!(
            control.on_forward(
                &forward("XXXXXXXXXXXXXXXXXXXXXX", 2, json!([key("KeyA", false)])),
                3_001
            ),
            Err(Dropped::OtherGrant)
        );
        assert_eq!(
            control.on_forward(
                &forward(GRANT, 2 + MAX_CONTROL_SEQ_GAP, json!([key("KeyA", false)])),
                3_001
            ),
            Err(Dropped::Invalid)
        );
        // A gap: what was held is released before the batch
        let (release, events) = control
            .on_forward(
                &forward(GRANT, 4, json!([{ "type": "move", "x": 0.5, "y": 0.5 }])),
                3_002,
            )
            .unwrap();
        assert_eq!(
            release,
            vec![ControlEvent::Key {
                code: "KeyA".into(),
                down: false,
                mods: 0
            }]
        );
        assert_eq!(events, vec![ControlEvent::Move { x: 0.5, y: 0.5 }]);
        // One bad event refuses the whole batch
        for bad in [
            json!([key("KeyA", true), key("Power", true)]),
            json!([{ "type": "move", "x": 1.5, "y": 0 }]),
            json!([{ "type": "text", "text": "a\u{0007}" }]),
            json!([{ "type": "text", "text": "\u{202E}abc" }]),
            json!([{ "type": "key", "code": "KeyA", "down": true, "mods": 16 }]),
            json!([{ "type": "wheel", "dx": 0, "dy": 0 }]),
            json!([]),
        ] {
            assert_eq!(
                control.on_forward(&forward(GRANT, 5, bad.clone()), 3_003),
                Err(Dropped::Malformed),
                "{bad}"
            );
        }
        let big = format!(
            "{}{}",
            forward(GRANT, 5, json!([key("KeyA", true)])),
            " ".repeat(MAX_FORWARD_CHARS)
        );
        assert_eq!(control.on_forward(&big, 3_003), Err(Dropped::Malformed));
    }

    // T-06: held input is let go after a second without a batch, and when the grant ends
    #[test]
    fn held_input_is_released() {
        let mut control = granted(Decision::Allow10);
        control
            .on_forward(
                &forward(GRANT, 1, json!([key("ControlLeft", true), key("KeyC", true), { "type": "button", "button": "left", "down": true }])),
                3_000,
            )
            .unwrap();
        assert!(control.tick(3_999).release.is_empty());
        let effects = control.tick(4_000);
        assert_eq!(
            effects.release,
            vec![
                ControlEvent::Key {
                    code: "KeyC".into(),
                    down: false,
                    mods: 0
                },
                ControlEvent::Key {
                    code: "ControlLeft".into(),
                    down: false,
                    mods: 0
                },
                ControlEvent::Button {
                    button: MouseButton::Left,
                    down: false
                },
            ]
        );
        assert!(control.grant().unwrap().held.is_empty());
        control
            .on_forward(&forward(GRANT, 2, json!([key("KeyD", true)])), 4_100)
            .unwrap();
        let effects = control.on_end(GRANT);
        assert_eq!(effects.release.len(), 1);
        assert!(!control.granted());
    }

    #[test]
    fn the_person_stops_it_and_the_room_is_told() {
        let mut control = granted(Decision::Allow10);
        let effects = control.stop(StopReason::Button);
        assert_eq!(
            effects.send,
            vec![json!({ "t": "controlStop", "grant": GRANT, "reason": "button" }).to_string()]
        );
        assert!(!control.granted());
        assert!(control.stop(StopReason::Tray).send.is_empty());
        // Turning the share off ends it too
        let mut control = granted(Decision::AllowUntilStop);
        assert_eq!(control.set_sharing(false).send.len(), 1);
        // And the socket closing ends it without a word (the room ends it as agentLeft)
        let mut control = granted(Decision::Allow10);
        assert!(control.on_socket_closed().changed);
        assert!(!control.granted());
    }

    #[test]
    fn a_request_ending_closes_the_dialog() {
        let mut control = asking(0);
        assert!(!control.on_ask_end("XXXXXXXXXXXXXXXXXXXXXX"));
        assert!(control.on_ask_end(REQUEST));
        assert!(!control.dialog());
        // A second request while one is asked or granted is ignored
        let mut control = granted(Decision::Allow10);
        assert!(!control.on_ask(&ask(json!(60_000)), 3_000));
    }

    #[test]
    fn the_rules_mirror_shared_control() {
        assert_eq!(accept_seq(0, &json!(1)), SeqVerdict::Next);
        assert_eq!(accept_seq(3, &json!(5)), SeqVerdict::Gap);
        assert_eq!(accept_seq(3, &json!(3)), SeqVerdict::Stale);
        assert_eq!(
            accept_seq(3, &json!(3 + MAX_CONTROL_SEQ_GAP + 1)),
            SeqVerdict::Invalid
        );
        assert_eq!(accept_seq(0, &json!(0)), SeqVerdict::Invalid);
        assert_eq!(accept_seq(0, &json!(1.5)), SeqVerdict::Invalid);
        assert_eq!(accept_seq(0, &json!("1")), SeqVerdict::Invalid);
        for code in [
            "KeyA",
            "KeyZ",
            "Digit0",
            "Numpad9",
            "F1",
            "F12",
            "ShiftLeft",
            "Lang2",
            "Escape",
        ] {
            assert!(is_control_key_code(code), "{code}");
        }
        for code in [
            "Keya",
            "KeyAA",
            "F0",
            "F13",
            "F01",
            "Digit10",
            "Power",
            "MediaPlayPause",
            "",
            "BrowserBack",
        ] {
            assert!(!is_control_key_code(code), "{code}");
        }
        assert_eq!(clamp_ask_ttl(&json!(30_000)), Some(30_000));
        assert_eq!(agent_grant_ms(Decision::Deny), None);
        assert!(is_control_id(GRANT));
        assert!(!is_control_id("GGGG"));
        assert!(!is_control_id("GGGGGGGGGGGGGGGGGGGGG/"));
        assert_eq!(
            control_kind(&json!({ "t": "controlForward" })),
            Some("controlForward")
        );
        assert_eq!(control_kind(&json!({ "t": "patch" })), None);
    }
}

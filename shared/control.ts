// Remote control (E9, N1 e9-t01; AC-9.4): the messages between a controller's browser, the room
// (RoomDO) and the desktop agent on the controlled computer, their limits, and the pure parsers and
// helpers all three share. The threat model and every decision behind these shapes is
// docs/PRD/f-remote-control-security.md; read it before changing anything here.
//
// NOT WIRED YET. Nothing imports this file in N1, and none of it is part of PROTOCOL_VERSION
// (shared/protocol.ts, 23 today). Where it plugs in:
// - N2 (e9-t02): the agent connects on its own socket, GET /api/rooms/<roomId>/agent?v=
//   AGENT_PROTOCOL_VERSION, never the browsers' /ws: the room tags each socket as `browser` or
//   `agent` at the upgrade and accepts agent messages (parseAgentMessage) only on agent sockets and
//   browser messages only on browser sockets. The agent's first message is `agentHello` with a
//   one-time pairing code a member in the room asked for; the room answers `agentWelcome`. The agent
//   is a member of its own (`Member.agent`, shown as 「<owner> 的電腦」 from strings.ts) that
//   publishes its screen through the same SFU proxy with its own session token.
// - N3 (e9-t04, e9-t05): protocol.ts bumps 23 → 24: ClientMessage gains ControlClientMessage
//   (parseClientMessage's switch calls parseControlClientMessage for the four `control*` kinds),
//   ServerMessage gains ControllerServerMessage, RoomView gains `control?: ControlView | null`,
//   ErrorCode gains ControlErrorCode, and shared/roles.ts gains `stopControl` (STAFF on 'member')
//   next to `requestControl`. SOCKET_MESSAGE_RATE (shared/abuse.ts: 120 messages / 10 s, a twelfth
//   of what control sends) exempts a frame only when exemptFromSocketRate says so: a parsed
//   `controlEvent` whose grant id is the live grant this very socket holds. Everything else, junk
//   and `controlEvent`s from sockets without a grant included, still counts (4420). RoomHost counts
//   frames before parsing them today, so N3 has to parse first and count after. The grant's socket
//   is held to CONTROL_FRAME_RATE instead, its events to takeControlEvents. The room keeps requests
//   and grants (worker/room-control.ts) and ends a grant on every rule in the threat model's
//   revocation list.
// - N4 (e9-t06, e9-t07): the agent (Rust) mirrors parseControlForward, acceptSeq, nextHeld,
//   releaseHeld, classifyKeyCombo, clampAskTtl and validateControlStart;
//   tests/shared/control.test.ts is the spec both sides follow.
//
// The flow:
// 1. A member asks: `controlRequest` naming an agent in the same room (and the same breakout room).
//    The room creates a request (random id, CONTROL_REQUEST_TTL_MS), shows it to everyone in
//    `RoomView.control` and sends the agent `controlAsk`. One request or grant per agent at a time.
// 2. The person at the controlled computer answers in a system-level dialog: `controlAnswer` with
//    `allow10`, `allowUntilStop` or `deny`. No answer within the TTL is a deny. Nothing else can
//    answer: the room takes `controlAnswer` only from that agent's own socket.
// 3. On allow the room creates a grant (another random id) bound to the controller's socket (not
//    its token: a reconnect, or a stolen token joining from elsewhere, ends the grant) and sends the
//    controller `controlGranted` and the agent `controlStart`.
// 4. The controller sends `controlEvent` batches (grant id, seq, events). The room forwards a batch
//    to the agent as `controlForward` only when it comes from the socket holding that grant, its seq
//    passes acceptSeq, it fits takeControlEvents and the grant has not ended. A batch over the rate
//    is not dropped whole: its up events still go (upEventsOnly), so nothing stays held. The agent
//    checks the grant id and seq again before injecting, and releases everything held after
//    CONTROL_IDLE_RELEASE_MS without a batch.
// 5. Either side, the host, a timer or a rule (leaving, a breakout move, the meeting ending…) ends
//    it: `controlEnd` with the reason to both, and `RoomView.control` loses the entry.

// ── Limits ───────────────────────────────────────────────────────────────────────────────────

/** The agent socket's own version (?v= on /api/rooms/<id>/agent), separate from PROTOCOL_VERSION */
export const AGENT_PROTOCOL_VERSION = 1

/** A request nobody answered is a deny after this long (AC-9.2) */
export const CONTROL_REQUEST_TTL_MS = 60_000

/** How long each answer grants control; null: until someone stops it */
export const CONTROL_GRANT_MS = {
  allow10: 10 * 60_000,
  allowUntilStop: null,
} as const

/**
 * An `allowUntilStop` grant is asked again in the agent's dialog this often; no answer within
 * CONTROL_RECONFIRM_ANSWER_MS ends it (nobody at the computer is not consent: no unattended access)
 */
export const CONTROL_RECONFIRM_MS = 60 * 60_000
export const CONTROL_RECONFIRM_ANSWER_MS = 60_000

/**
 * The agent's consent dialog ignores clicks and keys for this long after it appears, so a click
 * or Enter meant for something else cannot answer it (and its default button is 拒絕)
 */
export const CONSENT_DIALOG_ARM_MS = 1_000

/** Events the room forwards per grant: at most `count` in any `windowMs` (AC-9.4) */
export const CONTROL_EVENT_RATE = { count: 120, windowMs: 1_000 } as const

/**
 * `controlEvent` frames the grant's own socket may send (it is out of SOCKET_MESSAGE_RATE, so this
 * is its ceiling): past it the socket is closed with CloseCode.rateLimited, which ends the grant.
 * Twice the browser's cadence (CONTROL_BATCH_MS) plus the immediate key and click flushes.
 */
export const CONTROL_FRAME_RATE = { count: 60, windowMs: 1_000 } as const

/**
 * During a grant, the agent releases every key and button it holds when no batch has come for this
 * long (a lost key up, a controller that froze). A controller holding something on purpose (a
 * drag, Shift) repeats its last `move` every CONTROL_HOLD_KEEPALIVE_MS so the hold survives.
 */
export const CONTROL_IDLE_RELEASE_MS = 1_000
export const CONTROL_HOLD_KEEPALIVE_MS = 400

/** Events in one `controlEvent` */
export const MAX_CONTROL_BATCH = 30

/** How often the controller's browser sends what it has (about two frames at 60 Hz) */
export const CONTROL_BATCH_MS = 33

/**
 * How far one batch's seq may jump past the last one accepted. Over one WebSocket nothing is lost
 * in transit, so a gap is only batches the room dropped (rate, size); a huge jump is a bug or an
 * attack and would leave the grant unusable, so it is refused instead
 */
export const MAX_CONTROL_SEQ_GAP = 256

/** A `text` event's length in characters (code points), after normalizeControlText */
export const MAX_TEXT_CHARS = 64

/** A `wheel` event's delta in CSS pixels, each way; larger ones are clamped, not refused */
export const MAX_WHEEL_DELTA = 1_200

/** Requests one member may make in any window (a refused or expired one counts too) */
export const CONTROL_REQUEST_RATE = { count: 3, windowMs: 60_000 } as const

/** After a deny (or no answer) the same member cannot ask the same agent again for this long */
export const CONTROL_DENY_COOLDOWN_MS = 30_000

/**
 * Per agent, whoever asks (rejoining or a second tab makes a new member, so the per-member limits
 * alone do not stop a request bomb): this many denies (or unanswered requests) in the window mute
 * every request to that agent for CONTROL_AGENT_MUTE_MS
 */
export const CONTROL_AGENT_DENY_LIMIT = { count: 3, windowMs: 5 * 60_000 } as const
export const CONTROL_AGENT_MUTE_MS = 10 * 60_000

/** What 「不再接受請求 N 分鐘」 offers in the dialog and the tray (`controlMute`; 0 lifts it) */
export const CONTROL_MUTE_OPTIONS_MS: readonly number[] = [0, 10 * 60_000, 30 * 60_000, 60 * 60_000]

/** Escape pressed this many times within ESCAPE_STOP_MS on the controlled computer stops control */
export const ESCAPE_STOP_PRESSES = 3
export const ESCAPE_STOP_MS = 1_000

/** A pairing code works once, within this long of being issued */
export const PAIRING_CODE_TTL_MS = 5 * 60_000
/** Characters in a pairing code (Crockford base32: 40 bits) */
export const PAIRING_CODE_LENGTH = 8
/**
 * Wrong pairing codes. Every wrong code closes its socket at once (one guess per WebSocket upgrade,
 * which ROOM_CONNECT_RATE already limits per network); one network gets PAIRING_NETWORK_FAIL_RATE
 * before the room refuses its pairing for the rest of the window; only PAIRING_ROOM_MAX_FAILS from
 * everyone together within PAIRING_CODE_TTL_MS cancel the open codes (their issuers are told and can
 * ask again). So one person guessing cannot stop the room from pairing, and 40 bits against at most
 * PAIRING_ROOM_MAX_FAILS guesses per code is about 5 × 10⁻¹¹.
 */
export const PAIRING_NETWORK_FAIL_RATE = { count: 5, windowMs: 10 * 60_000 } as const
export const PAIRING_ROOM_MAX_FAILS = 50

/** The agent's device name in `agentHello`, in characters after normalizeLabel */
export const MAX_DEVICE_CHARS = 40

/** Largest frame the room reads on an agent socket (agent → room: small messages only) */
export const MAX_AGENT_MESSAGE_CHARS = 4_096

/**
 * Largest frame the agent reads from the room (room → agent). Every batch parseControlEvents
 * accepts fits: the worst is MAX_CONTROL_BATCH `text` events of MAX_TEXT_CHARS characters that JSON
 * writes as two units each (astral characters, `"` and `\`), about 4.7 k; the test builds it.
 */
export const MAX_FORWARD_CHARS = 8_192

// ── Events ───────────────────────────────────────────────────────────────────────────────────

export type MouseButton = 'left' | 'middle' | 'right'

export const MOUSE_BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right']

/**
 * Modifier bits on a `key` event: what the controller says it held. Never trusted alone: the agent
 * judges a key with these OR the modifier keys it holds itself (classifyKeyCombo), and before a key
 * down presses any modifier in `mods` it does not hold yet, so what it judged is what the OS sees.
 */
export const MOD_SHIFT = 1
export const MOD_CTRL = 2
export const MOD_ALT = 4
/** Windows key on Windows, ⌘ on macOS, Super on Linux */
export const MOD_META = 8
const MOD_ALL = MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_META

/**
 * One input event. Coordinates are normalized to the shared screen (0–1 of its width and height,
 * shared/shareGeometry.ts content space), never pixels, so the controller's tile size and the
 * agent's display scaling do not matter. Buttons act at the last `move`.
 */
export type ControlEvent =
  | { type: 'move'; x: number; y: number }
  | { type: 'button'; button: MouseButton; down: boolean }
  | { type: 'wheel'; dx: number; dy: number }
  /** A physical key (KeyboardEvent.code, CONTROL_KEY_CODES), with the modifiers held */
  | { type: 'key'; code: string; down: boolean; mods: number }
  /** Text committed by an input method (注音、倉頡、拼音…) or a dead-key sequence */
  | { type: 'text'; text: string }

function codesFrom(prefix: string, from: number, to: number): string[] {
  const codes: string[] = []
  for (let i = from; i <= to; i += 1) codes.push(`${prefix}${i}`)
  return codes
}

/**
 * The KeyboardEvent.code values the agent will press. Anything else (power, sleep, media and
 * browser keys, F13+, unknown codes) is refused with the whole batch.
 */
export const CONTROL_KEY_CODES: ReadonlySet<string> = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `Key${letter}`),
  ...codesFrom('Digit', 0, 9),
  ...codesFrom('Numpad', 0, 9),
  ...codesFrom('F', 1, 12),
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'NumpadEnter',
  'NumLock',
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'IntlRo',
  'IntlYen',
  'Space',
  'Enter',
  'Tab',
  'Backspace',
  'Escape',
  'CapsLock',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'ContextMenu',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Insert',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'PrintScreen',
  // Input-method keys on Japanese and Korean keyboards
  'Convert',
  'NonConvert',
  'KanaMode',
  'Lang1',
  'Lang2',
])

export const isControlKeyCode = (value: unknown): value is string =>
  typeof value === 'string' && CONTROL_KEY_CODES.has(value)

export type AgentPlatform = 'windows' | 'macos' | 'linux'

export const AGENT_PLATFORMS: readonly AgentPlatform[] = ['windows', 'macos', 'linux']

/**
 * What the agent does with a key going down with these modifiers (only the non-modifier key is
 * judged; a key coming up always goes through, so nothing stays held):
 * - `block`: not pressed, the person at the computer is told (a combination the OS keeps for
 *   itself, or one that would take the computer away from both people);
 * - `warn`: pressed, and the person at the computer is told who pressed what (it opens something
 *   powerful: Run, Task Manager, Force Quit, locking the screen — which also ends the grant);
 * - `allow`: pressed.
 */
export type KeyVerdict = 'allow' | 'warn' | 'block'

const MODIFIER_BITS: Readonly<Record<string, number>> = {
  ShiftLeft: MOD_SHIFT,
  ShiftRight: MOD_SHIFT,
  ControlLeft: MOD_CTRL,
  ControlRight: MOD_CTRL,
  AltLeft: MOD_ALT,
  AltRight: MOD_ALT,
  MetaLeft: MOD_META,
  MetaRight: MOD_META,
}

/** The modifier bits of the modifier keys in `held` (nextHeld's set) */
export function modsOfHeld(held: HeldInput): number {
  let mods = 0
  for (const entry of held) mods |= MODIFIER_BITS[entry] ?? 0
  return mods
}

/**
 * `held` is what the agent has pressed and not released (nextHeld), BEFORE this key; `mods` is the
 * event's own. The verdict uses both together, because the OS sees the held keys whatever `mods`
 * says: ControlLeft down, AltLeft down, then Delete with mods 0 is still Ctrl+Alt+Del.
 */
export function classifyKeyCombo(
  code: string,
  held: HeldInput,
  mods: number,
  platform: AgentPlatform,
): KeyVerdict {
  const all = mods | modsOfHeld(held)
  const ctrl = (all & MOD_CTRL) !== 0
  const alt = (all & MOD_ALT) !== 0
  const shift = (all & MOD_SHIFT) !== 0
  const meta = (all & MOD_META) !== 0
  if (platform === 'windows' || platform === 'linux') {
    // The secure attention sequence: Windows never takes it injected anyway (only SendSAS from a
    // service), and on Linux it may reboot
    if (ctrl && alt && code === 'Delete') return 'block'
  }
  if (platform === 'linux') {
    // Kills the X server; switches to a text console the agent cannot see
    if (ctrl && alt && code === 'Backspace') return 'block'
    if (ctrl && alt && /^F([1-9]|1[0-2])$/.test(code)) return 'block'
    // Magic SysRq (Alt+PrintScreen+<key>): reboot, kill every process, remount read-only
    if (alt && code === 'PrintScreen') return 'block'
  }
  if (platform === 'windows') {
    if (meta && (code === 'KeyR' || code === 'KeyX' || code === 'KeyL')) return 'warn'
    if (ctrl && shift && code === 'Escape') return 'warn'
  }
  if (platform === 'macos') {
    // Force Quit; lock screen; log out
    if (meta && alt && code === 'Escape') return 'warn'
    if (ctrl && meta && code === 'KeyQ') return 'warn'
    if (meta && shift && code === 'KeyQ') return 'warn'
  }
  return 'allow'
}

// Control characters (Enter and Tab go as keys) and the bidirectional overrides
const UNSAFE_TEXT_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u
// A surrogate without its other half: not text, and some input APIs choke on it
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * A `text` event's text as the agent types it: NFC-normalized; null when empty, longer than
 * MAX_TEXT_CHARS, or carrying a control character, a bidi override or a lone surrogate. Refused,
 * not cleaned: typing something other than what was sent is worse than typing nothing.
 */
export function normalizeControlText(raw: unknown): string | null {
  if (typeof raw !== 'string' || LONE_SURROGATE.test(raw)) return null
  const text = raw.normalize('NFC')
  if (text === '' || UNSAFE_TEXT_CHARS.test(text) || [...text].length > MAX_TEXT_CHARS) return null
  return text
}

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

function wheelDelta(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, value)))
}

/** One event, normalized; null when it is not one this version knows or any field does not fit */
export function parseControlEvent(value: unknown): ControlEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  switch (event.type) {
    case 'move':
      return isUnit(event.x) && isUnit(event.y) ? { type: 'move', x: event.x, y: event.y } : null
    case 'button':
      if (!MOUSE_BUTTONS.includes(event.button as MouseButton)) return null
      if (typeof event.down !== 'boolean') return null
      return { type: 'button', button: event.button as MouseButton, down: event.down }
    case 'wheel': {
      const dx = wheelDelta(event.dx)
      const dy = wheelDelta(event.dy)
      if (dx === null || dy === null || (dx === 0 && dy === 0)) return null
      return { type: 'wheel', dx, dy }
    }
    case 'key': {
      const { code, down, mods } = event
      if (!isControlKeyCode(code) || typeof down !== 'boolean') return null
      if (!Number.isInteger(mods) || (mods as number) < 0 || ((mods as number) & ~MOD_ALL) !== 0) {
        return null
      }
      return { type: 'key', code, down, mods: mods as number }
    }
    case 'text': {
      const text = normalizeControlText(event.text)
      return text === null ? null : { type: 'text', text }
    }
    default:
      return null
  }
}

/**
 * A batch's events: 1 to MAX_CONTROL_BATCH, every one valid. One bad event refuses the whole batch
 * (never half of it: a key down without its key up is how keys get stuck).
 */
export function parseControlEvents(value: unknown): ControlEvent[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTROL_BATCH) return null
  const events: ControlEvent[] = []
  for (const raw of value as unknown[]) {
    const event = parseControlEvent(raw)
    if (event === null) return null
    events.push(event)
  }
  return events
}

/**
 * Runs of `move` merged into their last one (what the controller's browser does before sending: a
 * pointer path the agent would replay at 120 events a second is just latency). Moves on either
 * side of a button or key stay apart, so a drag still starts and ends where it did.
 */
export function coalesceMoves(events: readonly ControlEvent[]): ControlEvent[] {
  const result: ControlEvent[] = []
  for (const event of events) {
    if (event.type === 'move' && result.at(-1)?.type === 'move') result[result.length - 1] = event
    else result.push(event)
  }
  return result
}

/**
 * What is held down: key codes, and `button:left` / `button:middle` / `button:right`. The agent
 * keeps one per grant (what it injected), and so does the controller's browser.
 */
export type HeldInput = ReadonlySet<string>

const buttonEntry = (button: MouseButton): string => `button:${button}`

/** `held` after `event` (a new set; events that press or release nothing return the same one) */
export function nextHeld(held: HeldInput, event: ControlEvent): HeldInput {
  let entry: string
  if (event.type === 'key') entry = event.code
  else if (event.type === 'button') entry = buttonEntry(event.button)
  else return held
  if (event.down === held.has(entry)) return held
  const next = new Set(held)
  if (event.down) next.add(entry)
  else next.delete(entry)
  return next
}

/**
 * The up events that release everything in `held`: keys first (other keys before modifiers, so no
 * shortcut fires on the way), then buttons. The agent injects them when a grant ends, on a `gap`,
 * after CONTROL_IDLE_RELEASE_MS without a batch, and when it pauses for a dialog.
 */
export function releaseHeld(held: HeldInput): ControlEvent[] {
  const keys = [...held].filter((entry) => !entry.startsWith('button:'))
  const ordered = [
    ...keys.filter((code) => !(code in MODIFIER_BITS)),
    ...keys.filter((code) => code in MODIFIER_BITS),
  ]
  const events: ControlEvent[] = ordered.map((code) => ({
    type: 'key',
    code,
    down: false,
    mods: 0,
  }))
  for (const button of MOUSE_BUTTONS) {
    if (held.has(buttonEntry(button))) events.push({ type: 'button', button, down: false })
  }
  return events
}

/**
 * The key and button up events of a batch, in order: what the room still forwards from a batch over
 * the rate (an up only ever releases; the agent ignores one for something it does not hold)
 */
export function upEventsOnly(events: readonly ControlEvent[]): ControlEvent[] {
  return events.filter((event) => (event.type === 'key' || event.type === 'button') && !event.down)
}

// ── Sequence and rate ────────────────────────────────────────────────────────────────────────

/**
 * What to do with a batch numbered `seq` when the last one accepted on this grant was `last`
 * (0 before the first; seqs start at 1 and the controller adds 1 per batch):
 * - `next`: seq is last + 1: apply it;
 * - `gap`: seq is ahead by 2 to MAX_CONTROL_SEQ_GAP: batches in between were dropped (by the room's
 *   rate limit). Apply it, but release every key and button held first, since a key up may have
 *   been in what was lost;
 * - `stale`: seq is last or older: a replay or a reordered batch. Drop it (never reorder input);
 * - `invalid`: not a positive safe integer, or too far ahead. Drop it.
 * After `next` or `gap` the caller stores seq as the new last; nothing else moves it. In the room
 * `last` is the last seq it FORWARDED: a batch it drops (over the rate with no up events in it)
 * does not move it, so the next one forwarded is a `gap` and the agent releases what it holds.
 * When drops go on long enough that the controller's seq runs past MAX_CONTROL_SEQ_GAP, every batch
 * is `invalid`: the room then ends the grant (`desynced`) instead of leaving it stuck, and the
 * controller asks again. A forwarded batch cut down to its up events keeps its seq.
 */
export type SeqVerdict = 'next' | 'gap' | 'stale' | 'invalid'

export function acceptSeq(last: number, seq: unknown): SeqVerdict {
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) return 'invalid'
  const n = seq as number
  if (n <= last) return 'stale'
  if (n === last + 1) return 'next'
  return n - last <= MAX_CONTROL_SEQ_GAP ? 'gap' : 'invalid'
}

/** What the room remembers of one grant's recent batches: when, and how many events */
export type EventWindow = readonly { at: number; count: number }[]

/**
 * Whether `count` more events fit CONTROL_EVENT_RATE at `now` (at most `rate.count` in any
 * `rate.windowMs`); when they fit they are counted. A batch that does not fit is dropped whole.
 * `window` is oldest first and comes back trimmed.
 */
export function takeControlEvents(
  window: EventWindow,
  count: number,
  now: number,
  rate: { count: number; windowMs: number } = CONTROL_EVENT_RATE,
): { ok: boolean; window: EventWindow } {
  const recent = window.filter((entry) => now - entry.at < rate.windowMs)
  const used = recent.reduce((sum, entry) => sum + entry.count, 0)
  if (count < 1 || used + count > rate.count) return { ok: false, window: recent }
  return { ok: true, window: [...recent, { at: now, count }] }
}

/**
 * Whether a frame the room parsed stays out of SOCKET_MESSAGE_RATE: only a `controlEvent` naming
 * `liveGrant`, the grant this socket holds now (null: none). Anything else counts, so a socket with
 * no grant cannot flood the room by labelling junk `controlEvent`.
 */
export function exemptFromSocketRate(
  message: ControlClientMessage | null,
  liveGrant: string | null,
): boolean {
  return message?.t === 'controlEvent' && liveGrant !== null && message.grant === liveGrant
}

// ── Ids and pairing ──────────────────────────────────────────────────────────────────────────

/** Request and grant ids: 16 random bytes, base64url without padding */
const CONTROL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export const isControlId = (value: unknown): value is string =>
  typeof value === 'string' && CONTROL_ID_PATTERN.test(value)

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A new request or grant id (crypto.getRandomValues, in the Worker) */
export function newControlId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

// The same shapes as protocol.ts' member ids and session tokens, kept here so this file imports no
// values from protocol.ts (protocol.ts will import this file's values in N3)
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const isMemberId = (value: unknown): value is string =>
  typeof value === 'string' && MEMBER_ID_PATTERN.test(value)
const AGENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const isAgentToken = (value: unknown): value is string =>
  typeof value === 'string' && AGENT_TOKEN_PATTERN.test(value)

/** Crockford base32: no I, L, O, U, so what is read aloud or copied by hand survives */
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A new pairing code (32 symbols: a byte's low five bits are unbiased) */
export function newPairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let code = ''
  for (const byte of bytes) code += PAIRING_ALPHABET[byte & 31]
  return code
}

/** How a pairing code is shown: two groups of four, 「7K3M-Q9TD」 */
export const formatPairingCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

/**
 * A pairing code as typed (any case, with spaces or a hyphen, O for 0, I or L for 1) in its stored
 * form; null when it cannot be one
 */
export function normalizePairingCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null
  const code = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (code.length !== PAIRING_CODE_LENGTH) return null
  for (const char of code) if (!PAIRING_ALPHABET.includes(char)) return null
  return code
}

// Control characters and bidi overrides, as protocol.ts normalizeName removes them
const UNSAFE_LABEL_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu

/** A device name as the room keeps it (normalizeName's rules); null when empty or too long */
export function normalizeLabel(raw: unknown, maxChars: number = MAX_DEVICE_CHARS): string | null {
  if (typeof raw !== 'string') return null
  const label = raw.replace(UNSAFE_LABEL_CHARS, '').replace(/\s+/g, ' ').trim()
  if (label === '' || [...label].length > maxChars) return null
  return label
}

// ── Answers, grants and endings ──────────────────────────────────────────────────────────────

export type ControlDecision = 'allow10' | 'allowUntilStop' | 'deny'

export const CONTROL_DECISIONS: readonly ControlDecision[] = ['allow10', 'allowUntilStop', 'deny']

/**
 * How long a grant lasts, from the agent's own decision (never from what the room says); null:
 * until stopped
 */
export const agentGrantMs = (decision: Exclude<ControlDecision, 'deny'>): number | null =>
  CONTROL_GRANT_MS[decision]

/**
 * The agent's check of `controlStart` against what it answered: the request it allowed (`answered`,
 * null when it allowed nothing), and the duration its own decision gives. A start for another
 * request, after a deny, or with any other duration (a room trying `null` for an `allow10`) is
 * refused and logged; the agent then injects nothing for that grant.
 */
export function validateControlStart(
  start: ControlStartMessage,
  answered: { request: string; decision: ControlDecision } | null,
): boolean {
  if (answered === null || answered.decision === 'deny') return false
  if (start.request !== answered.request || !isControlId(start.grant)) return false
  return start.durationMs === agentGrantMs(answered.decision)
}

/**
 * How long the agent keeps a `controlAsk` dialog open: the room's `ttlMs`, never more than
 * CONTROL_REQUEST_TTL_MS (a room asking for 10⁹ ms would leave the question up all day); null for
 * a value that is not a positive finite number (the ask is ignored)
 */
export function clampAskTtl(ttlMs: unknown): number | null {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return null
  return Math.min(ttlMs, CONTROL_REQUEST_TTL_MS)
}

/** When a grant made at `now` with `decision` ends (the server's clock); null: until stopped */
export function grantUntil(decision: Exclude<ControlDecision, 'deny'>, now: number): number | null {
  const ms = CONTROL_GRANT_MS[decision]
  return ms === null ? null : now + ms
}

/** Why the agent stopped control: what the person at the controlled computer did, or saw */
export type AgentStopReason =
  /** The floating 中斷 button on the red border */
  | 'button'
  /** Escape ESCAPE_STOP_PRESSES times within ESCAPE_STOP_MS, on the physical keyboard */
  | 'escape'
  /** 中斷 in the tray menu */
  | 'tray'
  /**
   * The session locked or the screen saver started. (The secure desktop of a UAC prompt only
   * pauses injection, which Windows refuses there anyway: the person at the computer answers it.)
   */
  | 'locked'
  /** An `allowUntilStop` grant's hourly question was declined or not answered */
  | 'reconfirm'
  /** The agent is quitting or leaving the room */
  | 'quit'

export const AGENT_STOP_REASONS: readonly AgentStopReason[] = [
  'button',
  'escape',
  'tray',
  'locked',
  'reconfirm',
  'quit',
]

/** Why a grant ended, as both sides and everyone's notice say */
export type ControlEndReason =
  | 'expired'
  | 'controllerStopped'
  /** The person at the controlled computer stopped it (AgentStopReason says how, in the agent log) */
  | 'agentStopped'
  /** The controller's socket closed (left, removed, reconnecting: a reconnect does not resume) */
  | 'controllerLeft'
  | 'agentLeft'
  /** A host or co-host stopped it (`host` `stopControl`, N3) */
  | 'hostStopped'
  /** A breakout move put the two in different rooms (control stays within one room, L3) */
  | 'separated'
  | 'meetingEnded'
  /** The host turned remote control off for the room (`RoomInfo.allowControl`, Q4) */
  | 'controlOff'
  /** The controller's seq ran past MAX_CONTROL_SEQ_GAP of what was forwarded (acceptSeq) */
  | 'desynced'

/** Why a request ended without a grant */
export type ControlRequestEndReason =
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'requesterLeft'
  | 'agentLeft'
  | 'separated'
  | 'meetingEnded'
  | 'controlOff'
  /** The person at the computer chose 「不再接受請求 N 分鐘」 (`controlMute`) */
  | 'muted'

/** The errors control adds to protocol.ts ErrorCode in N3 */
export type ControlErrorCode =
  /** The agent has a request or grant already, or the requester controls or asks elsewhere */
  | 'control_busy'
  /** The target is not an agent in the room */
  | 'control_not_agent'
  /** The target is in another breakout room */
  | 'control_separated'
  /** Over CONTROL_REQUEST_RATE, or within CONTROL_DENY_COOLDOWN_MS of that agent's deny */
  | 'control_cooldown'
  /** The agent takes no requests now (`controlMute`, or CONTROL_AGENT_DENY_LIMIT reached) */
  | 'control_muted'
  /** Remote control is off in this room (`RoomInfo.allowControl`, Q4) */
  | 'control_off'

// ── RoomView (N3: `RoomView.control`) ────────────────────────────────────────────────────────

/**
 * One agent's request or grant, as everyone in the room sees it. Ids stay out of the view: only
 * the controller learns its grant id (`controlGranted`), only the agent its request id.
 */
export type ControlSession = {
  /** The agent's member id */
  agent: string
  /** Who asks, or controls */
  controller: string
  phase: 'asking' | 'granted'
  /** When it was asked, or granted (the server's clock) */
  since: number
  /** asking: when the request expires; granted: when the grant ends (null: until stopped) */
  until: number | null
}

/** Requests and grants by agent member id (one each at most) */
export type ControlView = Record<string, ControlSession>

// ── Controller's browser → room (N3: part of ClientMessage) ──────────────────────────────────

/** Ask to control an agent (worker/roles.ts `requestControl`) */
export type ControlRequestMessage = { t: 'controlRequest'; agent: string }
/** Withdraw one's own request before it is answered */
export type ControlCancelMessage = { t: 'controlCancel'; request: string }
/** A batch of input for the grant the sender holds */
export type ControlEventMessage = {
  t: 'controlEvent'
  grant: string
  seq: number
  events: ControlEvent[]
}
/** The controller ends its own grant */
export type ControlStopMessage = { t: 'controlStop'; grant: string }

export type ControlClientMessage =
  ControlRequestMessage | ControlCancelMessage | ControlEventMessage | ControlStopMessage

// ── Room → controller's browser (N3: part of ServerMessage) ──────────────────────────────────

/** The request was made: its id, for `controlCancel` */
export type ControlRequestedMessage = { t: 'controlRequested'; request: string; agent: string }
/** The request ended without a grant */
export type ControlRefusedMessage = {
  t: 'controlRefused'
  request: string
  reason: ControlRequestEndReason
}
/** The agent allowed it: the grant id to put on every batch, and when it ends (null: until stopped) */
export type ControlGrantedMessage = {
  t: 'controlGranted'
  grant: string
  agent: string
  until: number | null
}
/** The grant ended (also sent to the agent) */
export type ControlEndMessage = { t: 'controlEnd'; grant: string; reason: ControlEndReason }

export type ControllerServerMessage =
  ControlRequestedMessage | ControlRefusedMessage | ControlGrantedMessage | ControlEndMessage

// ── Agent → room (its own socket) ────────────────────────────────────────────────────────────

/**
 * The agent's first message. A new agent brings a pairing code (normalizePairingCode) a member in
 * the room asked for, and becomes that member's computer; a reconnecting one brings the token from
 * its `agentWelcome` instead (kept in memory only: a restarted agent pairs again).
 */
export type AgentHelloMessage = {
  t: 'agentHello'
  pairing: string | null
  token: string | null
  /** The computer's name, shown to the room under 「<owner> 的電腦」 */
  device: string
  platform: AgentPlatform
  /** The agent's own version, for the log and to refuse a known-bad build */
  build: string
}
/** The person at the computer answered a request in the system dialog */
export type ControlAnswerMessage = {
  t: 'controlAnswer'
  request: string
  decision: ControlDecision
}
/** The person at the computer stopped control */
export type AgentStopMessage = { t: 'controlStop'; grant: string; reason: AgentStopReason }
/**
 * 「不再接受請求 N 分鐘」 from the dialog (sent after its `deny`) or the tray: the room refuses every
 * request to this agent for `ms` (one of CONTROL_MUTE_OPTIONS_MS; 0 takes requests again)
 */
export type ControlMuteMessage = { t: 'controlMute'; ms: number }

export type AgentMessage =
  AgentHelloMessage | ControlAnswerMessage | AgentStopMessage | ControlMuteMessage

// ── Room → agent ─────────────────────────────────────────────────────────────────────────────

/**
 * The code was right. Before it publishes anything the agent shows a local confirmation with
 * `roomName` and `ownerName` (「Alice 發的配對碼，要加入『週五讀書會』嗎？房間裡的人都會看到你的
 * 螢幕」); sharing the screen is its own switch after that, off until the person turns it on.
 */
export type AgentWelcomeMessage = {
  t: 'agentWelcome'
  memberId: string
  token: string
  /** The member who issued the pairing code: the computer is shown as theirs */
  owner: string
  ownerName: string
  roomName: string
}
/**
 * Someone asks to control this computer: show the system dialog (after pausing any injection). `name`
 * is the name the requester chose, not verified, and the dialog says so. No 「已登入」 badge: a
 * passkey session proves an account, but members carry no stable account handle the person could
 * recognise, so the badge would suggest an identity nobody checked. The agent counts
 * clampAskTtl(`ttlMs`) on its own clock.
 */
export type ControlAskMessage = {
  t: 'controlAsk'
  request: string
  from: { id: string; name: string }
  roomName: string
  ttlMs: number
}
/** The request ended before the agent answered: close the dialog */
export type ControlAskEndMessage = {
  t: 'controlAskEnd'
  request: string
  reason: Exclude<ControlRequestEndReason, 'denied' | 'muted'>
}
/**
 * The request this agent allowed is now a grant: the id every forwarded batch will carry, who
 * controls, and how long. `durationMs` is only an echo: the agent refuses a start whose duration
 * is not what its own decision gives (validateControlStart), enforces that duration on its own
 * clock, and shows the red border and 中斷 button from now on.
 */
export type ControlStartMessage = {
  t: 'controlStart'
  request: string
  grant: string
  controller: { id: string; name: string }
  /** null: until stopped (asked again every CONTROL_RECONFIRM_MS) */
  durationMs: number | null
}
/** A batch the room accepted from the controller holding `grant` */
export type ControlForwardMessage = {
  t: 'controlForward'
  grant: string
  seq: number
  events: ControlEvent[]
}

export type AgentServerMessage =
  | AgentWelcomeMessage
  | ControlAskMessage
  | ControlAskEndMessage
  | ControlStartMessage
  | ControlForwardMessage
  | ControlEndMessage

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

/** `controlEvent`'s fields; null when the grant id, seq or any event does not fit */
export function parseControlEventMessage(
  value: Record<string, unknown>,
): ControlEventMessage | null {
  if (!isControlId(value.grant)) return null
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) return null
  const events = parseControlEvents(value.events)
  if (events === null) return null
  return { t: 'controlEvent', grant: value.grant, seq: value.seq as number, events }
}

/** A controller's control message (N3: parseClientMessage hands it the four kinds) */
export function parseControlClientMessage(
  value: Record<string, unknown>,
): ControlClientMessage | null {
  switch (value.t) {
    case 'controlRequest':
      return isMemberId(value.agent) ? { t: 'controlRequest', agent: value.agent } : null
    case 'controlCancel':
      return isControlId(value.request) ? { t: 'controlCancel', request: value.request } : null
    case 'controlEvent':
      return parseControlEventMessage(value)
    case 'controlStop':
      return isControlId(value.grant) ? { t: 'controlStop', grant: value.grant } : null
    default:
      return null
  }
}

/** `controlAnswer`'s fields; null for an unknown decision or a malformed request id */
export function parseControlAnswer(value: Record<string, unknown>): ControlAnswerMessage | null {
  if (!isControlId(value.request)) return null
  if (!CONTROL_DECISIONS.includes(value.decision as ControlDecision)) return null
  return { t: 'controlAnswer', request: value.request, decision: value.decision as ControlDecision }
}

/**
 * `agentHello`'s fields; null unless it brings exactly one of a pairing code and a token, a device
 * name, a known platform and a build string
 */
export function parseAgentHello(value: Record<string, unknown>): AgentHelloMessage | null {
  const pairing = value.pairing === null ? null : normalizePairingCode(value.pairing)
  const token = isAgentToken(value.token) ? value.token : null
  if (value.pairing !== null && pairing === null) return null
  if (value.token !== null && token === null) return null
  if ((pairing === null) === (token === null)) return null
  const device = normalizeLabel(value.device)
  if (device === null) return null
  if (!AGENT_PLATFORMS.includes(value.platform as AgentPlatform)) return null
  if (typeof value.build !== 'string' || !/^[0-9A-Za-z.+-]{1,32}$/.test(value.build)) return null
  return {
    t: 'agentHello',
    pairing,
    token,
    device,
    platform: value.platform as AgentPlatform,
    build: value.build,
  }
}

function parseObject(raw: string, maxChars: number): Record<string, unknown> | null {
  if (raw.length > maxChars) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** An agent socket's frame, or null when it is not one this version understands */
export function parseAgentMessage(raw: string): AgentMessage | null {
  const value = parseObject(raw, MAX_AGENT_MESSAGE_CHARS)
  switch (value?.t) {
    case 'agentHello':
      return parseAgentHello(value)
    case 'controlAnswer':
      return parseControlAnswer(value)
    case 'controlStop':
      if (!isControlId(value.grant)) return null
      if (!AGENT_STOP_REASONS.includes(value.reason as AgentStopReason)) return null
      return { t: 'controlStop', grant: value.grant, reason: value.reason as AgentStopReason }
    case 'controlMute':
      return typeof value.ms === 'number' && CONTROL_MUTE_OPTIONS_MS.includes(value.ms)
        ? { t: 'controlMute', ms: value.ms }
        : null
    default:
      return null
  }
}

/**
 * `controlForward` as the agent checks it before injecting anything (the Rust agent mirrors this):
 * at most MAX_FORWARD_CHARS, the same rules as the controller's batch. The agent also requires
 * `grant` to be the grant it validated (validateControlStart) and runs acceptSeq on `seq`.
 */
export function parseControlForward(raw: string): ControlForwardMessage | null {
  const value = parseObject(raw, MAX_FORWARD_CHARS)
  if (value?.t !== 'controlForward') return null
  const batch = parseControlEventMessage(value)
  return batch === null ? null : { ...batch, t: 'controlForward' }
}

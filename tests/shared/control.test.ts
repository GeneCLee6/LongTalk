import { describe, expect, it } from 'vitest'
import { MAX_CLIENT_MESSAGE_CHARS } from '../../shared/protocol.ts'
import {
  CONTROL_AGENT_DENY_LIMIT,
  CONTROL_EVENT_RATE,
  CONTROL_FRAME_RATE,
  CONTROL_IDLE_RELEASE_MS,
  CONTROL_HOLD_KEEPALIVE_MS,
  CONTROL_MUTE_OPTIONS_MS,
  MAX_FORWARD_CHARS,
  PAIRING_NETWORK_FAIL_RATE,
  PAIRING_ROOM_MAX_FAILS,
  agentGrantMs,
  clampAskTtl,
  exemptFromSocketRate,
  modsOfHeld,
  nextHeld,
  releaseHeld,
  upEventsOnly,
  validateControlStart,
  type ControlStartMessage,
  type HeldInput,
  CONTROL_GRANT_MS,
  CONTROL_KEY_CODES,
  CONTROL_REQUEST_TTL_MS,
  MAX_AGENT_MESSAGE_CHARS,
  MAX_CONTROL_BATCH,
  MAX_CONTROL_SEQ_GAP,
  MAX_DEVICE_CHARS,
  MAX_TEXT_CHARS,
  MAX_WHEEL_DELTA,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  acceptSeq,
  classifyKeyCombo,
  coalesceMoves,
  formatPairingCode,
  grantUntil,
  isControlId,
  newControlId,
  newPairingCode,
  normalizeControlText,
  normalizePairingCode,
  parseAgentHello,
  parseAgentMessage,
  parseControlAnswer,
  parseControlClientMessage,
  parseControlEvent,
  parseControlEventMessage,
  parseControlEvents,
  parseControlForward,
  takeControlEvents,
  type ControlEvent,
  type EventWindow,
} from '../../shared/control.ts'

// N1 (e9-t01, AC-9.4 partial): the remote-control protocol's parsers and pure helpers. These are
// the rules the room (N3) and the agent (N4, Rust) both follow; the threat model behind each one is
// docs/PRD/f-remote-control-security.md.

const GRANT = 'AAAAAAAAAAAAAAAAAAAAAA'
const REQUEST = 'abcdefghijklmnopqrstuv'
const TOKEN = 'x'.repeat(43)

const move = (x: number, y: number): ControlEvent => ({ type: 'move', x, y })

describe('limits', () => {
  it('match the epic and the threat model', () => {
    expect(CONTROL_REQUEST_TTL_MS).toBe(60_000)
    expect(CONTROL_EVENT_RATE).toEqual({ count: 120, windowMs: 1_000 })
    expect(CONTROL_GRANT_MS.allow10).toBe(10 * 60_000)
    expect(CONTROL_GRANT_MS.allowUntilStop).toBeNull()
    // A full batch fits the rate several times over, and a batch fits a socket frame
    expect(MAX_CONTROL_BATCH).toBeLessThanOrEqual(CONTROL_EVENT_RATE.count)
  })

  it('every batch the parser accepts fits the frames it travels in', () => {
    // The longest text JSON can make of MAX_TEXT_CHARS characters: two UTF-16 units each, from
    // astral characters (surrogate pairs) or from `"` and `\` (escaped)
    const worstTexts = [
      '😀'.repeat(MAX_TEXT_CHARS),
      '"'.repeat(MAX_TEXT_CHARS),
      '\\'.repeat(MAX_TEXT_CHARS),
    ]
    const worstOther: unknown[] = [
      { type: 'move', x: 1.2345678901234567e-7, y: 1.2345678901234567e-7 },
      { type: 'key', code: 'NumpadSubtract', down: false, mods: 15 },
      { type: 'wheel', dx: -MAX_WHEEL_DELTA, dy: -MAX_WHEEL_DELTA },
    ]
    const candidates = [...worstTexts.map((text) => ({ type: 'text', text })), ...worstOther]
    for (const event of candidates) {
      const events = parseControlEvents(Array.from({ length: MAX_CONTROL_BATCH }, () => event))
      expect(events).not.toBeNull()
      const forward = JSON.stringify({
        t: 'controlForward',
        grant: GRANT,
        seq: Number.MAX_SAFE_INTEGER,
        events,
      })
      expect(forward.length).toBeLessThanOrEqual(MAX_FORWARD_CHARS)
      const fromController = JSON.stringify({ ...JSON.parse(forward), t: 'controlEvent' })
      expect(fromController.length).toBeLessThanOrEqual(MAX_CLIENT_MESSAGE_CHARS)
      // And the agent's parser takes it back
      expect(parseControlForward(forward)).not.toBeNull()
    }
    // The old 4 k limit really was too small for astral text
    const astral = JSON.stringify({
      t: 'controlForward',
      grant: GRANT,
      seq: 1,
      events: Array.from({ length: MAX_CONTROL_BATCH }, () => ({
        type: 'text',
        text: '😀'.repeat(MAX_TEXT_CHARS),
      })),
    })
    expect(astral.length).toBeGreaterThan(MAX_AGENT_MESSAGE_CHARS)
  })

  it('keep the browser and the room consistent', () => {
    expect(CONTROL_HOLD_KEEPALIVE_MS).toBeLessThan(CONTROL_IDLE_RELEASE_MS)
    // The browser batches every CONTROL_BATCH_MS (~30 a second) and flushes keys and clicks at once
    expect(CONTROL_FRAME_RATE.count).toBeGreaterThan(Math.ceil(1_000 / 33))
    expect(CONTROL_AGENT_DENY_LIMIT.count).toBe(3)
    expect(CONTROL_MUTE_OPTIONS_MS).toContain(0)
    expect(PAIRING_NETWORK_FAIL_RATE.count).toBeLessThan(PAIRING_ROOM_MAX_FAILS)
  })
})

describe('parseControlEvent', () => {
  it('takes every kind of event', () => {
    expect(parseControlEvent({ type: 'move', x: 0, y: 1 })).toEqual(move(0, 1))
    expect(parseControlEvent({ type: 'move', x: 0.25, y: 0.75 })).toEqual(move(0.25, 0.75))
    expect(parseControlEvent({ type: 'button', button: 'right', down: true })).toEqual({
      type: 'button',
      button: 'right',
      down: true,
    })
    expect(parseControlEvent({ type: 'wheel', dx: 0, dy: -120 })).toEqual({
      type: 'wheel',
      dx: 0,
      dy: -120,
    })
    expect(
      parseControlEvent({ type: 'key', code: 'KeyC', down: true, mods: MOD_CTRL | MOD_SHIFT }),
    ).toEqual({ type: 'key', code: 'KeyC', down: true, mods: 3 })
    expect(parseControlEvent({ type: 'text', text: '你好' })).toEqual({
      type: 'text',
      text: '你好',
    })
  })

  it('drops fields it does not know', () => {
    expect(parseControlEvent({ type: 'move', x: 0.5, y: 0.5, screen: 'evil' })).toEqual(
      move(0.5, 0.5),
    )
  })

  it('refuses coordinates outside 0–1 and anything not a finite number', () => {
    for (const bad of [-0.0001, 1.0001, 2, -1, NaN, Infinity, -Infinity, '0.5', null, undefined]) {
      expect(parseControlEvent({ type: 'move', x: bad, y: 0.5 })).toBeNull()
      expect(parseControlEvent({ type: 'move', x: 0.5, y: bad })).toBeNull()
    }
  })

  it('refuses unknown buttons and a missing down', () => {
    expect(parseControlEvent({ type: 'button', button: 'back', down: true })).toBeNull()
    expect(parseControlEvent({ type: 'button', button: 'left' })).toBeNull()
    expect(parseControlEvent({ type: 'button', button: 'left', down: 1 })).toBeNull()
  })

  it('clamps and rounds wheel deltas, refuses non-finite and empty ones', () => {
    expect(parseControlEvent({ type: 'wheel', dx: 99_999, dy: -99_999 })).toEqual({
      type: 'wheel',
      dx: MAX_WHEEL_DELTA,
      dy: -MAX_WHEEL_DELTA,
    })
    expect(parseControlEvent({ type: 'wheel', dx: 0.4, dy: 2.6 })).toEqual({
      type: 'wheel',
      dx: 0,
      dy: 3,
    })
    expect(parseControlEvent({ type: 'wheel', dx: NaN, dy: 1 })).toBeNull()
    expect(parseControlEvent({ type: 'wheel', dx: 1, dy: Infinity })).toBeNull()
    expect(parseControlEvent({ type: 'wheel', dx: 0, dy: 0 })).toBeNull()
    expect(parseControlEvent({ type: 'wheel', dx: 0.2, dy: -0.2 })).toBeNull()
    expect(parseControlEvent({ type: 'wheel', dy: 10 })).toBeNull()
  })

  it('refuses key codes outside the allowlist', () => {
    for (const code of [
      'Power',
      'Sleep',
      'WakeUp',
      'Eject',
      'AudioVolumeUp',
      'MediaPlayPause',
      'BrowserBack',
      'LaunchApp1',
      'F13',
      'F24',
      'Fn',
      'keya',
      'KeyAA',
      '',
      'Unidentified',
    ]) {
      expect(parseControlEvent({ type: 'key', code, down: true, mods: 0 })).toBeNull()
    }
    expect(parseControlEvent({ type: 'key', code: 7, down: true, mods: 0 })).toBeNull()
  })

  it('knows the keys a keyboard needs, IME keys included', () => {
    for (const code of [
      'KeyA',
      'KeyZ',
      'Digit0',
      'F1',
      'F12',
      'Numpad5',
      'Enter',
      'Escape',
      'ArrowLeft',
      'MetaLeft',
      'ControlRight',
      'Space',
      'Backspace',
      'Lang1',
      'Convert',
      'IntlRo',
    ]) {
      expect(CONTROL_KEY_CODES.has(code)).toBe(true)
    }
  })

  it('refuses bad modifier masks', () => {
    for (const mods of [-1, 16, 1.5, NaN, '1', null]) {
      expect(parseControlEvent({ type: 'key', code: 'KeyA', down: true, mods })).toBeNull()
    }
    expect(
      parseControlEvent({
        type: 'key',
        code: 'KeyA',
        down: false,
        mods: MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_META,
      }),
    ).not.toBeNull()
  })

  it('refuses unknown types and non-objects', () => {
    for (const bad of [null, 1, 'move', [], { type: 'scroll' }, { type: 'releaseAll' }, {}]) {
      expect(parseControlEvent(bad)).toBeNull()
    }
  })
})

describe('normalizeControlText', () => {
  it('keeps IME text and normalizes it to NFC', () => {
    expect(normalizeControlText('ㄋㄧˇ ㄏㄠˇ')).toBe('ㄋㄧˇ ㄏㄠˇ')
    expect(normalizeControlText('e\u0301')).toBe('\u00E9')
    expect(normalizeControlText('😀')).toBe('😀')
  })

  it('counts characters, not UTF-16 units', () => {
    expect(normalizeControlText('😀'.repeat(MAX_TEXT_CHARS))).not.toBeNull()
    expect(normalizeControlText('😀'.repeat(MAX_TEXT_CHARS + 1))).toBeNull()
    expect(normalizeControlText('a'.repeat(MAX_TEXT_CHARS + 1))).toBeNull()
  })

  it('refuses control characters, bidi overrides, lone surrogates and empty text', () => {
    for (const bad of [
      'a\nb',
      'tab\t',
      '\u0000',
      'x\u001b[2J',
      '\u007f',
      'abc\u202Edef',
      '\u2066x',
      '\uD800',
      'a\uDC00',
      '',
      42,
      null,
    ]) {
      expect(normalizeControlText(bad)).toBeNull()
    }
    expect(parseControlEvent({ type: 'text', text: 'a\rb' })).toBeNull()
  })
})

describe('parseControlEvents', () => {
  it('takes 1 to MAX_CONTROL_BATCH events', () => {
    expect(parseControlEvents([move(0, 0)])).toEqual([move(0, 0)])
    const full = Array.from({ length: MAX_CONTROL_BATCH }, () => move(0.5, 0.5))
    expect(parseControlEvents(full)).toHaveLength(MAX_CONTROL_BATCH)
  })

  it('refuses empty, too many, or not an array', () => {
    expect(parseControlEvents([])).toBeNull()
    expect(
      parseControlEvents(Array.from({ length: MAX_CONTROL_BATCH + 1 }, () => move(0.5, 0.5))),
    ).toBeNull()
    expect(parseControlEvents({ 0: move(0, 0), length: 1 })).toBeNull()
    expect(parseControlEvents(null)).toBeNull()
  })

  it('refuses the whole batch for one bad event (never half a batch)', () => {
    expect(
      parseControlEvents([
        { type: 'key', code: 'ShiftLeft', down: true, mods: 0 },
        { type: 'move', x: 2, y: 0 },
        { type: 'key', code: 'ShiftLeft', down: false, mods: 0 },
      ]),
    ).toBeNull()
  })
})

describe('coalesceMoves', () => {
  it('keeps only the last of a run of moves', () => {
    expect(coalesceMoves([move(0.1, 0.1), move(0.2, 0.2), move(0.3, 0.3)])).toEqual([
      move(0.3, 0.3),
    ])
  })

  it('keeps moves on either side of a button or key apart', () => {
    const down: ControlEvent = { type: 'button', button: 'left', down: true }
    const up: ControlEvent = { type: 'button', button: 'left', down: false }
    expect(
      coalesceMoves([move(0.1, 0.1), move(0.2, 0.2), down, move(0.3, 0.3), move(0.4, 0.4), up]),
    ).toEqual([move(0.2, 0.2), down, move(0.4, 0.4), up])
    expect(coalesceMoves([])).toEqual([])
  })
})

describe('acceptSeq', () => {
  it('takes the next one', () => {
    expect(acceptSeq(0, 1)).toBe('next')
    expect(acceptSeq(41, 42)).toBe('next')
  })

  it('flags a gap up to MAX_CONTROL_SEQ_GAP (dropped batches: release held input)', () => {
    expect(acceptSeq(0, 2)).toBe('gap')
    expect(acceptSeq(10, 10 + MAX_CONTROL_SEQ_GAP)).toBe('gap')
  })

  it('drops replays and reordered batches', () => {
    expect(acceptSeq(5, 5)).toBe('stale')
    expect(acceptSeq(5, 4)).toBe('stale')
    expect(acceptSeq(5, 1)).toBe('stale')
  })

  it('refuses a jump too far ahead and anything not a positive safe integer', () => {
    expect(acceptSeq(10, 11 + MAX_CONTROL_SEQ_GAP)).toBe('invalid')
    expect(acceptSeq(0, Number.MAX_SAFE_INTEGER)).toBe('invalid')
    for (const bad of [0, -1, 1.5, NaN, Infinity, '2', null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(acceptSeq(0, bad)).toBe('invalid')
    }
  })

  it('a replayed stream after a gap is still refused', () => {
    let last = 0
    const verdicts = [1, 2, 5, 3, 4, 5, 6].map((seq) => {
      const verdict = acceptSeq(last, seq)
      if (verdict === 'next' || verdict === 'gap') last = seq
      return verdict
    })
    expect(verdicts).toEqual(['next', 'next', 'gap', 'stale', 'stale', 'stale', 'next'])
  })
})

describe('takeControlEvents', () => {
  it('allows up to CONTROL_EVENT_RATE.count events in any window', () => {
    let window: EventWindow = []
    for (let i = 0; i < 4; i += 1) {
      const result = takeControlEvents(window, MAX_CONTROL_BATCH, i * 10)
      expect(result.ok).toBe(true)
      window = result.window
    }
    // 120 used within the second: the next event does not fit, and is not counted
    const refused = takeControlEvents(window, 1, 100)
    expect(refused.ok).toBe(false)
    expect(refused.window).toHaveLength(4)
  })

  it('drops a batch that does not fit whole, while a smaller one still may', () => {
    const first = takeControlEvents([], 100, 0)
    expect(takeControlEvents(first.window, 30, 500).ok).toBe(false)
    expect(takeControlEvents(first.window, 20, 500).ok).toBe(true)
  })

  it('frees room as entries leave the window', () => {
    const full = takeControlEvents([], 120, 0).window
    expect(takeControlEvents(full, 1, 999).ok).toBe(false)
    const later = takeControlEvents(full, 120, 1_000)
    expect(later.ok).toBe(true)
    expect(later.window).toEqual([{ at: 1_000, count: 120 }])
  })

  it('sustains 120 events a second in batches every 33 ms, not more', () => {
    let window: EventWindow = []
    let accepted = 0
    // 4 events per 33 ms batch ≈ 121 a second: a few batches must be dropped
    for (let at = 0; at < 10_000; at += 33) {
      const result = takeControlEvents(window, 4, at)
      window = result.window
      if (result.ok) accepted += 4
    }
    expect(accepted).toBeLessThanOrEqual(120 * 10 + 120)
    expect(accepted).toBeGreaterThan(110 * 10)
  })

  it('refuses a count below one', () => {
    expect(takeControlEvents([], 0, 0).ok).toBe(false)
  })
})

describe('classifyKeyCombo', () => {
  const none: HeldInput = new Set()

  it('blocks the secure attention sequence on Windows and Linux', () => {
    expect(classifyKeyCombo('Delete', none, MOD_CTRL | MOD_ALT, 'windows')).toBe('block')
    expect(classifyKeyCombo('Delete', none, MOD_CTRL | MOD_ALT | MOD_SHIFT, 'linux')).toBe('block')
    expect(classifyKeyCombo('Delete', none, MOD_CTRL, 'windows')).toBe('allow')
  })

  it('judges the modifiers actually held, not only what the event claims', () => {
    // ControlLeft down, AltLeft down, then Delete with mods 0: the OS sees Ctrl+Alt+Del
    const events: ControlEvent[] = [
      { type: 'key', code: 'ControlLeft', down: true, mods: 0 },
      { type: 'key', code: 'AltLeft', down: true, mods: 0 },
    ]
    const held = events.reduce(nextHeld, none)
    expect(modsOfHeld(held)).toBe(MOD_CTRL | MOD_ALT)
    expect(classifyKeyCombo('Delete', held, 0, 'windows')).toBe('block')
    // Half from the event, half held
    const ctrlOnly = nextHeld(none, { type: 'key', code: 'ControlRight', down: true, mods: 0 })
    expect(classifyKeyCombo('Delete', ctrlOnly, MOD_ALT, 'linux')).toBe('block')
    expect(
      classifyKeyCombo(
        'KeyR',
        nextHeld(none, { type: 'key', code: 'MetaLeft', down: true, mods: 0 }),
        0,
        'windows',
      ),
    ).toBe('warn')
    // Released again: nothing held
    const released = nextHeld(ctrlOnly, { type: 'key', code: 'ControlRight', down: false, mods: 0 })
    expect(classifyKeyCombo('Delete', released, MOD_ALT, 'linux')).toBe('allow')
  })

  it('blocks console switching, killing X and Magic SysRq on Linux', () => {
    expect(classifyKeyCombo('F2', none, MOD_CTRL | MOD_ALT, 'linux')).toBe('block')
    expect(classifyKeyCombo('Backspace', none, MOD_CTRL | MOD_ALT, 'linux')).toBe('block')
    expect(classifyKeyCombo('PrintScreen', none, MOD_ALT, 'linux')).toBe('block')
    const altHeld = nextHeld(none, { type: 'key', code: 'AltRight', down: true, mods: 0 })
    expect(classifyKeyCombo('PrintScreen', altHeld, 0, 'linux')).toBe('block')
    expect(classifyKeyCombo('PrintScreen', none, 0, 'linux')).toBe('allow')
    expect(classifyKeyCombo('PrintScreen', none, MOD_ALT, 'windows')).toBe('allow')
    expect(classifyKeyCombo('F2', none, MOD_CTRL | MOD_ALT, 'windows')).toBe('allow')
  })

  it('warns on what opens something powerful', () => {
    expect(classifyKeyCombo('KeyR', none, MOD_META, 'windows')).toBe('warn')
    expect(classifyKeyCombo('KeyL', none, MOD_META, 'windows')).toBe('warn')
    expect(classifyKeyCombo('Escape', none, MOD_CTRL | MOD_SHIFT, 'windows')).toBe('warn')
    expect(classifyKeyCombo('Escape', none, MOD_META | MOD_ALT, 'macos')).toBe('warn')
    expect(classifyKeyCombo('KeyQ', none, MOD_CTRL | MOD_META, 'macos')).toBe('warn')
  })

  it('allows ordinary shortcuts (⌘R is reload on a Mac, not Run)', () => {
    expect(classifyKeyCombo('KeyR', none, MOD_META, 'macos')).toBe('allow')
    expect(classifyKeyCombo('KeyC', none, MOD_CTRL, 'windows')).toBe('allow')
    expect(classifyKeyCombo('KeyA', none, 0, 'linux')).toBe('allow')
  })
})

describe('held input', () => {
  const none: HeldInput = new Set()
  const key = (code: string, down: boolean): ControlEvent => ({ type: 'key', code, down, mods: 0 })
  const button = (down: boolean): ControlEvent => ({ type: 'button', button: 'left', down })

  it('tracks keys and buttons, and ignores what presses nothing', () => {
    let held = none
    for (const event of [key('ShiftLeft', true), key('KeyA', true), button(true), move(0.1, 0.1)]) {
      held = nextHeld(held, event)
    }
    expect([...held].sort()).toEqual(['KeyA', 'ShiftLeft', 'button:left'])
    expect(nextHeld(held, move(0.2, 0.2))).toBe(held)
    expect(nextHeld(held, key('KeyA', true))).toBe(held)
    expect(nextHeld(held, key('KeyZ', false))).toBe(held)
    expect([...nextHeld(held, key('KeyA', false))].sort()).toEqual(['ShiftLeft', 'button:left'])
  })

  it('releases everything, other keys before modifiers, then buttons', () => {
    const held: HeldInput = new Set(['ControlLeft', 'KeyC', 'button:right', 'button:left'])
    expect(releaseHeld(held)).toEqual([
      key('KeyC', false),
      key('ControlLeft', false),
      { type: 'button', button: 'left', down: false },
      { type: 'button', button: 'right', down: false },
    ])
    expect(releaseHeld(none)).toEqual([])
    // Releasing leaves nothing held
    expect(releaseHeld(held).reduce(nextHeld, held).size).toBe(0)
  })

  it('keeps only the up events of a batch over the rate', () => {
    const batch: ControlEvent[] = [
      key('KeyA', true),
      move(0.5, 0.5),
      key('KeyA', false),
      button(true),
      { type: 'text', text: '好' },
      button(false),
      { type: 'wheel', dx: 0, dy: 10 },
    ]
    expect(upEventsOnly(batch)).toEqual([key('KeyA', false), button(false)])
    expect(upEventsOnly([move(0, 0)])).toEqual([])
  })
})

describe('the room and the agent following acceptSeq', () => {
  /** The room: forwards what fits, only the up events of what does not, and ends on `invalid` */
  function room(batches: { seq: number; events: ControlEvent[]; overRate: boolean }[]) {
    let last = 0
    const forwarded: { seq: number; events: ControlEvent[] }[] = []
    for (const batch of batches) {
      const verdict = acceptSeq(last, batch.seq)
      if (verdict === 'invalid') return { forwarded, ended: 'desynced' as const }
      if (verdict === 'stale') continue
      const events = batch.overRate ? upEventsOnly(batch.events) : batch.events
      if (events.length === 0) continue // dropped: `last` does not move
      forwarded.push({ seq: batch.seq, events })
      last = batch.seq
    }
    return { forwarded, ended: null }
  }

  it('a drop does not advance last, so the next batch is a gap for the agent', () => {
    const down: ControlEvent = { type: 'key', code: 'ShiftLeft', down: true, mods: 0 }
    const up: ControlEvent = { type: 'key', code: 'ShiftLeft', down: false, mods: 0 }
    const result = room([
      { seq: 1, events: [down], overRate: false },
      { seq: 2, events: [move(0.1, 0.1)], overRate: true },
      { seq: 3, events: [move(0.2, 0.2), up], overRate: true },
      { seq: 4, events: [move(0.3, 0.3)], overRate: false },
    ])
    // Batch 2 dropped whole; batch 3 cut down to its key up (never lost); 4 goes as usual
    expect(result.forwarded).toEqual([
      { seq: 1, events: [down] },
      { seq: 3, events: [up] },
      { seq: 4, events: [move(0.3, 0.3)] },
    ])
    let agentLast = 0
    const verdicts = result.forwarded.map(({ seq }) => {
      const verdict = acceptSeq(agentLast, seq)
      agentLast = seq
      return verdict
    })
    expect(verdicts).toEqual(['next', 'gap', 'next'])
  })

  it('drops past the gap window end the grant instead of leaving it stuck', () => {
    const batches = [{ seq: 1, events: [move(0, 0)], overRate: false }]
    for (let seq = 2; seq <= MAX_CONTROL_SEQ_GAP + 2; seq += 1) {
      batches.push({ seq, events: [move(0.5, 0.5)], overRate: true })
    }
    batches.push({ seq: MAX_CONTROL_SEQ_GAP + 3, events: [move(1, 1)], overRate: false })
    expect(room(batches).ended).toBe('desynced')
  })
})

describe('exemptFromSocketRate', () => {
  const batch = parseControlClientMessage({
    t: 'controlEvent',
    grant: GRANT,
    seq: 1,
    events: [move(0, 0)],
  })

  it('exempts only a controlEvent for the grant this socket holds', () => {
    expect(exemptFromSocketRate(batch, GRANT)).toBe(true)
  })

  it('counts everything else: no grant, another grant, junk, other messages', () => {
    expect(exemptFromSocketRate(batch, null)).toBe(false)
    expect(exemptFromSocketRate(batch, REQUEST)).toBe(false)
    expect(exemptFromSocketRate(null, GRANT)).toBe(false)
    expect(exemptFromSocketRate({ t: 'controlStop', grant: GRANT }, GRANT)).toBe(false)
    expect(exemptFromSocketRate({ t: 'controlRequest', agent: 'm-1' }, GRANT)).toBe(false)
  })
})

describe("the agent's own limits on what the room says", () => {
  const start = (durationMs: number | null, request = REQUEST): ControlStartMessage => ({
    t: 'controlStart',
    request,
    grant: GRANT,
    controller: { id: 'm-2', name: 'Bob' },
    durationMs,
  })

  it('derives the duration from its own decision', () => {
    expect(agentGrantMs('allow10')).toBe(10 * 60_000)
    expect(agentGrantMs('allowUntilStop')).toBeNull()
  })

  it('accepts a start that matches what it allowed', () => {
    expect(
      validateControlStart(start(10 * 60_000), { request: REQUEST, decision: 'allow10' }),
    ).toBe(true)
    expect(
      validateControlStart(start(null), { request: REQUEST, decision: 'allowUntilStop' }),
    ).toBe(true)
  })

  it('refuses a start with another duration, request, or after a deny', () => {
    // A compromised room turning an allow10 into "until stopped", or stretching it
    expect(validateControlStart(start(null), { request: REQUEST, decision: 'allow10' })).toBe(false)
    expect(
      validateControlStart(start(60 * 60_000), { request: REQUEST, decision: 'allow10' }),
    ).toBe(false)
    expect(
      validateControlStart(start(10 * 60_000), { request: REQUEST, decision: 'allowUntilStop' }),
    ).toBe(false)
    expect(
      validateControlStart(start(10 * 60_000, GRANT), { request: REQUEST, decision: 'allow10' }),
    ).toBe(false)
    expect(validateControlStart(start(10 * 60_000), { request: REQUEST, decision: 'deny' })).toBe(
      false,
    )
    expect(validateControlStart(start(10 * 60_000), null)).toBe(false)
    expect(
      validateControlStart(
        { ...start(10 * 60_000), grant: 'short' },
        { request: REQUEST, decision: 'allow10' },
      ),
    ).toBe(false)
  })

  it('caps how long a request dialog stays up', () => {
    expect(clampAskTtl(59_000)).toBe(59_000)
    expect(clampAskTtl(1e9)).toBe(CONTROL_REQUEST_TTL_MS)
    expect(clampAskTtl(Infinity)).toBeNull()
    for (const bad of [0, -1, NaN, '60000', null]) expect(clampAskTtl(bad)).toBeNull()
  })
})

describe('ids and pairing codes', () => {
  it('makes random 22-character ids', () => {
    const ids = new Set(Array.from({ length: 50 }, newControlId))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(isControlId(id)).toBe(true)
    expect(isControlId('short')).toBe(false)
    expect(isControlId(`${GRANT}A`)).toBe(false)
    expect(isControlId('AAAAAAAAAAAAAAAAAAAAA=')).toBe(false)
  })

  it('makes codes from the alphabet that read back as themselves', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = newPairingCode()
      expect(code).toHaveLength(PAIRING_CODE_LENGTH)
      for (const char of code) expect(PAIRING_ALPHABET).toContain(char)
      expect(normalizePairingCode(formatPairingCode(code))).toBe(code)
      expect(normalizePairingCode(formatPairingCode(code).toLowerCase())).toBe(code)
    }
  })

  it('forgives how people type a code', () => {
    expect(normalizePairingCode('7k3m-q9td')).toBe('7K3MQ9TD')
    expect(normalizePairingCode(' 7K3M Q9TD ')).toBe('7K3MQ9TD')
    expect(normalizePairingCode('OIL0-ABCD')).toBe('0110ABCD')
  })

  it('refuses what cannot be a code', () => {
    for (const bad of [
      '7K3MQ9T',
      '7K3MQ9TDX',
      '7K3M_Q9TD',
      '7K3MQ9TU',
      '',
      12345678,
      null,
      'A'.repeat(33),
    ]) {
      expect(normalizePairingCode(bad)).toBeNull()
    }
  })
})

describe('grantUntil', () => {
  it('ends a ten-minute grant ten minutes on, and an until-stop grant never', () => {
    expect(grantUntil('allow10', 1_000)).toBe(1_000 + 10 * 60_000)
    expect(grantUntil('allowUntilStop', 1_000)).toBeNull()
  })
})

describe('parseControlEventMessage', () => {
  const batch = { t: 'controlEvent', grant: GRANT, seq: 1, events: [move(0.5, 0.5)] }

  it('takes a well-formed batch', () => {
    expect(parseControlEventMessage(batch)).toEqual(batch)
  })

  it('refuses a malformed grant id or seq', () => {
    expect(parseControlEventMessage({ ...batch, grant: 'nope' })).toBeNull()
    for (const seq of [0, -1, 1.5, NaN, Infinity, '1', null]) {
      expect(parseControlEventMessage({ ...batch, seq })).toBeNull()
    }
  })

  it('refuses a bad batch', () => {
    expect(parseControlEventMessage({ ...batch, events: [] })).toBeNull()
    expect(
      parseControlEventMessage({ ...batch, events: [{ type: 'move', x: NaN, y: 0 }] }),
    ).toBeNull()
  })
})

describe('parseControlClientMessage', () => {
  it('takes the four controller messages', () => {
    expect(parseControlClientMessage({ t: 'controlRequest', agent: 'm-1' })).toEqual({
      t: 'controlRequest',
      agent: 'm-1',
    })
    expect(parseControlClientMessage({ t: 'controlCancel', request: REQUEST })).toEqual({
      t: 'controlCancel',
      request: REQUEST,
    })
    expect(parseControlClientMessage({ t: 'controlStop', grant: GRANT })).toEqual({
      t: 'controlStop',
      grant: GRANT,
    })
    expect(
      parseControlClientMessage({ t: 'controlEvent', grant: GRANT, seq: 3, events: [move(1, 1)] }),
    ).not.toBeNull()
  })

  it('refuses malformed ids and other kinds', () => {
    expect(parseControlClientMessage({ t: 'controlRequest', agent: '' })).toBeNull()
    expect(parseControlClientMessage({ t: 'controlRequest', agent: 'a b' })).toBeNull()
    expect(parseControlClientMessage({ t: 'controlCancel', request: 'x' })).toBeNull()
    expect(parseControlClientMessage({ t: 'controlStop' })).toBeNull()
    // Only the agent answers: a browser cannot send an answer
    expect(
      parseControlClientMessage({ t: 'controlAnswer', request: REQUEST, decision: 'allow10' }),
    ).toBeNull()
    expect(parseControlClientMessage({ t: 'chat', text: 'hi' })).toBeNull()
  })
})

describe('parseControlAnswer', () => {
  it('takes the three decisions', () => {
    for (const decision of ['allow10', 'allowUntilStop', 'deny']) {
      expect(parseControlAnswer({ t: 'controlAnswer', request: REQUEST, decision })).toEqual({
        t: 'controlAnswer',
        request: REQUEST,
        decision,
      })
    }
  })

  it('refuses anything else (there is no "always allow")', () => {
    for (const decision of ['allow', 'always', 'allowForever', 'ALLOW10', '', null, true, 1]) {
      expect(parseControlAnswer({ request: REQUEST, decision })).toBeNull()
    }
    expect(parseControlAnswer({ request: 'bad', decision: 'deny' })).toBeNull()
  })
})

describe('parseAgentHello', () => {
  const hello = {
    t: 'agentHello',
    pairing: '7K3M-Q9TD',
    token: null,
    device: '  客廳的  筆電 ',
    platform: 'windows',
    build: '0.1.0',
  }

  it('takes a first hello with a pairing code, normalized', () => {
    expect(parseAgentHello(hello)).toEqual({
      ...hello,
      pairing: '7K3MQ9TD',
      device: '客廳的 筆電',
    })
  })

  it('takes a reconnect with a token instead', () => {
    expect(parseAgentHello({ ...hello, pairing: null, token: TOKEN })).not.toBeNull()
  })

  it('needs exactly one of a code and a token, both well-formed', () => {
    expect(parseAgentHello({ ...hello, token: TOKEN })).toBeNull()
    expect(parseAgentHello({ ...hello, pairing: null })).toBeNull()
    expect(parseAgentHello({ ...hello, pairing: 'nope' })).toBeNull()
    expect(parseAgentHello({ ...hello, pairing: null, token: 'short' })).toBeNull()
    expect(parseAgentHello({ ...hello, pairing: undefined })).toBeNull()
  })

  it('refuses a bad device name, platform or build', () => {
    expect(parseAgentHello({ ...hello, device: '' })).toBeNull()
    expect(parseAgentHello({ ...hello, device: '\u0000\u202E' })).toBeNull()
    expect(parseAgentHello({ ...hello, device: 'a'.repeat(MAX_DEVICE_CHARS + 1) })).toBeNull()
    expect(parseAgentHello({ ...hello, platform: 'android' })).toBeNull()
    expect(parseAgentHello({ ...hello, build: '' })).toBeNull()
    expect(parseAgentHello({ ...hello, build: '1.0 <script>' })).toBeNull()
  })
})

describe('parseAgentMessage', () => {
  it('reads the agent frames', () => {
    expect(
      parseAgentMessage(JSON.stringify({ t: 'controlAnswer', request: REQUEST, decision: 'deny' })),
    ).toEqual({ t: 'controlAnswer', request: REQUEST, decision: 'deny' })
    expect(
      parseAgentMessage(JSON.stringify({ t: 'controlStop', grant: GRANT, reason: 'escape' })),
    ).toEqual({ t: 'controlStop', grant: GRANT, reason: 'escape' })
    expect(
      parseAgentMessage(
        JSON.stringify({
          t: 'agentHello',
          pairing: null,
          token: TOKEN,
          device: 'PC',
          platform: 'macos',
          build: '1.2.3',
        }),
      ),
    ).not.toBeNull()
  })

  it('reads controlMute with one of the offered durations only', () => {
    for (const ms of CONTROL_MUTE_OPTIONS_MS) {
      expect(parseAgentMessage(JSON.stringify({ t: 'controlMute', ms }))).toEqual({
        t: 'controlMute',
        ms,
      })
    }
    for (const ms of [1, -1, 24 * 60 * 60_000, '600000', null]) {
      expect(parseAgentMessage(JSON.stringify({ t: 'controlMute', ms }))).toBeNull()
    }
  })

  it('refuses unknown stop reasons, browser messages, junk and oversized frames', () => {
    expect(
      parseAgentMessage(JSON.stringify({ t: 'controlStop', grant: GRANT, reason: 'whatever' })),
    ).toBeNull()
    // An agent never sends input: events only flow controller → room → agent
    expect(
      parseAgentMessage(
        JSON.stringify({ t: 'controlEvent', grant: GRANT, seq: 1, events: [move(0, 0)] }),
      ),
    ).toBeNull()
    expect(parseAgentMessage('not json')).toBeNull()
    expect(parseAgentMessage('[]')).toBeNull()
    expect(parseAgentMessage('null')).toBeNull()
    const big = JSON.stringify({
      t: 'controlAnswer',
      request: REQUEST,
      decision: 'deny',
      pad: 'x'.repeat(MAX_AGENT_MESSAGE_CHARS),
    })
    expect(parseAgentMessage(big)).toBeNull()
  })
})

describe('parseControlForward', () => {
  it('checks a forwarded batch as strictly as the room did', () => {
    const forward = { t: 'controlForward', grant: GRANT, seq: 9, events: [move(0.1, 0.9)] }
    expect(parseControlForward(JSON.stringify(forward))).toEqual(forward)
    expect(parseControlForward(JSON.stringify({ ...forward, t: 'controlEvent' }))).toBeNull()
    expect(
      parseControlForward(
        JSON.stringify({
          ...forward,
          events: [{ type: 'key', code: 'Power', down: true, mods: 0 }],
        }),
      ),
    ).toBeNull()
    expect(parseControlForward('{')).toBeNull()
    expect(
      parseControlForward(JSON.stringify({ ...forward, pad: 'x'.repeat(MAX_FORWARD_CHARS) })),
    ).toBeNull()
  })
})

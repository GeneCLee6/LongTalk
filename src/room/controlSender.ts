// The controller's side of the control channel (N3, e9-t05; docs/PRD/f-remote-control-security.md
// §5.5–§5.6): what the share tile's ControlLayer captures becomes `controlEvent` batches for the
// grant this socket holds. The room forwards them only from this socket, in order, within
// CONTROL_EVENT_RATE; the agent checks them again. This side keeps the batches small and steady:
// - moves wait up to CONTROL_BATCH_MS and are merged (coalesceMoves), clicks, keys, wheel and text
//   go at once (with any moves before them), at most MAX_CONTROL_BATCH events a batch;
// - seq starts at 1 and grows by one a batch (acceptSeq);
// - while anything is held (a drag, Shift) the last move is sent again every
//   CONTROL_HOLD_KEEPALIVE_MS, or the agent would let go after CONTROL_IDLE_RELEASE_MS;
// - stopping, or the window losing focus, releases everything held first (releaseHeld).
import {
  CONTROL_BATCH_MS,
  CONTROL_HOLD_KEEPALIVE_MS,
  MAX_CONTROL_BATCH,
  MAX_TEXT_CHARS,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
  coalesceMoves,
  isControlKeyCode,
  nextHeld,
  normalizeControlText,
  releaseHeld,
  type ControlEvent,
  type ControlEventMessage,
  type HeldInput,
  type MouseButton,
} from '../../shared/control.ts'

export class ControlSender {
  readonly #grant: string
  readonly #send: (message: ControlEventMessage) => void
  #seq = 0
  #pending: ControlEvent[] = []
  #held: HeldInput = new Set()
  #lastMove: Extract<ControlEvent, { type: 'move' }> | null = null
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #keepalive: ReturnType<typeof setInterval> | null = null
  #stopped = false

  constructor(grant: string, send: (message: ControlEventMessage) => void) {
    this.#grant = grant
    this.#send = send
  }

  get grant(): string {
    return this.#grant
  }

  /** What is held down now (for tests) */
  get held(): HeldInput {
    return this.#held
  }

  push(event: ControlEvent): void {
    if (this.#stopped) return
    this.#held = nextHeld(this.#held, event)
    this.#pending.push(event)
    if (event.type === 'move') {
      this.#lastMove = event
      this.#flushTimer ??= setTimeout(() => this.flush(), CONTROL_BATCH_MS)
    } else {
      this.flush()
    }
    this.#syncKeepalive()
  }

  /** A pointer position in content coordinates, clamped to the picture (the room refuses outside) */
  move(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    this.push({ type: 'move', x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) })
  }

  button(button: MouseButton, down: boolean): void {
    // An up for a button never pressed here (the press began outside the tile) means nothing
    if (!down && !this.#held.has(`button:${button}`)) return
    this.push({ type: 'button', button, down })
  }

  wheel(dx: number, dy: number): void {
    const x = Math.round(dx)
    const y = Math.round(dy)
    if (x === 0 && y === 0) return
    this.push({ type: 'wheel', dx: x, dy: y })
  }

  /** A physical key (KeyboardEvent.code); false when it is not one the agent presses */
  key(code: string, down: boolean, mods: number): boolean {
    if (!isControlKeyCode(code)) return false
    if (!down && !this.#held.has(code)) return true
    this.push({ type: 'key', code, down, mods })
    return true
  }

  /** Text an input method committed: in pieces of MAX_TEXT_CHARS; nothing that would be refused */
  text(raw: string): void {
    const chars = [...raw.normalize('NFC')]
    for (let i = 0; i < chars.length; i += MAX_TEXT_CHARS) {
      const text = normalizeControlText(chars.slice(i, i + MAX_TEXT_CHARS).join(''))
      if (text !== null) this.push({ type: 'text', text })
    }
  }

  /** Sends what waits now, in batches of MAX_CONTROL_BATCH */
  flush(): void {
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer)
    this.#flushTimer = null
    const events = coalesceMoves(this.#pending)
    this.#pending = []
    for (let i = 0; i < events.length; i += MAX_CONTROL_BATCH) {
      this.#seq += 1
      this.#send({
        t: 'controlEvent',
        grant: this.#grant,
        seq: this.#seq,
        events: events.slice(i, i + MAX_CONTROL_BATCH),
      })
    }
  }

  /** Lets go of every key and button held (the window lost focus, or control is ending) */
  releaseAll(): void {
    if (this.#stopped) return
    const ups = releaseHeld(this.#held)
    if (ups.length === 0) return
    for (const event of ups) this.#held = nextHeld(this.#held, event)
    this.#pending.push(...ups)
    this.flush()
    this.#syncKeepalive()
  }

  /** Control ends here: what is held is released, then nothing more is sent */
  stop(): void {
    this.releaseAll()
    this.flush()
    this.#stopped = true
    if (this.#keepalive !== null) clearInterval(this.#keepalive)
    this.#keepalive = null
  }

  #syncKeepalive(): void {
    const holding = this.#held.size > 0 && !this.#stopped
    if (holding && this.#keepalive === null) {
      this.#keepalive = setInterval(() => {
        if (this.#lastMove && this.#pending.length === 0) this.push(this.#lastMove)
      }, CONTROL_HOLD_KEEPALIVE_MS)
    } else if (!holding && this.#keepalive !== null) {
      clearInterval(this.#keepalive)
      this.#keepalive = null
    }
  }
}

/** The modifier bits of a keyboard or pointer event (what the controller says it holds) */
export function modsOf(event: {
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}): number {
  return (
    (event.shiftKey ? MOD_SHIFT : 0) |
    (event.ctrlKey ? MOD_CTRL : 0) |
    (event.altKey ? MOD_ALT : 0) |
    (event.metaKey ? MOD_META : 0)
  )
}

/** A pointer event's button as the agent knows it; null for the others (back, forward, pen) */
export function buttonOf(button: number): MouseButton | null {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : null
}

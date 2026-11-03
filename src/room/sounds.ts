// The room's sounds (G3, e4-t16; DESIGN.md §6): someone joining or leaving, a raised hand, a chat
// message while the chat is closed. Short, quiet chimes made with Web Audio, so there is nothing
// to download and nothing in the budget. Never before the person has interacted with the page
// (browsers refuse audio until then: the autoplay policy), never while 更多 › 音效 is off.

export type SoundKind = 'join' | 'leave' | 'hand' | 'chat'

/**
 * Join and leave sounds stop once the room has more people than this: in a big meeting they would
 * never stop (the participants button's count still shows it)
 */
export const SOUND_CROWD_LIMIT = 8

/** The same sound again this soon is skipped (five people admitted at once chime once) */
export const SOUND_GAP_MS = 600

/** How loud, out of 1: quieter than anyone speaking */
const VOLUME = 0.08

type Note = { freq: number; at: number; length: number }

/** Each sound: a waveform and its notes (Hz, seconds from the start, seconds long) */
const TUNES: Record<SoundKind, { wave: OscillatorType; notes: Note[] }> = {
  // Up a sixth: someone arrived
  join: {
    wave: 'sine',
    notes: [
      { freq: 659.25, at: 0, length: 0.14 },
      { freq: 1046.5, at: 0.11, length: 0.22 },
    ],
  },
  // The same, down: someone left
  leave: {
    wave: 'sine',
    notes: [
      { freq: 1046.5, at: 0, length: 0.14 },
      { freq: 659.25, at: 0.11, length: 0.22 },
    ],
  },
  // Three rising notes, a little brighter: a hand went up
  hand: {
    wave: 'triangle',
    notes: [
      { freq: 783.99, at: 0, length: 0.16 },
      { freq: 987.77, at: 0.12, length: 0.16 },
      { freq: 1318.51, at: 0.24, length: 0.3 },
    ],
  },
  // A short blip: a message
  chat: {
    wave: 'sine',
    notes: [
      { freq: 1174.66, at: 0, length: 0.08 },
      { freq: 1567.98, at: 0.07, length: 0.14 },
    ],
  },
}

/** The part of AudioContext the sounds use, so tests can pass a fake */
export interface AudioContextLike {
  readonly currentTime: number
  readonly state: string
  readonly destination: AudioNode
  resume(): Promise<void>
  close(): Promise<void>
  createOscillator(): OscillatorNode
  createGain(): GainNode
  setSinkId?: (sinkId: string) => Promise<void>
}

export interface SoundsOptions {
  /** Makes the audio context on the first sound; null where Web Audio is missing */
  createContext?: () => AudioContextLike | null
  /** Whether the person has interacted with the page (navigator.userActivation, or a listener) */
  activated?: () => boolean
  now?: () => number
}

function defaultContext(): AudioContextLike | null {
  const Context =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (typeof Context !== 'function') return null
  try {
    return new Context()
  } catch {
    return null
  }
}

/** Set by the first pointer or key press, for browsers without navigator.userActivation */
let gestured = false
if (typeof window !== 'undefined') {
  const mark = () => {
    gestured = true
    window.removeEventListener('pointerdown', mark, true)
    window.removeEventListener('keydown', mark, true)
  }
  window.addEventListener('pointerdown', mark, true)
  window.addEventListener('keydown', mark, true)
}

function defaultActivated(): boolean {
  const activation = (globalThis.navigator as Navigator | undefined)?.userActivation
  return activation ? activation.hasBeenActive || gestured : gestured
}

/**
 * Plays the room's sounds. `play` says whether it did: not while off, not before the person has
 * interacted with the page, not where there is no Web Audio, not the same sound twice within
 * SOUND_GAP_MS. The audio context is made on the first sound that plays (after the gesture) and
 * kept; `close` lets it go.
 */
export class Sounds {
  private enabled = true
  private context: AudioContextLike | null = null
  private sink: string | null = null
  private readonly last = new Map<SoundKind, number>()
  private readonly createContext: () => AudioContextLike | null
  private readonly activated: () => boolean
  private readonly now: () => number

  constructor(options: SoundsOptions = {}) {
    this.createContext = options.createContext ?? defaultContext
    this.activated = options.activated ?? defaultActivated
    this.now = options.now ?? Date.now
  }

  play(kind: SoundKind): boolean {
    if (!this.enabled || !this.activated()) return false
    const now = this.now()
    const last = this.last.get(kind)
    if (last !== undefined && now - last < SOUND_GAP_MS) return false
    const context = this.ensureContext()
    if (!context) return false
    this.last.set(kind, now)
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    const { wave, notes } = TUNES[kind]
    const start = context.currentTime + 0.01
    for (const note of notes) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = wave
      oscillator.frequency.setValueAtTime(note.freq, start + note.at)
      // A soft attack and an exponential fade: no click at either end
      gain.gain.setValueAtTime(0.0001, start + note.at)
      gain.gain.exponentialRampToValueAtTime(VOLUME, start + note.at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(start + note.at)
      oscillator.stop(start + note.at + note.length + 0.02)
    }
    return true
  }

  /** 更多 › 音效 */
  setEnabled(on: boolean): void {
    this.enabled = on
  }

  /** The speaker chosen for the room (e2-t06), where the browser can send Web Audio to one */
  setSpeaker(deviceId: string | null): void {
    this.sink = deviceId
    if (this.context) this.applySink(this.context)
  }

  close(): void {
    const context = this.context
    this.context = null
    void context?.close().catch(() => undefined)
  }

  private ensureContext(): AudioContextLike | null {
    if (!this.context) {
      this.context = this.createContext()
      if (this.context) this.applySink(this.context)
    }
    return this.context
  }

  private applySink(context: AudioContextLike): void {
    if (this.sink === null || typeof context.setSinkId !== 'function') return
    void context.setSinkId(this.sink).catch(() => undefined)
  }
}

/** Join and leave sounds only while the room is small (SOUND_CROWD_LIMIT) */
export const crowdAllowsSound = (memberCount: number): boolean => memberCount <= SOUND_CROWD_LIMIT

// Who is speaking (e4-t05, AC-4.3): every tile's microphone (our own local track, the others'
// received tracks) read through one shared AudioContext on one timer, ten times a second, and
// turned into speaking / not speaking with a threshold and a 300 ms hold so the outline does not
// flicker between words. Listeners only hear about changes, so the tiles re-render rarely.
import {
  attachLevelMeter,
  browserAudioContext,
  type AudioContextLike,
  type LevelMeter,
} from './levelMeter.ts'

/** Level (0–1, levelMeter.ts: −60…0 dB) at or above which a microphone counts as speech, ≈ −39 dB */
export const SPEAKING_THRESHOLD = 0.35
/** Below the threshold this long before the outline goes (the 300 ms debounce, AC-4.3) */
export const SPEAKING_RELEASE_MS = 300
/** How often the levels are read */
export const SPEAKING_INTERVAL_MS = 100

export interface SpeakingState {
  speaking: boolean
  /** When the level dropped below the threshold, while it stays there */
  belowSince: number | null
}

export const QUIET: SpeakingState = { speaking: false, belowSince: null }

/**
 * The next state for a reading of `level` at `now` (ms): on at the first reading above the
 * threshold (the outline follows the voice at once), off only after SPEAKING_RELEASE_MS below it
 * (pauses between words keep it)
 */
export function nextSpeaking(state: SpeakingState, level: number, now: number): SpeakingState {
  if (level >= SPEAKING_THRESHOLD) return { speaking: true, belowSince: null }
  const belowSince = state.belowSince ?? now
  return { speaking: state.speaking && now - belowSince < SPEAKING_RELEASE_MS, belowSince }
}

export interface SpeakingMonitorOptions {
  createContext?: () => AudioContextLike | null
  /** The clock and the timer, for tests */
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  /** Skip the readings while the page is hidden (nobody sees the outline) */
  hidden?: () => boolean
}

interface Watch {
  stream: MediaStream
  meter: LevelMeter | null
  state: SpeakingState
  listeners: Set<(speaking: boolean) => void>
  /** Who wants the level itself, each reading (the participants panel's meters, e6-t08) */
  levels: Set<(level: number) => void>
}

const pageHidden = () => typeof document !== 'undefined' && document.hidden

/**
 * Reads the level of every watched audio track. One AudioContext while anything is watched
 * (closed when the last watcher leaves), one interval for all of them.
 */
export class SpeakingMonitor {
  private readonly options: Required<SpeakingMonitorOptions>
  private readonly watches = new Map<MediaStreamTrack, Watch>()
  private context: AudioContextLike | null = null
  private timer: unknown = null
  private unlock: (() => void) | null = null

  constructor(options: SpeakingMonitorOptions = {}) {
    this.options = {
      createContext: options.createContext ?? browserAudioContext,
      now: options.now ?? (() => performance.now()),
      setInterval: options.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms)),
      clearInterval:
        options.clearInterval ??
        ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>)),
      hidden: options.hidden ?? pageHidden,
    }
  }

  /** Calls `listener` whenever `track` starts or stops speaking; returns the unsubscribe */
  watch(track: MediaStreamTrack, listener: (speaking: boolean) => void): () => void {
    const watch = this.ensureWatch(track)
    if (!watch) return () => {}
    watch.listeners.add(listener)
    if (watch.state.speaking) listener(true)
    return () => {
      watch.listeners.delete(listener)
      this.release(track, watch)
    }
  }

  /**
   * Calls `listener` with `track`'s level (0–1) at every reading: the same analyser and timer as
   * the speaking outline, so a panel of meters adds no audio work; only while someone listens
   */
  watchLevel(track: MediaStreamTrack, listener: (level: number) => void): () => void {
    const watch = this.ensureWatch(track)
    if (!watch) return () => {}
    watch.levels.add(listener)
    return () => {
      watch.levels.delete(listener)
      this.release(track, watch)
    }
  }

  private ensureWatch(track: MediaStreamTrack): Watch | null {
    const existing = this.watches.get(track)
    if (existing) return existing
    if (typeof MediaStream === 'undefined') return null
    const stream = new MediaStream([track])
    const watch: Watch = {
      stream,
      meter: null,
      state: QUIET,
      listeners: new Set(),
      levels: new Set(),
    }
    this.watches.set(track, watch)
    const context = this.ensureContext()
    if (context) watch.meter = attachLevelMeter(context, stream)
    this.ensureTimer()
    return watch
  }

  private release(track: MediaStreamTrack, watch: Watch): void {
    if (watch.listeners.size > 0 || watch.levels.size > 0) return
    if (this.watches.get(track) !== watch) return
    watch.meter?.close()
    this.watches.delete(track)
    if (this.watches.size === 0) this.stop()
  }

  /** Reads every level once (the timer calls this) */
  tick(): void {
    if (this.options.hidden()) return
    const now = this.options.now()
    for (const watch of this.watches.values()) {
      const level = watch.meter?.read() ?? 0
      const next = nextSpeaking(watch.state, level, now)
      const changed = next.speaking !== watch.state.speaking
      watch.state = next
      for (const listener of watch.levels) listener(level)
      if (changed) for (const listener of watch.listeners) listener(next.speaking)
    }
  }

  private ensureContext(): AudioContextLike | null {
    if (this.context) return this.context
    const context = this.options.createContext()
    if (!context) return null
    this.context = context
    // Back in the room after a reload there was no click yet: the context waits for one
    if (context.state === 'suspended' && typeof window !== 'undefined') {
      const unlock = () => void context.resume?.().catch(() => {})
      window.addEventListener('pointerdown', unlock)
      window.addEventListener('keydown', unlock)
      this.unlock = () => {
        window.removeEventListener('pointerdown', unlock)
        window.removeEventListener('keydown', unlock)
      }
      unlock()
    }
    return context
  }

  private ensureTimer(): void {
    if (this.timer !== null) return
    this.timer = this.options.setInterval(() => this.tick(), SPEAKING_INTERVAL_MS)
  }

  private stop(): void {
    if (this.timer !== null) this.options.clearInterval(this.timer)
    this.timer = null
    this.unlock?.()
    this.unlock = null
    void this.context?.close().catch(() => {})
    this.context = null
  }
}

let shared: SpeakingMonitor | null = null

/** The page's one monitor */
export function speakingMonitor(): SpeakingMonitor {
  shared ??= new SpeakingMonitor()
  return shared
}

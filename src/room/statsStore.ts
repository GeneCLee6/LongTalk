import type { DownlinkState, UplinkState } from '../media/adaptation.ts'
import type { Layer } from '../media/MediaTransport.ts'
import type { SignalLevel } from '../media/quality.ts'
import type { StatsSample } from '../media/stats.ts'

/** What the stats panel shows (e2-t14): the latest sample and what the adaptation made of it */
export interface StatsSnapshot {
  sample: StatsSample
  /** The layer asked for per received camera or screen, by trackKey */
  layers: Readonly<Record<string, Layer>>
  signal: SignalLevel | null
  downlink: DownlinkState
  uplink: UplinkState
  /** Cameras not received to save the downlink (or in audio-only), by trackKey */
  paused: readonly string[]
  audioOnly: boolean
  /** HD wanted (e6-t04), and held back by the uplink */
  hd: boolean
  hdLimited: boolean
  /** 省電模式 (e6-t05) */
  powerSaving: boolean
}

/**
 * The latest connection statistics, apart from RoomMedia's state (e2-t13): a new sample every
 * STATS_POLL_MS would re-render the whole room page, so only what reads it (the stats panel,
 * while open) subscribes. One per page, across media sessions, like VideoDemandStore.
 */
export class StatsStore {
  #snapshot: StatsSnapshot | null = null
  readonly #listeners = new Set<() => void>()

  get = (): StatsSnapshot | null => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  set(snapshot: StatsSnapshot | null): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}

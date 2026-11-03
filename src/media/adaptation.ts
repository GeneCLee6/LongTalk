// Bandwidth adaptation (e2-t15, AC-2.7; ADR-001 「頻寬自適應」): two small state machines that
// RoomMedia steps once per stats interval (STATS_POLL_MS) with the interval's verdicts
// (quality.ts). Pure: no timers and no WebRTC, so the tests drive them with synthetic samples.
//
// Downlink, in the order AC-2.7 asks for, sound first throughout (audio is never touched):
// 1. `reduced`: lower the video budget that layers.ts chooses within (DOWNLINK_BUDGET_BPS at
//    first): to DECREASE of what is asked for now, never below what the lowest layers need. The
//    smallest tiles step down first (chooseLayers), so this is "降低畫質".
// 2. `videoCut`: every video is at its lowest layer and it is still poor: stop receiving the
//    cameras of everyone but the few RoomMedia is told to keep (the speaker, a pin, a spotlight)
//    and the screen; their tiles show initials. Realtime has no pause (ADR-001), so this is an
//    unsubscribe, and a subscribe again later.
// 3. `audioOnly`: still poor with the cameras cut: suggest audio-only (a banner; the member
//    decides, nothing is switched for them).
// Every step down waits for SETTLE_TICKS (the stats lag what was just changed) and needs
// POOR_TICKS poor intervals in a row. Recovery climbs back one stage per RECOVER_TICKS good
// intervals in a row (fair holds: neither counter moves), the budget growing by INCREASE; a
// relapse soon after a step up doubles the wait for the next one (up to MAX_RECOVER_TICKS), and
// a long stretch of `normal` resets it.
//
// Uplink: when the encoder of our camera or screen is held back by bandwidth or the SFU reports
// heavy loss for LIMIT_TICKS intervals in a row, stop sending the top layer (camera, then screen,
// then the camera's middle one: limitSendLayers); after RESTORE_TICKS clear ones (and, when the
// browser estimates the uplink, room for the layer), send it again. A restore that is followed
// by pressure within RELAPSE_TICKS doubles the next wait. A busy CPU only ever turns off the
// camera's top layer: the 720p encode is what costs, the small layers save little and a screen
// at half size loses its text (measured on CI, #31: a starved runner reports `cpu` for minutes,
// and going further left everyone at 180p).
import { SIMULCAST } from './encoding.ts'
import { DOWNLINK_BUDGET_BPS } from './layers.ts'
import type { Layer } from './MediaTransport.ts'
import type { SignalLevel } from './quality.ts'

export type DownlinkStage = 'normal' | 'reduced' | 'videoCut' | 'audioOnly'

export interface DownlinkState {
  stage: DownlinkStage
  /** The video budget layers.ts chooses within now */
  budgetBps: number
}

export interface DownlinkInput {
  verdict: SignalLevel
  /** What the chosen layers add up to now (each layer's bitrate cap, layers.ts) */
  askedBps: number
  /** What they would add up to with every received video at its lowest layer */
  floorBps: number
  /** Received videos (cameras and screens) */
  videos: number
}

export const POOR_TICKS = 2
export const SETTLE_TICKS = 2
export const RECOVER_TICKS = 5
export const MAX_RECOVER_TICKS = 30
/** A poor interval this soon after a step up is a relapse */
export const RELAPSE_TICKS = 10
/** This long in `normal` without trouble forgets earlier relapses */
export const CALM_TICKS = 30
export const DECREASE = 0.6
export const INCREASE = 1.6
export const INCREASE_BPS = 200_000

export class DownlinkAdaptation {
  readonly fullBudgetBps: number
  #state: DownlinkState
  #poor = 0
  #good = 0
  #settle = 0
  #recoverTicks = RECOVER_TICKS
  #sinceUp: number | null = null
  #calm = 0

  constructor(fullBudgetBps: number = DOWNLINK_BUDGET_BPS) {
    this.fullBudgetBps = fullBudgetBps
    this.#state = { stage: 'normal', budgetBps: fullBudgetBps }
  }

  get state(): DownlinkState {
    return this.#state
  }

  /** How many good intervals in a row the next step up needs */
  get recoverTicks(): number {
    return this.#recoverTicks
  }

  /** One interval; returns the state (the same object when nothing changed) */
  step(input: DownlinkInput): DownlinkState {
    if (this.#sinceUp !== null) this.#sinceUp += 1
    if (input.verdict === 'poor') {
      this.#good = 0
      this.#calm = 0
      this.#poor += 1
      // Trouble right after a step up: the next one waits longer
      if (this.#sinceUp !== null && this.#sinceUp <= RELAPSE_TICKS) {
        this.#recoverTicks = Math.min(MAX_RECOVER_TICKS, this.#recoverTicks * 2)
        this.#sinceUp = null
      }
    } else if (input.verdict === 'good') {
      this.#poor = 0
      this.#good += 1
    } else {
      this.#poor = 0
      this.#good = 0
    }
    if (this.#settle > 0) {
      this.#settle -= 1
      return this.#state
    }
    if (this.#state.stage === 'normal' && input.verdict !== 'poor') {
      this.#calm += 1
      if (this.#calm >= CALM_TICKS) this.#recoverTicks = RECOVER_TICKS
    }
    if (this.#poor >= POOR_TICKS) return this.#down(input)
    if (this.#good >= this.#recoverTicks) return this.#up()
    return this.#state
  }

  /** Back to the start (audio-only chosen, a new room) */
  reset(): void {
    this.#state = { stage: 'normal', budgetBps: this.fullBudgetBps }
    this.#poor = this.#good = this.#settle = this.#calm = 0
    this.#sinceUp = null
    this.#recoverTicks = RECOVER_TICKS
  }

  #set(state: DownlinkState): DownlinkState {
    this.#poor = 0
    this.#good = 0
    this.#settle = SETTLE_TICKS
    this.#state = state
    return state
  }

  #down(input: DownlinkInput): DownlinkState {
    const { stage, budgetBps } = this.#state
    if (stage === 'normal' || stage === 'reduced') {
      if (input.videos === 0) return this.#state
      if (input.askedBps > input.floorBps) {
        const budget = Math.max(input.floorBps, Math.min(budgetBps, input.askedBps) * DECREASE)
        return this.#set({ stage: 'reduced', budgetBps: Math.round(budget) })
      }
      return this.#set({ stage: 'videoCut', budgetBps })
    }
    if (stage === 'videoCut') return this.#set({ stage: 'audioOnly', budgetBps })
    return this.#state
  }

  #up(): DownlinkState {
    const { stage, budgetBps } = this.#state
    if (stage === 'normal') {
      this.#good = 0
      return this.#state
    }
    this.#sinceUp = 0
    if (stage === 'audioOnly') return this.#set({ stage: 'videoCut', budgetBps })
    if (stage === 'videoCut') return this.#set({ stage: 'reduced', budgetBps })
    const next = Math.round(budgetBps * INCREASE + INCREASE_BPS)
    if (next >= this.fullBudgetBps) {
      return this.#set({ stage: 'normal', budgetBps: this.fullBudgetBps })
    }
    return this.#set({ stage: 'reduced', budgetBps: next })
  }
}

// ── Uplink ────────────────────────────────────────────────────────────────────────────────────

/** The highest layer each of our videos sends; `high`: all of them */
export interface UplinkState {
  cam: Layer
  screen: Layer
}

export interface UplinkInput {
  /**
   * What holds the uplink back now: the encoder by bandwidth or the SFU's heavy loss reports
   * (`bandwidth`), the encoder by the CPU (`cpu`); null: nothing (quality.ts)
   */
  pressure: 'bandwidth' | 'cpu' | null
  /** Nothing holds the encoder back and loss is low */
  clear: boolean
  /** Which videos we send now (simulcast) */
  cam: boolean
  screen: boolean
  /** The browser's uplink estimate, bits per second; null when it gives none */
  availableBps: number | null
}

export const LIMIT_TICKS = 5
export const RESTORE_TICKS = 15
export const MAX_RESTORE_TICKS = 60

/** The order layers are turned off in (and back on in reverse) */
const UPLINK_STEPS: readonly { kind: 'cam' | 'screen'; to: Layer }[] = [
  { kind: 'cam', to: 'medium' },
  { kind: 'screen', to: 'medium' },
  { kind: 'cam', to: 'low' },
]

const sendsBps = (kind: 'cam' | 'screen', highest: Layer): number => {
  const order: Record<Layer, number> = { high: 2, medium: 1, low: 0 }
  return SIMULCAST[kind]
    .filter((layer) => order[layer.layer] <= order[highest])
    .reduce((sum, layer) => sum + layer.maxBitrate, 0)
}

export const FULL_UPLINK: UplinkState = { cam: 'high', screen: 'high' }

export class UplinkAdaptation {
  #state: UplinkState = FULL_UPLINK
  /** How many of UPLINK_STEPS are applied */
  #steps = 0
  #pressure = 0
  /** Some interval of the current run of pressure was bandwidth, not only the CPU */
  #bandwidth = false
  #clear = 0
  #restoreTicks = RESTORE_TICKS
  #sinceRestore: number | null = null

  get state(): UplinkState {
    return this.#state
  }

  step(input: UplinkInput): UplinkState {
    if (this.#sinceRestore !== null) this.#sinceRestore += 1
    if (input.pressure) {
      this.#clear = 0
      this.#pressure += 1
      if (input.pressure === 'bandwidth') this.#bandwidth = true
      if (this.#sinceRestore !== null && this.#sinceRestore <= RELAPSE_TICKS) {
        this.#restoreTicks = Math.min(MAX_RESTORE_TICKS, this.#restoreTicks * 2)
        this.#sinceRestore = null
      }
    } else {
      this.#pressure = 0
      this.#bandwidth = false
      this.#clear = input.clear ? this.#clear + 1 : 0
    }
    if (this.#pressure >= LIMIT_TICKS) {
      this.#pressure = 0
      const bandwidth = this.#bandwidth
      this.#bandwidth = false
      // The CPU: the camera's top layer and nothing else
      if (!bandwidth) {
        if (this.#steps > 0 || !input.cam) return this.#state
        this.#steps = 1
        return this.#apply()
      }
      // The next step that applies to a video we send
      for (let i = this.#steps; i < UPLINK_STEPS.length; i++) {
        const step = UPLINK_STEPS[i]
        this.#steps = i + 1
        if (input[step.kind]) return this.#apply()
      }
      return this.#state
    }
    if (this.#steps > 0 && this.#clear >= this.#restoreTicks) {
      this.#clear = 0
      const next = this.#steps - 1
      const restored = { ...this.#target(next) }
      // Room for it on the uplink, where the browser says how much there is
      const needs =
        (input.cam ? sendsBps('cam', restored.cam) : 0) +
        (input.screen ? sendsBps('screen', restored.screen) : 0)
      if (input.availableBps !== null && input.availableBps < needs) return this.#state
      this.#steps = next
      this.#sinceRestore = 0
      return this.#apply()
    }
    return this.#state
  }

  reset(): void {
    this.#state = FULL_UPLINK
    this.#steps = this.#pressure = this.#clear = 0
    this.#bandwidth = false
    this.#restoreTicks = RESTORE_TICKS
    this.#sinceRestore = null
  }

  #target(steps: number): UplinkState {
    const state = { ...FULL_UPLINK }
    for (const step of UPLINK_STEPS.slice(0, steps)) state[step.kind] = step.to
    return state
  }

  #apply(): UplinkState {
    const next = this.#target(this.#steps)
    if (next.cam !== this.#state.cam || next.screen !== this.#state.screen) this.#state = next
    return this.#state
  }
}

import { describe, expect, it } from 'vitest'
import {
  CALM_TICKS,
  DownlinkAdaptation,
  LIMIT_TICKS,
  MAX_RECOVER_TICKS,
  POOR_TICKS,
  RECOVER_TICKS,
  RESTORE_TICKS,
  SETTLE_TICKS,
  UplinkAdaptation,
  type DownlinkInput,
  type UplinkInput,
} from '../../../src/media/adaptation.ts'
import { DOWNLINK_BUDGET_BPS } from '../../../src/media/layers.ts'
import {
  connectionVerdict,
  downlinkVerdict,
  encoderLimited,
  SignalMeter,
  uplinkVerdict,
} from '../../../src/media/quality.ts'
import type { InboundSample, OutboundSample, StatsSample } from '../../../src/media/stats.ts'
import type { SignalLevel } from '../../../shared/protocol.ts'

// Synthetic samples: what a link of a given quality looks like over one 2 s interval

function inbound(media: 'audio' | 'video', over: Partial<InboundSample> = {}): InboundSample {
  return {
    sessionId: 'bob',
    trackName: `${media}-1`,
    media,
    codec: media === 'video' ? 'VP8' : 'opus',
    bps: media === 'video' ? 400_000 : 32_000,
    lossRate: 0,
    packets: media === 'video' ? 200 : 100,
    lost: 0,
    jitterMs: 5,
    width: media === 'video' ? 640 : null,
    height: media === 'video' ? 360 : null,
    fps: media === 'video' ? 30 : null,
    framesDropped: 0,
    freezes: 0,
    freezeMs: 0,
    jitterBufferMs: 60,
    concealedRatio: media === 'audio' ? 0 : null,
    ...over,
  }
}

function outbound(
  kind: OutboundSample['kind'],
  over: Partial<OutboundSample> = {},
): OutboundSample {
  return {
    trackName: `${kind}-1`,
    kind,
    codec: null,
    bps: 100_000,
    lossRate: 0,
    qualityLimitationReason: kind === 'cam' || kind === 'screen' ? 'none' : null,
    layers: [],
    ...over,
  }
}

function sample(over: Partial<StatsSample> = {}): StatsSample {
  return {
    at: 2000,
    intervalMs: 2000,
    rttMs: 40,
    usingRelay: false,
    candidateType: 'srflx',
    protocol: 'udp',
    availableOutgoingBitrate: null,
    sendBps: 500_000,
    receiveBps: 1_000_000,
    outbound: [outbound('mic'), outbound('cam')],
    inbound: [inbound('audio'), inbound('video')],
    ...over,
  }
}

/** A video losing `rate` of its packets */
const lossy = (rate: number, over: Partial<InboundSample> = {}) =>
  inbound('video', {
    packets: Math.round(200 * (1 - rate)),
    lost: Math.round(200 * rate),
    lossRate: rate,
    ...over,
  })

describe('downlinkVerdict (e2-t15)', () => {
  it('is good on a clean link', () => {
    expect(downlinkVerdict(sample())).toBe('good')
  })

  it('judges video loss by its share of the packets', () => {
    expect(downlinkVerdict(sample({ inbound: [inbound('audio'), lossy(0.02)] }))).toBe('fair')
    expect(downlinkVerdict(sample({ inbound: [inbound('audio'), lossy(0.06)] }))).toBe('poor')
  })

  it('does not judge loss from a handful of packets', () => {
    const few = inbound('video', { packets: 18, lost: 2, lossRate: 0.1 })
    expect(downlinkVerdict(sample({ inbound: [few] }))).toBe('good')
  })

  it('weighs audio: loss, concealment and a deep jitter buffer', () => {
    const audio = (over: Partial<InboundSample>) => sample({ inbound: [inbound('audio', over)] })
    expect(downlinkVerdict(audio({ packets: 94, lost: 6 }))).toBe('poor')
    expect(downlinkVerdict(audio({ concealedRatio: 0.04 }))).toBe('fair')
    expect(downlinkVerdict(audio({ concealedRatio: 0.1 }))).toBe('poor')
    expect(downlinkVerdict(audio({ jitterBufferMs: 250 }))).toBe('fair')
    expect(downlinkVerdict(audio({ jitterBufferMs: 450 }))).toBe('poor')
    expect(downlinkVerdict(audio({ jitterMs: 45 }))).toBe('fair')
  })

  it('counts freezes only with some loss: without it the sender is to blame', () => {
    const frozen = (rate: number) =>
      sample({ inbound: [lossy(rate, { freezes: 2, freezeMs: 800 })] })
    expect(downlinkVerdict(frozen(0))).toBe('good')
    expect(downlinkVerdict(frozen(0.01))).toBe('poor')
    const once = sample({ inbound: [lossy(0.01, { freezes: 1, freezeMs: 200 })] })
    expect(downlinkVerdict(once)).toBe('fair')
  })

  it('compares the decoded frame rate with the layer’s, together with loss', () => {
    const slow = (rate: number) => sample({ inbound: [lossy(rate, { fps: 10 })] })
    const expected = () => 30
    expect(downlinkVerdict(slow(0), expected)).toBe('good')
    expect(downlinkVerdict(slow(0.012), expected)).toBe('fair')
    // Without an expected rate (a screen, or no layer yet) the frame rate is not judged
    expect(downlinkVerdict(slow(0.012))).toBe('good')
  })
})

describe('uplinkVerdict, encoderLimited, connectionVerdict', () => {
  it('reads a held-back encoder and the SFU’s loss reports', () => {
    const limited = sample({
      outbound: [outbound('cam', { qualityLimitationReason: 'bandwidth' })],
    })
    expect(encoderLimited(limited)).toBe(true)
    expect(uplinkVerdict(limited)).toBe('fair')
    expect(
      encoderLimited(sample({ outbound: [outbound('cam', { qualityLimitationReason: 'cpu' })] })),
    ).toBe(true)
    expect(uplinkVerdict(sample({ outbound: [outbound('cam', { lossRate: 0.12 })] }))).toBe('poor')
    expect(uplinkVerdict(sample({ outbound: [outbound('mic', { lossRate: 0.06 })] }))).toBe('poor')
    expect(uplinkVerdict(sample())).toBe('good')
  })

  it('takes the worst of the two directions and the round trip', () => {
    expect(connectionVerdict(sample({ rttMs: 350 }))).toBe('fair')
    expect(connectionVerdict(sample({ rttMs: 900 }))).toBe('poor')
    expect(connectionVerdict(sample({ inbound: [lossy(0.06)] }))).toBe('poor')
  })
})

describe('SignalMeter (e2-t13)', () => {
  it('needs two bad intervals of three, so one spike does not flash 差', () => {
    const meter = new SignalMeter()
    expect(meter.push('good')).toBe('good')
    expect(meter.push('poor')).toBe('good')
    expect(meter.push('good')).toBe('good')
    expect(meter.push('poor')).toBe('poor')
    expect(meter.push('fair')).toBe('fair')
    expect(meter.push('good')).toBe('fair')
    expect(meter.push('good')).toBe('good')
  })

  it('reads the first interval as it is', () => {
    expect(new SignalMeter().push('poor')).toBe('poor')
  })
})

// ── The downlink's state machine ─────────────────────────────────────────────────────────────

/** Four cameras at medium (400 kbps each), floor 4 × 120 kbps */
const grid = (over: Partial<DownlinkInput> = {}): DownlinkInput => ({
  verdict: 'good',
  askedBps: 1_600_000,
  floorBps: 480_000,
  videos: 4,
  ...over,
})

/** Steps `machine` `n` times with the same input and gives the stages it went through */
function run(machine: DownlinkAdaptation, n: number, input: DownlinkInput) {
  const stages: string[] = []
  for (let i = 0; i < n; i++) stages.push(machine.step(input).stage)
  return stages
}

describe('DownlinkAdaptation (e2-t15)', () => {
  it('leaves a good link alone', () => {
    const machine = new DownlinkAdaptation()
    expect(run(machine, 50, grid())).toEqual(Array(50).fill('normal'))
    expect(machine.state.budgetBps).toBe(DOWNLINK_BUDGET_BPS)
  })

  it('needs poor intervals in a row: one, between fair ones, does nothing', () => {
    const machine = new DownlinkAdaptation()
    for (const verdict of ['poor', 'fair', 'poor', 'good', 'poor'] as SignalLevel[]) {
      machine.step(grid({ verdict }))
    }
    expect(machine.state.stage).toBe('normal')
  })

  it('lowers the budget first, then cuts the cameras, then suggests audio-only', () => {
    const machine = new DownlinkAdaptation()
    const poor = grid({ verdict: 'poor' })
    run(machine, POOR_TICKS, poor)
    expect(machine.state).toEqual({ stage: 'reduced', budgetBps: 960_000 })
    // The stats lag what changed: nothing more while it settles
    run(machine, SETTLE_TICKS, grid({ verdict: 'poor', askedBps: 960_000 }))
    expect(machine.state.budgetBps).toBe(960_000)
    run(machine, 1, grid({ verdict: 'poor', askedBps: 960_000 }))
    // Never below what the lowest layers need
    expect(machine.state).toEqual({ stage: 'reduced', budgetBps: 576_000 })
    run(machine, SETTLE_TICKS + 1, grid({ verdict: 'poor', askedBps: 560_000 }))
    expect(machine.state).toEqual({ stage: 'reduced', budgetBps: 480_000 })
    // Every video at its lowest layer and still poor: cut
    run(machine, SETTLE_TICKS + 1, grid({ verdict: 'poor', askedBps: 480_000 }))
    expect(machine.state.stage).toBe('videoCut')
    run(machine, SETTLE_TICKS + 1, grid({ verdict: 'poor', askedBps: 120_000, videos: 1 }))
    expect(machine.state.stage).toBe('audioOnly')
    // It stops there: the member decides
    run(machine, 20, grid({ verdict: 'poor' }))
    expect(machine.state.stage).toBe('audioOnly')
  })

  it('does nothing about a poor link with no video to lower (audio alone)', () => {
    const machine = new DownlinkAdaptation()
    run(machine, 10, grid({ verdict: 'poor', askedBps: 0, floorBps: 0, videos: 0 }))
    expect(machine.state.stage).toBe('normal')
  })

  it('climbs back one stage per run of good intervals; fair holds', () => {
    const machine = new DownlinkAdaptation()
    // Down to the cut
    for (let i = 0; i < 30 && machine.state.stage !== 'videoCut'; i++) {
      machine.step(
        grid({ verdict: 'poor', askedBps: Math.min(1_600_000, machine.state.budgetBps) }),
      )
    }
    expect(machine.state.stage).toBe('videoCut')
    const cut = machine.state.budgetBps
    // Fair intervals in between keep it where it is (the good ones count while it settles)
    run(machine, RECOVER_TICKS - 1, grid({ verdict: 'good' }))
    run(machine, 1, grid({ verdict: 'fair' }))
    run(machine, RECOVER_TICKS - 1, grid({ verdict: 'good' }))
    expect(machine.state.stage).toBe('videoCut')
    run(machine, 1, grid({ verdict: 'good' }))
    // Back to receiving everyone, at the budget it had
    expect(machine.state).toEqual({ stage: 'reduced', budgetBps: cut })
    const budgets: number[] = []
    for (let i = 0; i < 60 && machine.state.stage !== 'normal'; i++) {
      machine.step(grid())
      budgets.push(machine.state.budgetBps)
    }
    expect(machine.state).toEqual({ stage: 'normal', budgetBps: DOWNLINK_BUDGET_BPS })
    // It grew in steps, never down
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b))
    expect(new Set(budgets).size).toBeGreaterThan(3)
  })

  it('waits longer after a relapse, and forgets it after a calm stretch', () => {
    const machine = new DownlinkAdaptation()
    const poor = grid({ verdict: 'poor' })
    run(machine, POOR_TICKS, poor)
    expect(machine.state.stage).toBe('reduced')
    run(machine, SETTLE_TICKS + RECOVER_TICKS, grid())
    // Climbed a step; trouble right after
    run(machine, 1, poor)
    expect(machine.recoverTicks).toBe(RECOVER_TICKS * 2)
    for (let i = 0; i < 10; i++) run(machine, 1, poor)
    for (let i = 0; i < 400 && machine.state.stage !== 'normal'; i++) machine.step(grid())
    expect(machine.state.stage).toBe('normal')
    expect(machine.recoverTicks).toBeLessThanOrEqual(MAX_RECOVER_TICKS)
    run(machine, SETTLE_TICKS + CALM_TICKS, grid())
    expect(machine.recoverTicks).toBe(RECOVER_TICKS)
  })

  it('caps the wait however often it relapses', () => {
    const machine = new DownlinkAdaptation()
    for (let round = 0; round < 10; round++) {
      run(machine, POOR_TICKS + SETTLE_TICKS, grid({ verdict: 'poor' }))
      for (let i = 0; i < 200 && machine.recoverTicks > 0; i++) {
        const before = machine.state
        machine.step(grid())
        if (machine.state !== before) break
      }
    }
    expect(machine.recoverTicks).toBe(MAX_RECOVER_TICKS)
  })

  it('starts over on reset', () => {
    const machine = new DownlinkAdaptation()
    run(machine, POOR_TICKS, grid({ verdict: 'poor' }))
    machine.reset()
    expect(machine.state).toEqual({ stage: 'normal', budgetBps: DOWNLINK_BUDGET_BPS })
  })
})

// ── The uplink's ─────────────────────────────────────────────────────────────────────────────

const up = (over: Partial<UplinkInput> = {}): UplinkInput => ({
  pressure: false,
  clear: true,
  cam: true,
  screen: false,
  availableBps: null,
  ...over,
})

describe('UplinkAdaptation (e2-t15)', () => {
  it('turns the camera’s top layer off after a run of pressure, then the middle one', () => {
    const machine = new UplinkAdaptation()
    for (let i = 0; i < LIMIT_TICKS - 1; i++) machine.step(up({ pressure: true, clear: false }))
    expect(machine.state).toEqual({ cam: 'high', screen: 'high' })
    machine.step(up({ pressure: true, clear: false }))
    expect(machine.state).toEqual({ cam: 'medium', screen: 'high' })
    for (let i = 0; i < LIMIT_TICKS; i++) machine.step(up({ pressure: true, clear: false }))
    // No screen to lower: the camera's middle layer goes next
    expect(machine.state).toEqual({ cam: 'low', screen: 'medium' })
  })

  it('lowers the screen before the camera’s middle layer while sharing', () => {
    const machine = new UplinkAdaptation()
    const pressed = up({ pressure: true, clear: false, screen: true })
    for (let i = 0; i < LIMIT_TICKS * 2; i++) machine.step(pressed)
    expect(machine.state).toEqual({ cam: 'medium', screen: 'medium' })
  })

  it('sends the layers again after a clear stretch, one at a time', () => {
    const machine = new UplinkAdaptation()
    for (let i = 0; i < LIMIT_TICKS; i++) machine.step(up({ pressure: true, clear: false }))
    for (let i = 0; i < RESTORE_TICKS - 1; i++) machine.step(up())
    expect(machine.state.cam).toBe('medium')
    machine.step(up())
    expect(machine.state.cam).toBe('high')
  })

  it('waits for room on the uplink when the browser estimates it', () => {
    const machine = new UplinkAdaptation()
    for (let i = 0; i < LIMIT_TICKS; i++) machine.step(up({ pressure: true, clear: false }))
    for (let i = 0; i < RESTORE_TICKS * 3; i++) machine.step(up({ availableBps: 600_000 }))
    expect(machine.state.cam).toBe('medium')
    for (let i = 0; i < RESTORE_TICKS; i++) machine.step(up({ availableBps: 3_000_000 }))
    expect(machine.state.cam).toBe('high')
  })

  it('doubles the wait when the restored layer brings the pressure back', () => {
    const machine = new UplinkAdaptation()
    const pressed = up({ pressure: true, clear: false })
    for (let i = 0; i < LIMIT_TICKS; i++) machine.step(pressed)
    for (let i = 0; i < RESTORE_TICKS; i++) machine.step(up())
    expect(machine.state.cam).toBe('high')
    for (let i = 0; i < LIMIT_TICKS; i++) machine.step(pressed)
    expect(machine.state.cam).toBe('medium')
    for (let i = 0; i < RESTORE_TICKS; i++) machine.step(up())
    expect(machine.state.cam).toBe('medium')
    for (let i = 0; i < RESTORE_TICKS; i++) machine.step(up())
    expect(machine.state.cam).toBe('high')
  })

  it('needs every interval clear: one that is neither pressed nor clear starts the count again', () => {
    const machine = new UplinkAdaptation()
    for (let i = 0; i < LIMIT_TICKS; i++) machine.step(up({ pressure: true, clear: false }))
    for (let i = 0; i < RESTORE_TICKS - 1; i++) machine.step(up())
    machine.step(up({ clear: false }))
    for (let i = 0; i < RESTORE_TICKS - 1; i++) machine.step(up())
    expect(machine.state.cam).toBe('medium')
  })
})

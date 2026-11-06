import { describe, expect, it } from 'vitest'
import { readStatsReport, sampleStats, type StatsOwners } from '../../../src/media/stats.ts'

const owners: StatsOwners = {
  published: new Map([
    ['0', { trackName: 'mic-1', kind: 'mic' as const }],
    ['1', { trackName: 'cam-1', kind: 'cam' as const }],
  ]),
  subscribed: new Map([
    ['5', { sessionId: 'bob', trackName: 'cam-b' }],
    ['6', { sessionId: 'bob', trackName: 'mic-b' }],
  ]),
}

/** A report like Chrome's at one moment, with counters scaled by `n` */
function report(n: number, options: { relay?: boolean; lost?: number; freezes?: number } = {}) {
  return [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    {
      id: 'P',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      currentRoundTripTime: 0.08,
      availableOutgoingBitrate: 2_000_000,
      bytesSent: 100_000 * n,
      bytesReceived: 400_000 * n,
      localCandidateId: 'L',
    },
    // A pair that is not the selected one: ignored
    {
      id: 'P2',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      currentRoundTripTime: 1,
      localCandidateId: 'L2',
    },
    options.relay
      ? {
          id: 'L',
          type: 'local-candidate',
          candidateType: 'relay',
          protocol: 'udp',
          relayProtocol: 'tls',
        }
      : { id: 'L', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
    { id: 'L2', type: 'local-candidate', candidateType: 'host' },
    { id: 'C8', type: 'codec', mimeType: 'video/VP8' },
    { id: 'CO', type: 'codec', mimeType: 'audio/opus' },
    {
      id: 'om',
      type: 'outbound-rtp',
      kind: 'audio',
      mid: '0',
      bytesSent: 4_000 * n,
      packetsSent: 50 * n,
      codecId: 'CO',
    },
    {
      id: 'of',
      type: 'outbound-rtp',
      kind: 'video',
      mid: '1',
      rid: 'f',
      active: false,
      bytesSent: 0,
      packetsSent: 0,
      codecId: 'C8',
      qualityLimitationReason: 'bandwidth',
    },
    {
      id: 'oh',
      type: 'outbound-rtp',
      kind: 'video',
      mid: '1',
      rid: 'h',
      bytesSent: 50_000 * n,
      packetsSent: 100 * n,
      frameWidth: 640,
      frameHeight: 360,
      framesPerSecond: 30,
      codecId: 'C8',
      qualityLimitationReason: 'cpu',
    },
    { id: 'rh', type: 'remote-inbound-rtp', localId: 'oh', packetsLost: 2 * n, fractionLost: 0.02 },
    {
      id: 'ic',
      type: 'inbound-rtp',
      kind: 'video',
      mid: '5',
      codecId: 'C8',
      bytesReceived: 300_000 * n,
      packetsReceived: 300 * n,
      packetsLost: (options.lost ?? 0) * n,
      frameWidth: 1280,
      frameHeight: 720,
      framesPerSecond: 29,
      framesDecoded: 60 * n,
      framesDropped: n,
      freezeCount: options.freezes ?? 0,
      totalFreezesDuration: (options.freezes ?? 0) * 0.5,
      jitter: 0.012,
    },
    {
      id: 'ia',
      type: 'inbound-rtp',
      kind: 'audio',
      mid: '6',
      codecId: 'CO',
      bytesReceived: 8_000 * n,
      packetsReceived: 100 * n,
      packetsLost: 0,
      jitter: 0.004,
      jitterBufferDelay: 6 * n,
      jitterBufferEmittedCount: 100 * n,
      concealedSamples: 480 * n,
      silentConcealedSamples: 0,
      totalSamplesReceived: 96_000 * n,
    },
  ]
}

describe('readStatsReport (e2-t13)', () => {
  it('summarises the selected pair, the path and each track by its owner', () => {
    const stats = readStatsReport(report(1, { relay: true }), owners, 1000)
    expect(stats).toMatchObject({
      timestamp: 1000,
      rttMs: 80,
      usingRelay: true,
      candidateType: 'relay',
      protocol: 'tls',
      bytesSent: 100_000,
      bytesReceived: 400_000,
      availableOutgoingBitrate: 2_000_000,
    })
    const cam = stats.outbound.find((t) => t.trackName === 'cam-1')!
    expect(cam).toMatchObject({ kind: 'cam', codec: 'VP8', packetsLost: 2, fractionLost: 0.02 })
    expect(cam.layers.map((l) => [l.rid, l.active])).toEqual([
      ['f', false],
      ['h', true],
    ])
    expect(stats.outbound.find((t) => t.trackName === 'mic-1')?.codec).toBe('opus')
    expect(stats.inbound.map((t) => [t.trackName, t.media, t.codec])).toEqual([
      ['cam-b', 'video', 'VP8'],
      ['mic-b', 'audio', 'opus'],
    ])
  })

  it('says direct when the selected local candidate is not a relay', () => {
    expect(readStatsReport(report(1), owners)).toMatchObject({
      usingRelay: false,
      candidateType: 'srflx',
      protocol: 'udp',
    })
  })

  it('falls back to the nominated pair that succeeded when there is no transport entry', () => {
    const entries = report(1).filter((e) => e.type !== 'transport' && e.id !== 'P2')
    expect(readStatsReport(entries, owners).rttMs).toBe(80)
  })

  it('has nothing to say about an empty report', () => {
    expect(readStatsReport([], owners)).toMatchObject({
      rttMs: null,
      usingRelay: false,
      outbound: [],
      inbound: [],
    })
  })
})

describe('sampleStats (e2-t13)', () => {
  it('turns two readings into rates, loss, freezes and the jitter buffer over the interval', () => {
    const before = readStatsReport(report(1, { lost: 3 }), owners, 0)
    const after = readStatsReport(report(2, { lost: 3, freezes: 2 }), owners, 2000)
    const sample = sampleStats(before, after)
    expect(sample.intervalMs).toBe(2000)
    expect(sample.receiveBps).toBe(1_600_000)
    expect(sample.sendBps).toBe(400_000)
    const cam = sample.inbound.find((t) => t.trackName === 'cam-b')!
    expect(cam.bps).toBe(1_200_000)
    expect(cam.lossRate).toBeCloseTo(3 / 303)
    expect(cam).toMatchObject({
      packets: 300,
      lost: 3,
      freezes: 2,
      freezeMs: 1000,
      framesDropped: 1,
    })
    expect(cam.jitterMs).toBeCloseTo(12)
    const mic = sample.inbound.find((t) => t.trackName === 'mic-b')!
    expect(mic.jitterBufferMs).toBeCloseTo(60)
    expect(mic.concealedRatio).toBeCloseTo(0.005)
    const out = sample.outbound.find((t) => t.trackName === 'cam-1')!
    expect(out.lossRate).toBeCloseTo(0.02)
    // The layer still sending is held back by the CPU; the one turned off does not count
    expect(out.qualityLimitationReason).toBe('cpu')
    expect(out.layers.find((l) => l.rid === 'h')?.bps).toBe(200_000)
  })

  it('has no rates on the first reading, and starts afresh when a counter went back', () => {
    const first = sampleStats(null, readStatsReport(report(3), owners, 0))
    expect(first.intervalMs).toBe(0)
    expect(first.receiveBps).toBeNull()
    expect(first.inbound.every((t) => t.bps === null && t.lossRate === null)).toBe(true)
    const again = sampleStats(
      readStatsReport(report(3), owners, 0),
      readStatsReport(report(1), owners, 2000),
    )
    expect(again.inbound.find((t) => t.trackName === 'cam-b')?.bps).toBeNull()
  })
})

describe('a muted microphone (L1)', () => {
  const report = (packets: number, concealed: number, silent: number, samples: number) =>
    readStatsReport(
      [
        {
          type: 'inbound-rtp',
          kind: 'audio',
          mid: '1',
          packetsReceived: packets,
          concealedSamples: concealed,
          silentConcealedSamples: silent,
          totalSamplesReceived: samples,
        },
      ],
      { published: new Map(), subscribed: new Map([['1', { sessionId: 's', trackName: 'mic' }]]) },
      samples,
    )

  it('is not concealment: nothing arrives, and the browser fills it with silence', () => {
    const sample = sampleStats(report(100, 0, 0, 96_000), report(100, 96_000, 96_000, 192_000))
    expect(sample.inbound[0].concealedRatio).toBeNull()
  })

  it('the interval it was muted in does not count its silence either', () => {
    const sample = sampleStats(report(100, 0, 0, 96_000), report(103, 48_000, 47_000, 192_000))
    expect(sample.inbound[0].concealedRatio).toBeCloseTo(1_000 / 96_000)
  })

  it('real concealment still counts', () => {
    const sample = sampleStats(report(100, 0, 0, 96_000), report(150, 48_000, 0, 192_000))
    expect(sample.inbound[0].concealedRatio).toBeCloseTo(0.5)
  })
})

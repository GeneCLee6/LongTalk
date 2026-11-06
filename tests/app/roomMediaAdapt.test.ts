import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, MemberTrack } from '../../shared/protocol.ts'
import { FakeSfu, type FakeTransport } from '../../src/media/FakeTransport.ts'
import type { InboundTrackStats, OutboundTrackStats } from '../../src/media/MediaTransport.ts'
import { KEEP_HOLD_MS, RoomMedia, STATS_POLL_MS } from '../../src/room/RoomMedia.ts'
import { StatsStore } from '../../src/room/statsStore.ts'
import { VideoDemandStore } from '../../src/room/videoDemand.ts'

// H2 (e2-t13, e2-t15): RoomMedia reads getStats() every STATS_POLL_MS, reports its signal level
// to the room, keeps the stats panel's store, and adapts what it receives and sends. The link is
// simulated through FakeTransport's stats: counters that grow every reading, with a loss rate the
// test turns up and down.

const fakeTrack = (kind: 'audio' | 'video') =>
  ({ kind, applyConstraints: vi.fn(async () => {}) }) as unknown as MediaStreamTrack

function listed(sent: ClientMessage[]): MemberTrack[] {
  const last = sent.filter((s) => s.t === 'tracks').at(-1)
  if (last?.t !== 'tracks') return []
  return last.tracks.map((t) => ({ sessionId: last.sessionId, ...t }))
}

/** A downlink losing `link.loss` of every track's packets, read by `transport.getStats()` */
function simulateDownlink(transport: FakeTransport, link: { loss: number }) {
  const counters = new Map<string, InboundTrackStats>()
  transport.stats = () => ({
    inbound: [...transport.subscriptions.values()].map((sub) => {
      const key = `${sub.sessionId}/${sub.trackName}`
      const media = sub.trackName.startsWith('cam') || sub.trackName.startsWith('screen')
      const was = counters.get(key)
      const n = media ? 200 : 100
      const lost = Math.round(n * link.loss)
      const next: InboundTrackStats = {
        sessionId: sub.sessionId,
        trackName: sub.trackName,
        media: media ? 'video' : 'audio',
        codec: media ? 'VP8' : 'opus',
        bytesReceived: (was?.bytesReceived ?? 0) + n * 1000,
        packetsReceived: (was?.packetsReceived ?? 0) + n - lost,
        packetsLost: (was?.packetsLost ?? 0) + lost,
        jitter: 0.005,
        width: media ? 640 : null,
        height: media ? 360 : null,
        fps: media ? 30 : null,
        framesDecoded: (was?.framesDecoded ?? 0) + (media ? 60 : 0),
        framesDropped: 0,
        freezeCount: 0,
        totalFreezesDuration: 0,
        jitterBufferDelay: (was?.jitterBufferDelay ?? 0) + n * 0.05,
        jitterBufferEmittedCount: (was?.jitterBufferEmittedCount ?? 0) + n,
        concealedSamples: 0,
        silentConcealedSamples: 0,
        totalSamplesReceived: (was?.totalSamplesReceived ?? 0) + (media ? 0 : 96_000),
      }
      counters.set(key, next)
      return next
    }),
  })
}

/** An uplink whose camera encoder is held back for `link.reason` */
function simulateUplink(transport: FakeTransport, link: { reason: string }) {
  let sent = 0
  transport.stats = () => {
    sent += 100
    const outbound: OutboundTrackStats[] = [...transport.sending.keys()]
      .filter((name) => name.startsWith('cam'))
      .map((trackName) => ({
        trackName,
        kind: 'cam',
        codec: 'VP8',
        bytesSent: sent * 1000,
        packetsSent: sent,
        packetsLost: 0,
        fractionLost: 0,
        layers: [
          {
            rid: 'f',
            active: true,
            bytesSent: sent * 1000,
            packetsSent: sent,
            framesEncoded: sent,
            width: 1280,
            height: 720,
            fps: 30,
            qualityLimitationReason: link.reason,
          },
        ],
      }))
    return { outbound }
  }
}

/** Three members with a microphone and a camera, and Bob who receives them */
async function room() {
  const sfu = new FakeSfu()
  const publishers = await Promise.all(
    ['alice', 'carol', 'dave'].map(async () => {
      const sent: ClientMessage[] = []
      const transport = sfu.createTransport()
      const media = new RoomMedia({ transport, send: (m) => sent.push(m), adapt: false })
      const cam = fakeTrack('video')
      await media.start({ mic: fakeTrack('audio'), cam })
      return { sent, transport, media, cam }
    }),
  )
  const demand = new VideoDemandStore()
  const stats = new StatsStore()
  const bobTransport = sfu.createTransport()
  const bobSent: ClientMessage[] = []
  const bob = new RoomMedia({
    transport: bobTransport,
    send: (m) => bobSent.push(m),
    demand,
    stats,
    layerDebounceMs: 10,
  })
  await bob.start({ mic: null, cam: null })
  bob.setDesired(publishers.flatMap((p) => listed(p.sent)))
  await vi.advanceTimersByTimeAsync(0)
  // Every camera in a grid tile of 640×360: medium
  for (const p of publishers) {
    demand.report(p.cam, {}, { width: 640, height: 360, visible: true, aspect: 16 / 9 })
  }
  await vi.advanceTimersByTimeAsync(50)
  const camKeys = publishers.map((p) => `${p.transport.sessionId}/${listed(p.sent)[1].trackName}`)
  return { sfu, publishers, bob, bobTransport, bobSent, stats, camKeys }
}

const received = (media: RoomMedia, kind: string) =>
  Object.values(media.getState().received).filter((r) => r.kind === kind).length

/** Polls until `done` (at most `limit` intervals); how many it took */
async function until(done: () => boolean, limit = 200): Promise<number> {
  for (let i = 1; i <= limit; i++) {
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS)
    if (done()) return i
  }
  throw new Error('never happened')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RoomMedia: statistics (e2-t13)', () => {
  it('reads the stats every interval into the panel’s store and reports its signal level', async () => {
    vi.useFakeTimers()
    const { bob, bobSent, stats, bobTransport } = await room()
    simulateDownlink(bobTransport, { loss: 0 })
    expect(stats.get()).toBeNull()
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 2)
    expect(stats.get()?.sample.inbound).toHaveLength(6)
    expect(stats.get()?.layers).toEqual(bob.getState().layers)
    expect(bob.getState().signal).toBe('good')
    expect(bobSent.filter((m) => m.t === 'signal')).toEqual([{ t: 'signal', level: 'good' }])
    // Usage reports keep their own, slower pace
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bobSent.filter((m) => m.t === 'stats')).toHaveLength(1)
    await bob.close()
  })

  it('tells the room a change at most every SIGNAL_REPORT_MS, and the last level wins', async () => {
    vi.useFakeTimers()
    const { bob, bobSent, bobTransport } = await room()
    const link = { loss: 0 }
    simulateDownlink(bobTransport, link)
    await until(() => bob.getState().signal === 'good')
    link.loss = 0.1
    await until(() => bob.getState().signal === 'poor')
    link.loss = 0
    await until(() => bob.getState().signal === 'good')
    await vi.advanceTimersByTimeAsync(6_000)
    const levels = bobSent.filter((m) => m.t === 'signal').map((m) => m.t === 'signal' && m.level)
    expect(levels[0]).toBe('good')
    expect(levels.at(-1)).toBe('good')
    expect(levels).toContain('poor')
    await bob.close()
  })
})

describe('RoomMedia: downlink adaptation (e2-t15)', () => {
  it('steps the video down, then cuts all but the kept cameras, then suggests audio-only; sound stays', async () => {
    vi.useFakeTimers()
    const { bob, bobTransport, camKeys } = await room()
    const link = { loss: 0 }
    simulateDownlink(bobTransport, link)
    bob.setVideoPriority([camKeys[0]], [])
    await until(() => bob.getState().signal === 'good')
    expect(Object.values(bob.getState().layers)).toEqual(['medium', 'medium', 'medium'])

    link.loss = 0.08
    await until(() => bob.getState().downlink === 'reduced')
    expect(bob.getState().downlinkBudgetBps).toBeLessThan(3_400_000)
    await until(() => Object.values(bob.getState().layers).every((l) => l === 'low'))
    expect(received(bob, 'cam')).toBe(3)

    await until(() => bob.getState().downlink === 'videoCut')
    await vi.advanceTimersByTimeAsync(0)
    // Only the kept camera; every microphone still comes in
    expect(Object.keys(bob.getState().received).filter((k) => k.includes('/cam-'))).toEqual([
      camKeys[0],
    ])
    expect(received(bob, 'mic')).toBe(3)
    expect([...bob.getState().pausedVideos].sort()).toEqual([camKeys[1], camKeys[2]].sort())

    await until(() => bob.getState().downlink === 'audioOnly')
    expect(received(bob, 'mic')).toBe(3)

    // The link heals: back up a stage at a time, everyone's camera again
    link.loss = 0
    await until(() => bob.getState().downlink === 'videoCut')
    await until(() => bob.getState().downlink === 'reduced')
    await vi.advanceTimersByTimeAsync(0)
    expect(received(bob, 'cam')).toBe(3)
    expect(bob.getState().pausedVideos).toEqual([])
    await until(() => bob.getState().downlink === 'normal', 400)
    await vi.advanceTimersByTimeAsync(50)
    expect(Object.values(bob.getState().layers)).toEqual(['medium', 'medium', 'medium'])
    await bob.close()
  })

  it('keeps a camera through the cut while the speaker changes, for KEEP_HOLD_MS', async () => {
    vi.useFakeTimers()
    const { bob, bobTransport, camKeys } = await room()
    simulateDownlink(bobTransport, { loss: 0.08 })
    bob.setVideoPriority([], [camKeys[0]])
    await until(() => bob.getState().downlink === 'videoCut')
    await vi.advanceTimersByTimeAsync(0)
    const cams = () =>
      Object.keys(bob.getState().received)
        .filter((k) => k.includes('/cam-'))
        .sort()
    expect(cams()).toEqual([camKeys[0]])
    const pulls = () =>
      [...bobTransport.subscriptions.keys()].filter((k) => k.includes('/cam-')).sort()
    // The speaker moves to the second camera: the free place takes it
    bob.setVideoPriority([], [camKeys[1]])
    await vi.advanceTimersByTimeAsync(1000)
    expect(cams()).toEqual([camKeys[0], camKeys[1]].sort())
    // Back to the first, on to the third: the third waits, nothing is dropped and taken again
    bob.setVideoPriority([], [camKeys[0]])
    bob.setVideoPriority([], [camKeys[2]])
    await vi.advanceTimersByTimeAsync(0)
    expect(cams()).toEqual([camKeys[0], camKeys[1]].sort())
    expect(pulls()).toEqual(cams())
    // Once the hold is over, the third takes the place listed longest ago (the second)
    await vi.advanceTimersByTimeAsync(KEEP_HOLD_MS)
    bob.setVideoPriority([], [camKeys[2]])
    await vi.advanceTimersByTimeAsync(0)
    expect(cams()).toEqual([camKeys[0], camKeys[2]].sort())
    // A pin gets a place at once
    bob.setVideoPriority([camKeys[1]], [camKeys[2]])
    await vi.advanceTimersByTimeAsync(0)
    expect(cams()).toEqual([camKeys[1], camKeys[2]].sort())
    await bob.close()
  })

  it('receives no video at all in audio-only, and everything again after it', async () => {
    vi.useFakeTimers()
    const { bob } = await room()
    expect(received(bob, 'cam')).toBe(3)
    bob.setAudioOnly(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(bob.getState()).toMatchObject({ audioOnly: true })
    expect(received(bob, 'cam')).toBe(0)
    expect(received(bob, 'mic')).toBe(3)
    expect(bob.getState().pausedVideos).toHaveLength(3)
    bob.setAudioOnly(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(received(bob, 'cam')).toBe(3)
    expect(bob.getState().pausedVideos).toEqual([])
    await bob.close()
  })

  it('keeps a shared screen through the cut', async () => {
    vi.useFakeTimers()
    const { bob, bobTransport, publishers } = await room()
    await publishers[0].media.setScreen(fakeTrack('video'))
    bob.setDesired(publishers.flatMap((p) => listed(p.sent)))
    await vi.advanceTimersByTimeAsync(0)
    expect(received(bob, 'screen')).toBe(1)
    const link = { loss: 0.08 }
    simulateDownlink(bobTransport, link)
    await until(() => bob.getState().downlink === 'videoCut')
    await vi.advanceTimersByTimeAsync(0)
    expect(received(bob, 'screen')).toBe(1)
    expect(received(bob, 'cam')).toBe(0)
    await bob.close()
  })
})

describe('RoomMedia: uplink adaptation (e2-t15)', () => {
  it('turns the camera’s top layer off while the encoder is held back, and on again later', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const transport = sfu.createTransport()
    const media = new RoomMedia({ transport, send: () => {} })
    await media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    const link = { reason: 'bandwidth' }
    simulateUplink(transport, link)
    const cam = [...transport.sending.keys()].find((name) => name.startsWith('cam'))!
    await until(() => media.getState().uplink.cam === 'medium')
    expect(transport.topLayers.get(cam)).toBe('medium')
    link.reason = 'none'
    const ticks = await until(() => media.getState().uplink.cam === 'high')
    expect(ticks).toBeGreaterThanOrEqual(15)
    expect(transport.topLayers.get(cam)).toBe('high')
    await media.close()
  })
})

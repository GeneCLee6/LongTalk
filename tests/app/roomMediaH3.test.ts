import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, MemberTrack } from '../../shared/protocol.ts'
import { FakeSfu, type FakeTransport } from '../../src/media/FakeTransport.ts'
import { Backoff } from '../../src/room/backoff.ts'
import {
  UPLINK_LOW_SAMPLES,
  UPLINK_RETRY_MS,
  UPLINK_SAMPLE_MS,
  UPLINK_WARMUP_MS,
} from '../../src/media/uplink.ts'
import { RoomMedia, type RoomMediaOptions } from '../../src/room/RoomMedia.ts'

// H3 (e6-t04): HD (the camera's top layer, held back on a thin uplink) and 純音訊模式 (no video
// received, our camera not sent), through MediaTransport only (FakeTransport records it).

const fakeTrack = (kind: 'audio' | 'video') =>
  ({ kind, applyConstraints: vi.fn(async () => {}) }) as unknown as MediaStreamTrack

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function listed(sent: ClientMessage[]): MemberTrack[] {
  const last = sent.filter((s) => s.t === 'tracks').at(-1)
  if (last?.t !== 'tracks') return []
  return last.tracks.map((t) => ({ sessionId: last.sessionId, ...t }))
}

function member(sfu: FakeSfu, options: Partial<RoomMediaOptions> = {}) {
  const transport = sfu.createTransport()
  const sent: ClientMessage[] = []
  const media = new RoomMedia({ transport, send: (m) => sent.push(m), ...options })
  return { transport, media, sent }
}

const camName = (m: ReturnType<typeof member>) =>
  m.media.getState().published.find((t) => t.kind === 'cam')!.trackName

afterEach(() => {
  vi.useRealTimers()
})

describe('RoomMedia: 純音訊模式 (e6-t04)', () => {
  it('stops receiving everyone’s video but keeps their sound, and restores it', async () => {
    const sfu = new FakeSfu()
    const alice = member(sfu)
    await alice.media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    await alice.media.setScreen(fakeTrack('video'))
    const bob = member(sfu)
    await bob.media.start({ mic: null, cam: null })
    bob.media.setDesired(listed(alice.sent))
    await settle()
    const kinds = () =>
      Object.values(bob.media.getState().received)
        .map((r) => r.kind)
        .sort()
    expect(kinds()).toEqual(['cam', 'mic', 'screen'])

    await bob.media.setAudioOnly(true)
    await settle()
    expect(bob.media.getState().audioOnly).toBe(true)
    expect(kinds()).toEqual(['mic'])
    // Unsubscribed at the SFU, not just hidden
    expect([...bob.transport.subscriptions.keys()].every((key) => key.includes('/mic-'))).toBe(true)
    // A new member's camera listed meanwhile is not subscribed either
    bob.media.setDesired(listed(alice.sent))
    await settle()
    expect(kinds()).toEqual(['mic'])

    await bob.media.setAudioOnly(false)
    await settle()
    expect(kinds()).toEqual(['cam', 'mic', 'screen'])
    await alice.media.close()
    await bob.media.close()
  })

  it('sends no camera while on (reported muted), and sends it again after', async () => {
    const sfu = new FakeSfu()
    const alice = member(sfu)
    const cam = fakeTrack('video')
    await alice.media.start({ mic: fakeTrack('audio'), cam })
    const name = camName(alice)
    await alice.media.setAudioOnly(true)
    expect(alice.transport.sending.get(name)).toBeNull()
    expect(listed(alice.sent).find((t) => t.kind === 'cam')?.muted).toBe(true)
    // The device switching meanwhile does not get round it
    const other = fakeTrack('video')
    await alice.media.setLocal({ mic: null, cam: other })
    expect(alice.transport.sending.get(name)).toBeNull()
    await alice.media.setAudioOnly(false)
    expect(alice.transport.sending.get(name)).toBe(other)
    expect(listed(alice.sent).find((t) => t.kind === 'cam')?.muted).toBe(false)
    await alice.media.close()
  })

  it('starts in it when asked to: the camera is never published', async () => {
    const sfu = new FakeSfu()
    const alice = member(sfu, { audioOnly: true })
    await alice.media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    expect(alice.media.getState().published.map((t) => t.kind)).toEqual(['mic'])
    await alice.media.setAudioOnly(false)
    expect(alice.media.getState().published.map((t) => t.kind)).toEqual(['mic', 'cam'])
    await alice.media.close()
  })
})

describe('RoomMedia: HD (e6-t04)', () => {
  it('sends every layer with HD on, and leaves the 720p one out with it off', async () => {
    const sfu = new FakeSfu()
    const alice = member(sfu)
    await alice.media.start({ mic: null, cam: fakeTrack('video') })
    const name = camName(alice)
    expect(alice.transport.topLayers.get(name)).toBe('high')
    await alice.media.setHd(false)
    expect(alice.transport.topLayers.get(name)).toBe('medium')
    expect(alice.media.getState()).toMatchObject({ hd: false, hdLimited: false })
    await alice.media.setHd(true)
    expect(alice.transport.topLayers.get(name)).toBe('high')
    await alice.media.close()
  })

  it('publishes with HD off from the start, and again after a rebuild', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const transports: FakeTransport[] = []
    const media = new RoomMedia({
      createTransport: () => {
        const transport = sfu.createTransport()
        transports.push(transport)
        return transport
      },
      send: () => {},
      hd: false,
      backoff: new Backoff({ baseMs: 500, jitter: 0 }),
    })
    await media.start({ mic: null, cam: fakeTrack('video') })
    const cam = () => media.getState().published.find((t) => t.kind === 'cam')!.trackName
    expect(transports[0].topLayers.get(cam())).toBe('medium')
    transports[0].simulateState('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(transports).toHaveLength(2)
    expect(transports[1].topLayers.get(cam())).toBe('medium')
    await media.close()
  })

  it('holds HD back when the uplink is short for a while, then tries again', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    let now = 0
    const alice = member(sfu, { now: () => now, uplinkSampleMs: UPLINK_SAMPLE_MS })
    await alice.media.start({ mic: null, cam: fakeTrack('video') })
    const name = camName(alice)
    alice.transport.uplink = { availableOutgoingBitrate: 600_000, limitation: 'bandwidth' }
    const tick = async () => {
      now += UPLINK_SAMPLE_MS
      await vi.advanceTimersByTimeAsync(UPLINK_SAMPLE_MS)
    }
    // The warm-up is not judged (the estimate is still climbing)
    while (now < UPLINK_WARMUP_MS) await tick()
    expect(alice.media.getState().hdLimited).toBe(false)
    for (let i = 0; i < UPLINK_LOW_SAMPLES; i++) await tick()
    expect(alice.media.getState()).toMatchObject({ hd: true, hdLimited: true })
    expect(alice.transport.topLayers.get(name)).toBe('medium')
    // The uplink got better; HD is tried again after the retry wait
    alice.transport.uplink = { availableOutgoingBitrate: 3_000_000, limitation: 'none' }
    now += UPLINK_RETRY_MS
    await vi.advanceTimersByTimeAsync(UPLINK_RETRY_MS)
    expect(alice.media.getState().hdLimited).toBe(false)
    expect(alice.transport.topLayers.get(name)).toBe('high')
    await alice.media.close()
  })

  it('keeps HD with a good uplink, and does not sample with HD off', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    let now = 0
    const alice = member(sfu, { now: () => now, uplinkSampleMs: UPLINK_SAMPLE_MS })
    await alice.media.start({ mic: null, cam: fakeTrack('video') })
    const uplink = vi.spyOn(alice.transport, 'getUplink')
    for (let i = 0; i < 10; i++) {
      now += UPLINK_SAMPLE_MS
      await vi.advanceTimersByTimeAsync(UPLINK_SAMPLE_MS)
    }
    expect(alice.media.getState().hdLimited).toBe(false)
    expect(uplink).toHaveBeenCalled()
    await alice.media.setHd(false)
    uplink.mockClear()
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(UPLINK_SAMPLE_MS)
    expect(uplink).not.toHaveBeenCalled()
    await alice.media.close()
  })

  it('turning HD on again tries at once after it was held back', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    let now = 0
    const alice = member(sfu, { now: () => now, uplinkSampleMs: UPLINK_SAMPLE_MS })
    await alice.media.start({ mic: null, cam: fakeTrack('video') })
    alice.transport.uplink = { availableOutgoingBitrate: 500_000, limitation: 'none' }
    for (let i = 0; i < UPLINK_WARMUP_MS / UPLINK_SAMPLE_MS + UPLINK_LOW_SAMPLES; i++) {
      now += UPLINK_SAMPLE_MS
      await vi.advanceTimersByTimeAsync(UPLINK_SAMPLE_MS)
    }
    expect(alice.media.getState().hdLimited).toBe(true)
    await alice.media.setHd(false)
    await alice.media.setHd(true)
    expect(alice.media.getState().hdLimited).toBe(false)
    expect(alice.transport.topLayers.get(camName(alice))).toBe('high')
    await alice.media.close()
  })
})

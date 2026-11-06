import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, MemberTrack } from '../../shared/protocol.ts'
import { FakeSfu, type FakeTransport } from '../../src/media/FakeTransport.ts'
import {
  GRACE_BATCH_MS,
  HIDDEN_GRACE_MS,
  SIGHT_SETTLE_MS,
  UNSEEN_GRACE_MS,
} from '../../src/media/subscriptions.ts'
import { LAYER_DEBOUNCE_MS, RoomMedia } from '../../src/room/RoomMedia.ts'
import { VideoDemandStore } from '../../src/room/videoDemand.ts'

// L1 (e2-t18, e10-t01): RoomMedia receives the cameras in sight. A fake clock drives the settling
// and the grace; FakeSfu says what the SFU would have been asked.

const fakeTrack = (kind: 'audio' | 'video') =>
  ({ kind, applyConstraints: vi.fn(async () => {}) }) as unknown as MediaStreamTrack

function listed(sent: ClientMessage[]): MemberTrack[] {
  const last = sent.filter((s) => s.t === 'tracks').at(-1)
  if (last?.t !== 'tracks') return []
  return last.tracks.map((t) => ({ sessionId: last.sessionId, ...t }))
}

const flush = () => vi.advanceTimersByTimeAsync(0)
const past = (ms: number) => vi.advanceTimersByTimeAsync(ms + 1)

interface Room {
  bob: RoomMedia
  transport: FakeTransport
  demand: VideoDemandStore
  cams: string[]
  mics: string[]
  tracks: MemberTrack[]
  seats: Map<string, object>
  seat: (key: string, visible: boolean, near?: boolean) => void
  received: () => string[]
}

async function room(publishers = 4, options: { adapt?: boolean } = {}): Promise<Room> {
  const sfu = new FakeSfu()
  const tracks: MemberTrack[] = []
  for (let i = 0; i < publishers; i++) {
    const sent: ClientMessage[] = []
    const media = new RoomMedia({ transport: sfu.createTransport(), send: (m) => sent.push(m) })
    await media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    await flush()
    tracks.push(...listed(sent))
  }
  const demand = new VideoDemandStore()
  const transport = sfu.createTransport()
  const bob = new RoomMedia({
    transport,
    send: () => {},
    demand,
    visibleOnly: true,
    adapt: options.adapt ?? false,
  })
  await bob.start({ mic: null, cam: null })
  await flush()
  bob.setDesired(tracks)
  await flush()
  const key = (t: MemberTrack) => `${t.sessionId}/${t.trackName}`
  const seats = new Map<string, object>()
  return {
    bob,
    transport,
    demand,
    tracks,
    seats,
    cams: tracks.filter((t) => t.kind === 'cam').map(key),
    mics: tracks.filter((t) => t.kind === 'mic').map(key),
    seat: (camera, visible, near = false) => {
      const view = seats.get(camera) ?? {}
      seats.set(camera, view)
      demand.reportSeat(camera, view, { width: 300, height: 170, visible, near })
    },
    received: () => Object.keys(bob.getState().received).sort(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RoomMedia: only what is in sight (L1)', () => {
  it('receives every microphone and no camera without a tile in sight', async () => {
    const { bob, cams, mics, received } = await room(3)
    expect(received()).toEqual([...mics].sort())
    expect([...bob.getState().unseenVideos].sort()).toEqual([...cams].sort())
    expect(bob.getState().pausedVideos).toEqual([])
  })

  it('subscribes a page of cameras in one batch once it settles, at the layer its tiles need', async () => {
    const { transport, cams, seat, received, mics, bob } = await room(4)
    transport.subscribeBatches.length = 0
    for (const key of cams.slice(0, 3)) seat(key, true)
    await vi.advanceTimersByTimeAsync(SIGHT_SETTLE_MS - 1)
    expect(transport.subscribeBatches).toEqual([])
    await past(1)
    expect(transport.subscribeBatches).toEqual([3])
    expect(received()).toEqual([...mics, ...cams.slice(0, 3)].sort())
    // 300 × 170: the lowest layer covers 170 lines, so no tracks/update follows
    expect(transport.preferredLayers.get(cams[0])).toBe('low')
    await past(LAYER_DEBOUNCE_MS)
    expect(bob.getState().unseenVideos).toEqual([cams[3]])
  })

  it('does not churn: back within the grace costs no SDP', async () => {
    const { transport, cams, seat, received } = await room(2)
    const [a, b] = cams
    seat(a, true)
    await past(SIGHT_SETTLE_MS)
    for (let i = 0; i < 6; i++) {
      seat(a, false)
      seat(b, true)
      await past(SIGHT_SETTLE_MS)
      seat(b, false)
      seat(a, true)
      await past(SIGHT_SETTLE_MS)
    }
    // a once, b once: nothing closed, nothing subscribed again
    expect(transport.unsubscribeBatches).toEqual([])
    expect(transport.subscribeBatches.reduce((sum, n) => sum + n, 0)).toBe(2 + 2)
    expect(received()).toContain(a)
    expect(received()).toContain(b)
  })

  it('a quick pass over a page subscribes nothing', async () => {
    const { transport, cams, seat } = await room(2)
    transport.subscribeBatches.length = 0
    seat(cams[0], true)
    await vi.advanceTimersByTimeAsync(SIGHT_SETTLE_MS / 2)
    seat(cams[0], false)
    await past(SIGHT_SETTLE_MS * 2)
    expect(transport.subscribeBatches).toEqual([])
  })

  it('unsubscribes after the grace, in one batch, and comes back', async () => {
    const { bob, transport, cams, seat, received, mics } = await room(3)
    for (const key of cams) seat(key, true)
    await past(SIGHT_SETTLE_MS)
    for (const key of cams) seat(key, false)
    await vi.advanceTimersByTimeAsync(UNSEEN_GRACE_MS - 1)
    expect(transport.unsubscribeBatches).toEqual([])
    await past(GRACE_BATCH_MS)
    expect(transport.unsubscribeBatches).toEqual([3])
    expect(received()).toEqual([...mics].sort())
    expect(bob.getState().unseenVideos).toHaveLength(3)
    seat(cams[1], true)
    await past(SIGHT_SETTLE_MS)
    expect(received()).toContain(cams[1])
  })

  it('tiles leaving a few ms apart all go, in one batch', async () => {
    const { transport, cams, seat, received, mics } = await room(4)
    for (const key of cams) seat(key, true)
    await past(SIGHT_SETTLE_MS)
    for (const key of cams) {
      seat(key, false)
      await vi.advanceTimersByTimeAsync(3)
    }
    await past(UNSEEN_GRACE_MS + GRACE_BATCH_MS)
    expect(transport.unsubscribeBatches).toEqual([4])
    expect(received()).toEqual([...mics].sort())
  })

  it('subscribes ahead for the pointer on the pager, at the lowest layer', async () => {
    const { transport, cams, seat, received } = await room(1)
    seat(cams[0], false, true)
    await past(SIGHT_SETTLE_MS)
    expect(received()).toContain(cams[0])
    expect(transport.preferredLayers.get(cams[0])).toBe('low')
  })

  it('keeps the speaker wherever their tile is, then lets them go', async () => {
    const { bob, cams, received } = await room(2)
    bob.setVideoPriority([], [cams[1]])
    await flush()
    expect(received()).toContain(cams[1])
    expect(received()).not.toContain(cams[0])
  })

  it('a recording keeps what it draws, off screen and in a background tab', async () => {
    const { bob, demand, cams, received, seat } = await room(2)
    bob.setVideoNeeded(cams)
    await flush()
    expect(received()).toEqual(expect.arrayContaining(cams))
    seat(cams[0], true)
    demand.setPageHidden(true)
    await past(HIDDEN_GRACE_MS)
    expect(received()).toEqual(expect.arrayContaining(cams))
    // The recording ends: back to what the screen shows
    bob.setVideoNeeded([])
    await flush()
    expect(received()).not.toContain(cams[0])
  })

  it('a background tab lets go of its cameras after the longer grace, not its sound', async () => {
    const { demand, cams, mics, seat, received } = await room(2)
    seat(cams[0], true)
    await past(SIGHT_SETTLE_MS)
    demand.setPageHidden(true)
    await vi.advanceTimersByTimeAsync(UNSEEN_GRACE_MS + 1)
    expect(received()).toContain(cams[0])
    await past(HIDDEN_GRACE_MS - UNSEEN_GRACE_MS + GRACE_BATCH_MS)
    expect(received()).toEqual([...mics].sort())
    demand.setPageHidden(false)
    await past(SIGHT_SETTLE_MS)
    expect(received()).toContain(cams[0])
  })

  it('純音訊模式 wins over sight, and its cameras are paused rather than unseen', async () => {
    const { bob, cams, seat, received } = await room(2)
    seat(cams[0], true)
    await past(SIGHT_SETTLE_MS)
    await bob.setAudioOnly(true)
    await flush()
    expect(received()).not.toContain(cams[0])
    expect(bob.getState().unseenVideos).toEqual([])
    expect([...bob.getState().pausedVideos].sort()).toEqual([...cams].sort())
    await bob.setAudioOnly(false)
    await flush()
    expect(received()).toContain(cams[0])
    expect(received()).not.toContain(cams[1])
    expect(bob.getState().pausedVideos).toEqual([])
    expect(bob.getState().unseenVideos).toEqual([cams[1]])
  })

  it('a muted camera out of sight is neither received nor listed as unseen', async () => {
    const { bob, tracks, cams } = await room(1)
    bob.setDesired(tracks.map((t) => (t.kind === 'cam' ? { ...t, muted: true } : t)))
    await flush()
    expect(bob.getState().unseenVideos).toEqual([])
    expect(cams).toHaveLength(1)
  })

  it('a screen is always received, starting at its top layer', async () => {
    const { transport, bob, tracks } = await room(1)
    const screen = {
      sessionId: tracks[0].sessionId,
      trackName: 'screen-1',
      kind: 'screen' as const,
      muted: false,
    }
    const sfu = transport.sfu
    sfu.published.set(`${screen.sessionId}/${screen.trackName}`, {
      ...screen,
      track: fakeTrack('video'),
    })
    bob.setDesired([...tracks, screen])
    await flush()
    expect(transport.preferredLayers.get(`${screen.sessionId}/${screen.trackName}`)).toBe('high')
  })

  it('without visibleOnly everything is received, in a batch', async () => {
    const sfu = new FakeSfu()
    const sent: ClientMessage[] = []
    const alice = new RoomMedia({ transport: sfu.createTransport(), send: (m) => sent.push(m) })
    await alice.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    await flush()
    const transport = sfu.createTransport()
    const bob = new RoomMedia({ transport, send: () => {}, demand: new VideoDemandStore() })
    await bob.start({ mic: null, cam: null })
    await flush()
    bob.setDesired(listed(sent))
    await flush()
    expect(Object.keys(bob.getState().received)).toHaveLength(2)
    expect(transport.subscribeBatches).toEqual([2])
  })
})

describe('VideoDemandStore: seats', () => {
  it('reports what is in sight, and nothing with the tab in the background', () => {
    const store = new VideoDemandStore()
    const a = {}
    const b = {}
    store.reportSeat('x', a, { width: 10, height: 10, visible: false })
    store.reportSeat('y', a, { width: 10, height: 10, visible: true })
    store.reportSeat('z', a, { width: 10, height: 10, visible: false, near: true })
    expect([...store.inSight()].sort()).toEqual(['y', 'z'])
    store.reportSeat('x', b, { width: 10, height: 10, visible: true })
    expect(store.inSight().has('x')).toBe(true)
    store.reportSeat('x', b, null)
    expect(store.inSight().has('x')).toBe(false)
    store.setPageHidden(true)
    expect(store.inSight().size).toBe(0)
    expect(store.seatDemand('y')).toMatchObject({ visible: false })
    expect(store.seatDemand('nowhere')).toBeNull()
  })

  it('tells nobody when a seat has not changed', () => {
    const store = new VideoDemandStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const view = {}
    store.reportSeat('x', view, { width: 10, height: 10, visible: true })
    store.reportSeat('x', view, { width: 10, height: 10, visible: true })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

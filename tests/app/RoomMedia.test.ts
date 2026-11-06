import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, MemberTrack } from '../../shared/protocol.ts'
import { FakeSfu, type FakeTransport } from '../../src/media/FakeTransport.ts'
import { MediaTransportError } from '../../src/media/MediaTransport.ts'
import { Backoff } from '../../src/room/backoff.ts'
import {
  LOW_QUALITY_VIDEO,
  RoomMedia,
  type IceConfig,
  type RoomMediaOptions,
} from '../../src/room/RoomMedia.ts'

/** A MediaStreamTrack as far as RoomMedia and FakeTransport care */
function fakeTrack(kind: 'audio' | 'video') {
  return { kind, applyConstraints: vi.fn(async () => {}) } as unknown as MediaStreamTrack & {
    applyConstraints: ReturnType<typeof vi.fn>
  }
}

/** One member: a transport on the shared FakeSfu, a RoomMedia, and what it sent to the room */
function member(
  sfu: FakeSfu,
  options: { retryDelayMs?: number; retryMaxMs?: number; statsIntervalMs?: number } = {},
) {
  const transport = sfu.createTransport()
  const sent: ClientMessage[] = []
  const media = new RoomMedia({ transport, send: (m) => sent.push(m), ...options })
  return { transport, media, sent }
}

/** What a member's last `tracks` message means for everyone else (what RoomDO would list) */
function listed(m: { sent: ClientMessage[] }): MemberTrack[] {
  const last = m.sent.filter((s) => s.t === 'tracks').at(-1)
  if (last?.t !== 'tracks') return []
  return last.tracks.map((t) => ({ sessionId: last.sessionId, ...t }))
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('RoomMedia: publishing (e2-t03)', () => {
  it('connects, publishes the microphone then the camera and reports each to the room', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    expect(a.media.getState()).toMatchObject({ status: 'connected', error: null })
    expect(a.media.getState().published.map((t) => t.kind)).toEqual(['mic', 'cam'])
    const reports = a.sent.filter((m) => m.t === 'tracks')
    expect(reports).toEqual([
      {
        t: 'tracks',
        sessionId: 'fake-session-1',
        tracks: [{ trackName: 'mic-1', kind: 'mic', muted: false }],
      },
      {
        t: 'tracks',
        sessionId: 'fake-session-1',
        tracks: [
          { trackName: 'mic-1', kind: 'mic', muted: false },
          { trackName: 'cam-2', kind: 'cam', muted: false },
        ],
      },
    ])
  })

  it('tries a publish that failed again later, and clears the error once it goes', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu, { retryDelayMs: 1000 })
    const publish = vi.spyOn(a.transport, 'publish')
    publish.mockRejectedValueOnce(new MediaTransportError('sfu_error', '503 backend_error'))
    await a.media.start({ mic: null, cam: fakeTrack('video') })
    expect(a.media.getState()).toMatchObject({ error: 'sfu_error', published: [] })
    expect(a.sent.filter((m) => m.t === 'tracks')).toEqual([])
    await vi.advanceTimersByTimeAsync(1200)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(a.media.getState()).toMatchObject({ error: null })
    expect(listed(a).map((t) => t.kind)).toEqual(['cam'])
    await a.media.close()
  })

  it('joins with nothing to publish and still receives', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: null })
    expect(a.media.getState()).toMatchObject({ status: 'connected', published: [] })
    expect(a.sent.filter((m) => m.t === 'tracks')).toEqual([])
  })

  it('says why when the SFU session cannot be opened', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    vi.spyOn(a.transport, 'connect').mockRejectedValue(new MediaTransportError('unauthorized'))
    await a.media.start({ mic: fakeTrack('audio'), cam: null })
    expect(a.media.getState()).toMatchObject({ status: 'failed', error: 'unauthorized' })
  })

  it('stops reporting once closed, and closes the transport', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: null })
    await a.media.close()
    expect(a.transport.state).toBe('closed')
    expect(a.media.getState().status).toBe('closed')
    expect(sfu.published.size).toBe(0)
  })

  it('reports the bytes it received to the room every interval', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu, { statsIntervalMs: 10_000 })
    await a.media.start({ mic: null, cam: null })
    ;(a.transport as FakeTransport).bytesReceived = 4321
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.sent.filter((m) => m.t === 'stats')).toEqual([
      { t: 'stats', sessionId: 'fake-session-1', bytesReceived: 4321, relay: false },
    ])
    await a.media.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(a.sent.filter((m) => m.t === 'stats')).toHaveLength(1)
  })
})

describe('RoomMedia: desired / actual subscriptions (e2-t04)', () => {
  it("receives every other member's tracks, as the publisher's own track objects", async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    const mic = fakeTrack('audio')
    const cam = fakeTrack('video')
    await b.media.start({ mic, cam })
    await a.media.start({ mic: null, cam: null })
    a.media.setDesired(listed(b))
    await settle()
    const received = Object.values(a.media.getState().received)
    expect(received.map((r) => [r.kind, r.track])).toEqual([
      ['mic', mic],
      ['cam', cam],
    ])
  })

  it('reconciles before connecting is done: the list waits for the session', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    await b.media.start({ mic: fakeTrack('audio'), cam: null })
    a.media.setDesired(listed(b))
    expect(a.media.getState().received).toEqual({})
    await a.media.start({ mic: null, cam: null })
    await settle()
    expect(Object.keys(a.media.getState().received)).toHaveLength(1)
  })

  it('is idempotent: the same list again subscribes to nothing new', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    await b.media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    await a.media.start({ mic: null, cam: null })
    const subscribe = vi.spyOn(a.transport, 'subscribe')
    // Twice before the first subscriptions settle, and again after
    a.media.setDesired(listed(b))
    a.media.setDesired(listed(b))
    await settle()
    a.media.setDesired(listed(b))
    a.media.reconcile()
    await settle()
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes a track that left the list', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    await b.media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    await a.media.start({ mic: null, cam: null })
    a.media.setDesired(listed(b))
    await settle()
    const unsubscribe = vi.spyOn(a.transport, 'unsubscribe')
    a.media.setDesired(listed(b).filter((t) => t.kind === 'mic'))
    await settle()
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ trackName: 'cam-2' }),
    )
    expect(Object.values(a.media.getState().received).map((r) => r.kind)).toEqual(['mic'])
    expect((a.transport as FakeTransport).subscriptions.size).toBe(1)
    // A member who left: nothing listed, nothing received
    a.media.setDesired([])
    await settle()
    expect(a.media.getState().received).toEqual({})
    expect((a.transport as FakeTransport).subscriptions.size).toBe(0)
  })

  it('drops a subscription that settles after its track left the list', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    await b.media.start({ mic: fakeTrack('audio'), cam: null })
    await a.media.start({ mic: null, cam: null })
    a.media.setDesired(listed(b))
    a.media.setDesired([])
    await settle()
    expect(a.media.getState().received).toEqual({})
    expect((a.transport as FakeTransport).subscriptions.size).toBe(0)
  })

  it('retries a failed subscription with growing waits for as long as it is listed', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu, { retryDelayMs: 1000, retryMaxMs: 4000 })
    await a.media.start({ mic: null, cam: null })
    const ghost: MemberTrack = {
      sessionId: 'nobody',
      trackName: 'cam-1',
      kind: 'cam',
      muted: false,
    }
    const subscribe = vi.spyOn(a.transport, 'subscribe')
    a.media.setDesired([ghost])
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(1)
    // About 1, 2, 4 s, then every 4 s (± jitter): no giving up after a few tries (fix after C1)
    await vi.advanceTimersByTimeAsync(7_000 * 1.15)
    expect(subscribe).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(subscribe.mock.calls.length).toBeGreaterThanOrEqual(4 + 13)
    // Gone from the list: no more tries
    a.media.setDesired([])
    const tries = subscribe.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(subscribe).toHaveBeenCalledTimes(tries)
    // Back on the list: a fresh start, at once
    a.media.setDesired([ghost])
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(tries + 1)
    await a.media.close()
  })

  it('picks up a publisher that only becomes ready much later, without the list changing', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu, { retryDelayMs: 1000, retryMaxMs: 4000 })
    const b = member(sfu)
    await a.media.start({ mic: null, cam: null })
    await b.media.start({ mic: null, cam: null })
    a.media.setDesired([
      { sessionId: b.transport.sessionId!, trackName: 'cam-1', kind: 'cam', muted: false },
    ])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(a.media.getState().received).toEqual({})
    await b.transport.publish(fakeTrack('video'), { kind: 'cam' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(Object.keys(a.media.getState().received)).toHaveLength(1)
    await a.media.close()
  })

  it('retries at once when the publisher reports the track again', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu, { retryDelayMs: 10_000 })
    const b = member(sfu)
    await a.media.start({ mic: null, cam: null })
    await b.media.start({ mic: null, cam: null })
    const listedMic: MemberTrack = {
      sessionId: b.transport.sessionId!,
      trackName: 'mic-1',
      kind: 'mic',
      muted: false,
    }
    a.media.setDesired([listedMic])
    await vi.advanceTimersByTimeAsync(0)
    await b.transport.publish(fakeTrack('audio'), { kind: 'mic' })
    // Muted and unmuted: a new report of the same track, long before the retry is due
    a.media.setDesired([{ ...listedMic, muted: true }])
    await vi.advanceTimersByTimeAsync(0)
    expect(Object.keys(a.media.getState().received)).toHaveLength(1)
    await a.media.close()
  })

  it('picks up a track on retry once it is really there', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu, { retryDelayMs: 1000 })
    const b = member(sfu)
    await a.media.start({ mic: null, cam: null })
    await b.media.start({ mic: null, cam: null })
    // RoomDO already lists it, the SFU does not have it yet
    a.media.setDesired([
      { sessionId: b.transport.sessionId!, trackName: 'mic-1', kind: 'mic', muted: false },
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(a.media.getState().received).toEqual({})
    await b.transport.publish(fakeTrack('audio'), { kind: 'mic' })
    await vi.advanceTimersByTimeAsync(1200)
    expect(Object.keys(a.media.getState().received)).toHaveLength(1)
    await a.media.close()
  })

  it('lets go of a track its publisher stopped, without subscribing to it again', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    await b.media.start({ mic: fakeTrack('audio'), cam: null })
    await a.media.start({ mic: null, cam: null })
    a.media.setDesired(listed(b))
    await settle()
    const subscribe = vi.spyOn(a.transport, 'subscribe')
    await b.transport.unpublish('mic-1')
    expect(a.media.getState().received).toEqual({})
    // RoomDO still lists it for a moment: no retry loop
    a.media.setDesired(listed(b))
    await settle()
    expect(subscribe).not.toHaveBeenCalled()
  })
})

describe('RoomMedia: free-tier guard (e11-t13)', () => {
  it('does not publish the camera when the month is audio-only; the microphone still goes', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') }, 'audioOnly')
    expect(a.media.getState()).toMatchObject({ videoRefused: true, error: null })
    expect(a.media.getState().published.map((t) => t.kind)).toEqual(['mic'])
  })

  it('takes a refusal from the proxy as "no video this month", not as an error', async () => {
    const sfu = new FakeSfu()
    sfu.refuseVideo = true
    const a = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    expect(a.media.getState()).toMatchObject({ videoRefused: true, error: null })
    expect(a.media.getState().published.map((t) => t.kind)).toEqual(['mic'])
  })

  it('sends low quality past the low-quality threshold, at the start or later', async () => {
    const sfu = new FakeSfu()
    const early = member(sfu)
    const cam = fakeTrack('video')
    await early.media.start({ mic: null, cam }, 'low')
    expect(cam.applyConstraints).toHaveBeenCalledExactlyOnceWith(LOW_QUALITY_VIDEO)
    expect(early.media.getState().lowQuality).toBe(true)

    const later = member(sfu)
    const cam2 = fakeTrack('video')
    await later.media.start({ mic: null, cam: cam2 })
    expect(cam2.applyConstraints).not.toHaveBeenCalled()
    later.media.setUsage('low')
    later.media.setUsage('audioOnly')
    await settle()
    expect(cam2.applyConstraints).toHaveBeenCalledOnce()
    // A camera already sending keeps sending (only new video is refused)
    expect(later.media.getState().published.map((t) => t.kind)).toEqual(['cam'])
  })
})

describe('RoomMedia: turning off, on and switching (e2-t05, e2-t06)', () => {
  /** The `muted` flags of the last `tracks` report, by kind */
  const mutedFlags = (m: { sent: ClientMessage[] }) =>
    Object.fromEntries(listed(m).map((t) => [t.kind, t.muted]))

  it('mutes and unmutes by replacing what the track sends, without publishing again', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const mic = fakeTrack('audio')
    const cam = fakeTrack('video')
    await a.media.start({ mic, cam })
    const publish = vi.spyOn(a.transport, 'publish')
    await a.media.setLocal({ mic: null, cam })
    expect(a.transport.sending.get('mic-1')).toBeNull()
    expect(mutedFlags(a)).toEqual({ mic: true, cam: false })
    await a.media.setLocal({ mic: null, cam: null })
    expect(mutedFlags(a)).toEqual({ mic: true, cam: true })
    expect(a.media.getState().published.map((t) => t.muted)).toEqual([true, true])
    // A new camera track (the camera was stopped while off) goes on the same published track
    const cam2 = fakeTrack('video')
    await a.media.setLocal({ mic, cam: cam2 })
    expect(a.transport.sending.get('cam-2')).toBe(cam2)
    expect(mutedFlags(a)).toEqual({ mic: false, cam: false })
    expect(publish).not.toHaveBeenCalled()
    // Same tracks again: nothing to report
    const reports = a.sent.length
    await a.media.setLocal({ mic, cam: cam2 })
    expect(a.sent).toHaveLength(reports)
  })

  it('switches devices on the published track (e2-t06)', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: null })
    await b.media.start({ mic: null, cam: null })
    b.media.setDesired(listed(a))
    await settle()
    const headset = fakeTrack('audio')
    await a.media.setLocal({ mic: headset, cam: null })
    expect(a.transport.sending.get('mic-1')).toBe(headset)
    // The subscriber was not disturbed
    expect(Object.keys(b.media.getState().received)).toHaveLength(1)
  })

  it('publishes a kind the first time it is turned on', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: null })
    await a.media.setLocal({ mic: fakeTrack('audio'), cam: null })
    expect(listed(a)).toEqual([
      { sessionId: 'fake-session-1', trackName: 'mic-1', kind: 'mic', muted: false },
    ])
  })

  it('applies changes made before the session opened once it does', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const started = a.media.start({ mic: fakeTrack('audio'), cam: null })
    const later = fakeTrack('audio')
    void a.media.setLocal({ mic: later, cam: null })
    await started
    expect(a.transport.sending.get('mic-1')).toBe(later)
  })

  it('keeps a stopped camera off once the month is audio-only (e11-t13)', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const mic = fakeTrack('audio')
    await a.media.start({ mic, cam: fakeTrack('video') })
    await a.media.setLocal({ mic, cam: null })
    a.media.setUsage('audioOnly')
    await a.media.setLocal({ mic, cam: fakeTrack('video') })
    expect(a.transport.sending.get('cam-2')).toBeNull()
    expect(a.media.getState().videoRefused).toBe(true)
    expect(mutedFlags(a)).toEqual({ mic: false, cam: true })
    // Turning it off again clears the refusal, so the next try tells the member again
    await a.media.setLocal({ mic, cam: null })
    expect(a.media.getState().videoRefused).toBe(false)
  })

  it('sends a new camera at low quality once the month is past the threshold', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: fakeTrack('video') }, 'low')
    const cam2 = fakeTrack('video')
    await a.media.setLocal({ mic: null, cam: cam2 })
    expect(cam2.applyConstraints).toHaveBeenCalledWith(LOW_QUALITY_VIDEO)
  })

  it('says so when a track cannot be replaced', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const mic = fakeTrack('audio')
    await a.media.start({ mic, cam: null })
    vi.spyOn(a.transport, 'replaceTrack').mockRejectedValue(new MediaTransportError('sfu_error'))
    await a.media.setLocal({ mic: null, cam: null })
    expect(a.media.getState().error).toBe('sfu_error')
    expect(mutedFlags(a)).toEqual({ mic: false })
  })
})

describe('RoomMedia: rebuilding the session (e2-t08) and TURN (e2-t07)', () => {
  /** A member whose RoomMedia makes a new transport for every session */
  function rebuildable(sfu: FakeSfu, options: Partial<RoomMediaOptions> = {}) {
    const transports: FakeTransport[] = []
    const sent: ClientMessage[] = []
    const media = new RoomMedia({
      createTransport: () => {
        const transport = sfu.createTransport()
        transports.push(transport)
        return transport
      },
      send: (m) => sent.push(m),
      backoff: new Backoff({ random: () => 0.5, giveUpAfterMs: 60_000 }),
      ...options,
    })
    return { media, sent, transports, current: () => transports.at(-1)! }
  }

  it('rebuilds a failed session: new transport, tracks published again and reported', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = rebuildable(sfu)
    const mic = fakeTrack('audio')
    const cam = fakeTrack('video')
    await a.media.start({ mic, cam })
    a.current().simulateState('failed')
    expect(a.media.getState().status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.transports).toHaveLength(2)
    expect(a.transports[0].state).toBe('closed')
    expect(a.media.getState()).toMatchObject({ status: 'connected', error: null })
    expect(listed(a)).toEqual([
      { sessionId: 'fake-session-2', trackName: 'mic-1', kind: 'mic', muted: false },
      { sessionId: 'fake-session-2', trackName: 'cam-2', kind: 'cam', muted: false },
    ])
    expect(a.current().sending.get('cam-2')).toBe(cam)
  })

  it('a rebuild during a share with the camera off: the screen comes back, the camera does not', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = rebuildable(sfu)
    const mic = fakeTrack('audio')
    const cam = fakeTrack('video')
    await a.media.start({ mic, cam })
    await a.media.setLocal({ mic, cam: null })
    await a.media.setScreen(fakeTrack('video'))
    a.current().simulateState('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.transports).toHaveLength(2)
    expect(listed(a).map((track) => track.kind)).toEqual(['mic', 'screen'])
    // The camera comes back after the share, on the new session
    await a.media.setScreen(null)
    await a.media.setLocal({ mic, cam })
    expect(listed(a).find((track) => track.kind === 'cam')?.muted).toBe(false)
  })

  it('keeps a muted microphone muted across a rebuild', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = rebuildable(sfu)
    const cam = fakeTrack('video')
    await a.media.start({ mic: fakeTrack('audio'), cam })
    await a.media.setLocal({ mic: null, cam })
    a.current().simulateState('failed')
    await vi.advanceTimersByTimeAsync(1000)
    // A kind that sends nothing is not published again until it is turned on
    expect(listed(a).map((t) => t.kind)).toEqual(['cam'])
  })

  it('subscribes again to what is desired after a rebuild', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = rebuildable(sfu)
    const b = member(sfu)
    await b.media.start({ mic: fakeTrack('audio'), cam: null })
    await a.media.start({ mic: null, cam: null })
    a.media.setDesired(listed(b))
    await vi.advanceTimersByTimeAsync(0)
    expect(Object.keys(a.media.getState().received)).toHaveLength(1)
    a.current().simulateState('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.transports).toHaveLength(2)
    expect(Object.keys(a.media.getState().received)).toHaveLength(1)
    expect(a.current().subscriptions.size).toBe(1)
  })

  it('waits for a dropped connection to come back by itself before rebuilding', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = rebuildable(sfu, { disconnectGraceMs: 4000 })
    await a.media.start({ mic: fakeTrack('audio'), cam: null })
    a.current().simulateState('reconnecting')
    expect(a.media.getState().status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(3000)
    a.current().simulateState('connected')
    expect(a.media.getState().status).toBe('connected')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.transports).toHaveLength(1)
    // Stays down this time: rebuilt after the grace and the first backoff delay
    a.current().simulateState('reconnecting')
    await vi.advanceTimersByTimeAsync(4000 + 1000)
    expect(a.transports).toHaveLength(2)
    expect(a.media.getState().status).toBe('connected')
  })

  it('backs off while it cannot connect, and gives up into failed until retry', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    let offline = false
    const create = sfu.createTransport.bind(sfu)
    vi.spyOn(sfu, 'createTransport').mockImplementation(() => {
      const transport = create()
      if (offline) {
        vi.spyOn(transport, 'connect').mockRejectedValue(new MediaTransportError('sfu_error'))
      }
      return transport
    })
    const a = rebuildable(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: null })
    offline = true
    a.current().simulateState('failed')
    const times: number[] = []
    const start = Date.now()
    let seen = a.transports.length
    while (a.media.getState().status === 'reconnecting' && Date.now() - start < 120_000) {
      await vi.advanceTimersByTimeAsync(500)
      if (a.transports.length > seen) {
        seen = a.transports.length
        times.push(Date.now() - start)
      }
    }
    expect(times.slice(0, 4)).toEqual([1000, 3000, 7000, 15_000])
    expect(a.media.getState()).toMatchObject({ status: 'failed', error: 'sfu_error' })
    // No hot loop after giving up
    const count = a.transports.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(a.transports).toHaveLength(count)
    offline = false
    a.media.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.media.getState().status).toBe('connected')
    expect(listed(a).map((t) => t.kind)).toEqual(['mic'])
  })

  it('tries at once when nudged (online, foreground) instead of waiting', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = rebuildable(sfu)
    await a.media.start({ mic: null, cam: null })
    a.current().simulateState('failed')
    expect(a.transports).toHaveLength(1)
    a.media.nudge()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.transports).toHaveLength(2)
    expect(a.media.getState().status).toBe('connected')
    // The cancelled delay does not build a third
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.transports).toHaveLength(2)
  })

  it('does not rebuild after an error a new session would not fix', async () => {
    const sfu = new FakeSfu()
    const create = sfu.createTransport.bind(sfu)
    vi.spyOn(sfu, 'createTransport').mockImplementation(() => {
      const transport = create()
      vi.spyOn(transport, 'connect').mockRejectedValue(new MediaTransportError('unauthorized'))
      return transport
    })
    const a = rebuildable(sfu)
    await a.media.start({ mic: null, cam: null })
    expect(a.media.getState()).toMatchObject({ status: 'failed', error: 'unauthorized' })
    a.media.retry()
    expect(a.transports).toHaveLength(1)
  })

  it('reports its tracks again when the room welcomes it back', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: null })
    const before = a.sent.length
    a.media.rejoined()
    expect(a.sent).toHaveLength(before + 1)
    expect(a.sent.at(-1)).toMatchObject({ t: 'tracks', sessionId: 'fake-session-1' })
  })

  it('connects with the ICE servers it is given and refreshes them before they expire', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const turn = { urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' }
    const iceConfig = vi.fn(async (): Promise<IceConfig> => ({
      connect: { iceServers: [turn], iceTransportPolicy: 'relay' },
      refreshAfterMs: 60_000,
    }))
    const a = rebuildable(sfu, { iceConfig })
    await a.media.start({ mic: null, cam: null })
    expect(a.current().connectOptions).toEqual({
      iceServers: [turn],
      iceTransportPolicy: 'relay',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(iceConfig).toHaveBeenCalledTimes(2)
    expect(a.current().iceServerUpdates).toEqual([[turn]])
    // A rebuilt session asks again
    a.current().simulateState('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(iceConfig).toHaveBeenCalledTimes(3)
  })

  it('connects with the default servers when the ICE servers cannot be fetched', async () => {
    const sfu = new FakeSfu()
    const a = rebuildable(sfu, { iceConfig: () => Promise.reject(new Error('offline')) })
    await a.media.start({ mic: null, cam: null })
    expect(a.media.getState().status).toBe('connected')
    expect(a.current().connectOptions).toEqual({})
  })

  it('reports whether its media goes through a relay', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = rebuildable(sfu, { statsIntervalMs: 10_000 })
    await a.media.start({ mic: null, cam: null })
    a.current().usingRelay = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.sent.filter((m) => m.t === 'stats').at(-1)).toMatchObject({ relay: true })
    expect(a.media.getState().usingRelay).toBe(true)
  })
})

describe('RoomMedia: sharing the screen (e3-t01)', () => {
  const kinds = (m: { sent: ClientMessage[] }) => listed(m).map((t) => t.kind)

  it('publishes the screen when sharing starts and unpublishes it when it stops', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: null })
    await b.media.start({ mic: null, cam: null })
    const screen = fakeTrack('video')
    await a.media.setScreen(screen)
    expect(kinds(a)).toEqual(['mic', 'screen'])
    expect(a.transport.sending.get(listed(a)[1].trackName)).toBe(screen)
    // Everyone else receives it like any track
    b.media.setDesired(listed(a))
    await settle()
    expect(Object.values(b.media.getState().received).map((r) => r.kind)).toEqual(['mic', 'screen'])
    await a.media.setScreen(null)
    expect(kinds(a)).toEqual(['mic'])
    expect(sfu.published.size).toBe(1)
    b.media.setDesired(listed(a))
    expect(Object.values(b.media.getState().received).map((r) => r.kind)).toEqual(['mic'])
  })

  it('shares a screen picked before the session opened once it does', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    void a.media.setScreen(fakeTrack('video'))
    await a.media.start({ mic: null, cam: null })
    await settle()
    expect(kinds(a)).toEqual(['screen'])
  })

  it('sends a screen picked again on the same track (換一個畫面: subscriptions stay)', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: null })
    await a.media.setScreen(fakeTrack('video'))
    const first = listed(a)[0].trackName
    const again = fakeTrack('video')
    await a.media.setScreen(again)
    expect(listed(a)).toHaveLength(1)
    expect(listed(a)[0].trackName).toBe(first)
    expect(a.transport.sending.get(first)).toBe(again)
  })

  it('applies the share mode to the published screen, live and again after a new screen (e3-t06)', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: null })
    // Before anything is published: remembered
    await a.media.setScreenMode('motion')
    expect(a.transport.shareModes).toEqual([])
    await a.media.setScreen(fakeTrack('video'))
    const name = listed(a)[0].trackName
    expect(a.transport.shareModes).toEqual([{ trackName: name, mode: 'motion' }])
    await a.media.setScreenMode('text')
    expect(a.transport.shareModes.at(-1)).toEqual({ trackName: name, mode: 'text' })
    // The same mode again changes nothing; a new screen gets it again (its contentHint)
    await a.media.setScreenMode('text')
    expect(a.transport.shareModes).toHaveLength(2)
    await a.media.setScreen(fakeTrack('video'))
    expect(a.transport.shareModes).toHaveLength(3)
    expect(a.transport.shareModes.at(-1)).toEqual({ trackName: name, mode: 'text' })
  })

  it('unpublishes a screen whose share stopped while it was being published', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: null })
    const publishing = a.media.setScreen(fakeTrack('video'))
    await a.media.setScreen(null)
    await publishing
    await settle()
    expect(sfu.published.size).toBe(0)
    expect(a.media.getState().published).toEqual([])
  })

  it('does not publish the screen once the month is audio-only, and says so', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: null }, 'audioOnly')
    await a.media.setScreen(fakeTrack('video'))
    expect(kinds(a)).toEqual(['mic'])
    expect(a.media.getState().screenRefused).toBe(true)
    // Stopping clears it, so the next try says it again
    await a.media.setScreen(null)
    expect(a.media.getState().screenRefused).toBe(false)
    // The proxy's own refusal reads the same
    const b = member(sfu)
    sfu.refuseVideo = true
    await b.media.start({ mic: null, cam: null })
    await b.media.setScreen(fakeTrack('video'))
    expect(b.media.getState()).toMatchObject({ screenRefused: true, error: null })
  })

  it('shares the screen again on the new session after a rebuild', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const transports: FakeTransport[] = []
    const sent: ClientMessage[] = []
    const media = new RoomMedia({
      createTransport: () => {
        const transport = sfu.createTransport()
        transports.push(transport)
        return transport
      },
      send: (m) => sent.push(m),
      backoff: new Backoff({ random: () => 0.5, giveUpAfterMs: 60_000 }),
    })
    const screen = fakeTrack('video')
    await media.start({ mic: fakeTrack('audio'), cam: null })
    await media.setScreen(screen)
    transports[0].simulateState('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(transports).toHaveLength(2)
    expect(listed({ sent })).toEqual([
      {
        sessionId: 'fake-session-2',
        trackName: expect.stringMatching(/^mic-/),
        kind: 'mic',
        muted: false,
      },
      {
        sessionId: 'fake-session-2',
        trackName: expect.stringMatching(/^screen-/),
        kind: 'screen',
        muted: false,
      },
    ])
    expect([...transports[1].sending.values()]).toContain(screen)
    await media.close()
  })
})

describe("RoomMedia: the screen's sound (e3-t04)", () => {
  const kinds = (m: { sent: ClientMessage[] }) => listed(m).map((t) => t.kind)
  const own = (m: { sent: ClientMessage[] }, kind: string) => listed(m).find((t) => t.kind === kind)

  it('publishes the sound after the screen, as a track of its own that others receive', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    const b = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: null })
    await b.media.start({ mic: null, cam: null })
    const screen = fakeTrack('video')
    const sound = fakeTrack('audio')
    await a.media.setScreen(screen, sound)
    expect(kinds(a)).toEqual(['mic', 'screen', 'screenAudio'])
    expect(own(a, 'screenAudio')).toMatchObject({ muted: false })
    expect(a.transport.sending.get(own(a, 'screenAudio')!.trackName)).toBe(sound)
    b.media.setDesired(listed(a))
    await settle()
    expect(Object.values(b.media.getState().received).map((r) => r.kind)).toEqual([
      'mic',
      'screen',
      'screenAudio',
    ])
  })

  it('turning it off and on replaces what it sends and tells the room it is muted', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: null })
    const screen = fakeTrack('video')
    const sound = fakeTrack('audio')
    await a.media.setScreen(screen, sound)
    const name = own(a, 'screenAudio')!.trackName
    const publish = vi.spyOn(a.transport, 'publish')
    await a.media.setScreen(screen, null)
    expect(own(a, 'screenAudio')).toMatchObject({ trackName: name, muted: true })
    expect(a.transport.sending.get(name)).toBeNull()
    // The screen goes on, untouched
    expect(own(a, 'screen')).toMatchObject({ muted: false })
    await a.media.setScreen(screen, sound)
    expect(own(a, 'screenAudio')).toMatchObject({ trackName: name, muted: false })
    expect(a.transport.sending.get(name)).toBe(sound)
    // No renegotiation for the switch
    expect(publish).not.toHaveBeenCalled()
  })

  it('a share without sound publishes no sound track; turned off from the start, none until on', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: null })
    const screen = fakeTrack('video')
    await a.media.setScreen(screen)
    expect(kinds(a)).toEqual(['screen'])
    await a.media.setScreen(screen, null)
    expect(kinds(a)).toEqual(['screen'])
    await a.media.setScreen(screen, fakeTrack('audio'))
    expect(kinds(a)).toEqual(['screen', 'screenAudio'])
  })

  it('unpublishes the sound with the screen; a screen picked again sends its own sound', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: null, cam: null })
    await a.media.setScreen(fakeTrack('video'), fakeTrack('audio'))
    const first = own(a, 'screenAudio')!.trackName
    // Picked again (another source, its own sound): the same tracks send the new ones
    const again = fakeTrack('audio')
    await a.media.setScreen(fakeTrack('video'), again)
    expect(kinds(a)).toEqual(['screen', 'screenAudio'])
    expect(own(a, 'screenAudio')!.trackName).toBe(first)
    expect(a.transport.sending.get(first)).toBe(again)
    // Picked again without sound: the sound track sends nothing, reported muted
    await a.media.setScreen(fakeTrack('video'), null)
    expect(a.transport.sending.get(first)).toBeNull()
    expect(own(a, 'screenAudio')!.muted).toBe(true)
    // Stopped: both go, and the sound never outlives the screen
    await a.media.setScreen(null, again)
    expect(kinds(a)).toEqual([])
    expect(sfu.published.size).toBe(0)
  })

  it('no sound goes out in an audio-only month: the screen itself is refused', async () => {
    const sfu = new FakeSfu()
    const a = member(sfu)
    await a.media.start({ mic: fakeTrack('audio'), cam: null }, 'audioOnly')
    await a.media.setScreen(fakeTrack('video'), fakeTrack('audio'))
    expect(kinds(a)).toEqual(['mic'])
    expect(a.media.getState().screenRefused).toBe(true)
  })

  it('shares the screen and its sound, as they were, on the new session after a rebuild', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const transports: FakeTransport[] = []
    const sent: ClientMessage[] = []
    const media = new RoomMedia({
      createTransport: () => {
        const transport = sfu.createTransport()
        transports.push(transport)
        return transport
      },
      send: (m) => sent.push(m),
      backoff: new Backoff({ random: () => 0.5, giveUpAfterMs: 60_000 }),
    })
    const screen = fakeTrack('video')
    const sound = fakeTrack('audio')
    await media.start({ mic: null, cam: null })
    await media.setScreen(screen, sound)
    transports[0].simulateState('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(transports).toHaveLength(2)
    expect(listed({ sent })).toEqual([
      expect.objectContaining({ sessionId: 'fake-session-2', kind: 'screen', muted: false }),
      expect.objectContaining({ sessionId: 'fake-session-2', kind: 'screenAudio', muted: false }),
    ])
    expect([...transports[1].sending.values()]).toEqual([screen, sound])
    await media.close()
  })
})

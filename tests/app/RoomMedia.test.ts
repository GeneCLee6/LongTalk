import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, MemberTrack } from '../../shared/protocol.ts'
import { FakeSfu, type FakeTransport } from '../../src/media/FakeTransport.ts'
import { MediaTransportError } from '../../src/media/MediaTransport.ts'
import { LOW_QUALITY_VIDEO, RoomMedia } from '../../src/room/RoomMedia.ts'

/** A MediaStreamTrack as far as RoomMedia and FakeTransport care */
function fakeTrack(kind: 'audio' | 'video') {
  return { kind, applyConstraints: vi.fn(async () => {}) } as unknown as MediaStreamTrack & {
    applyConstraints: ReturnType<typeof vi.fn>
  }
}

/** One member: a transport on the shared FakeSfu, a RoomMedia, and what it sent to the room */
function member(sfu: FakeSfu, options: { retryDelayMs?: number; statsIntervalMs?: number } = {}) {
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
      { t: 'stats', sessionId: 'fake-session-1', bytesReceived: 4321 },
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

  it('retries a failed subscription a few times, then waits for the list to change', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu, { retryDelayMs: 1000 })
    await a.media.start({ mic: null, cam: null })
    const ghost: MemberTrack = {
      sessionId: 'nobody',
      trackName: 'cam-1',
      kind: 'cam',
      muted: false,
    }
    const subscribe = vi.spyOn(a.transport, 'subscribe')
    a.media.setDesired([ghost])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(subscribe).toHaveBeenCalledTimes(3)
    // Gone from the list and back: a fresh start
    a.media.setDesired([])
    a.media.setDesired([ghost])
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(4)
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
    await vi.advanceTimersByTimeAsync(1000)
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

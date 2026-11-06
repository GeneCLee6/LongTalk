import { describe, expect, it, vi } from 'vitest'
import type { ClientMessage, ShareInfo } from '../../shared/protocol.ts'
import type { CaptureResult } from '../../src/media/share.ts'
import { idleShare, ScreenShare, type ShareNotice } from '../../src/room/ScreenShare.ts'
import { FakeTrack } from './media/fakeMedia.ts'

const YOU = 'm1'
/** The room's shares: one entry per member id, `since` in the order given (or as set) */
const shares = (...entries: (string | [string, number])[]): Record<string, ShareInfo> =>
  Object.fromEntries(
    entries.map((entry, i) => {
      const [memberId, since] = typeof entry === 'string' ? [entry, i + 1] : entry
      return [memberId, { memberId, since }]
    }),
  )

/** A screen track that says what it is (getSettings().displaySurface) */
class ScreenTrack extends FakeTrack {
  readonly surface: string
  constructor(surface = 'window', label = 'window:1') {
    super('video', 'screen', label)
    this.surface = surface
  }
  override getSettings() {
    return { deviceId: this.deviceId, displaySurface: this.surface } as unknown as {
      deviceId: string
    }
  }
}

function setup(results: CaptureResult[] = []) {
  const sent: ClientMessage[] = []
  const notices: ShareNotice[] = []
  const tracks: FakeTrack[] = []
  const capture = vi.fn(async (): Promise<CaptureResult> => {
    const next = results.shift()
    if (next) return next
    const track = new ScreenTrack()
    tracks.push(track)
    return { ok: true, track: track as unknown as MediaStreamTrack, audio: null }
  })
  const controller = new ScreenShare({
    capture,
    send: (message) => sent.push(message),
    notify: (notice) => notices.push(notice),
  })
  controller.setRoom({}, YOU)
  return { controller, sent, notices, tracks, capture, phase: () => controller.getState().phase }
}

describe('ScreenShare (e3-t02, e3-t03, e3-t07)', () => {
  it('picks, claims, and shares only once the room lists our share', async () => {
    const t = setup()
    await t.controller.request()
    expect(t.capture).toHaveBeenCalledTimes(1)
    expect(t.sent).toEqual([{ t: 'share' }])
    expect(t.phase()).toBe('claiming')
    t.controller.setRoom(shares(YOU), YOU)
    expect(t.controller.getState()).toEqual({
      ...idleShare,
      phase: 'sharing',
      track: t.tracks[0],
      surface: { surface: 'window', handle: null, label: 'window:1' },
    })
  })

  it('shares while others share: nobody is asked to take over (H5)', async () => {
    const t = setup()
    t.controller.setRoom(shares('m2', 'm3'), YOU)
    await t.controller.request()
    expect(t.capture).toHaveBeenCalledTimes(1)
    expect(t.sent).toEqual([{ t: 'share' }])
    t.controller.setRoom(shares('m2', 'm3', YOU), YOU)
    expect(t.phase()).toBe('sharing')
    // Someone else stopping changes nothing for us
    t.controller.setRoom(shares('m3', [YOU, 3]), YOU)
    expect(t.phase()).toBe('sharing')
    expect(t.notices).toEqual([])
  })

  it('stops by the bar or toolbar: unshare, and the capture stops', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    t.controller.stop()
    expect(t.sent.at(-1)).toEqual({ t: 'unshare' })
    expect(t.tracks[0].stopped).toBe(true)
    expect(t.phase()).toBe('idle')
    // The room catching up does not send unshare again
    t.controller.setRoom(shares(YOU), YOU)
    t.controller.setRoom({}, YOU)
    expect(t.sent.filter((m) => m.t === 'unshare')).toHaveLength(1)
  })

  it("stops when the browser's own stop button ends the capture", async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    t.tracks[0].end()
    expect(t.sent.at(-1)).toEqual({ t: 'unshare' })
    expect(t.phase()).toBe('idle')
  })

  it('closing the picker says nothing; a refusal by the system is explained', async () => {
    const t = setup([
      { ok: false, problem: 'cancelled' },
      { ok: false, problem: 'denied' },
    ])
    await t.controller.request()
    expect(t.phase()).toBe('idle')
    expect(t.notices).toEqual([])
    await t.controller.request()
    expect(t.notices).toEqual([{ type: 'problem', problem: 'denied' }])
    expect(t.sent).toEqual([])
  })

  it('stops with a notice when the room is full (share_full)', async () => {
    const t = setup()
    t.controller.setRoom(shares('m2', 'm3', 'm4'), YOU)
    await t.controller.request()
    t.controller.refused('share_full')
    expect(t.phase()).toBe('idle')
    expect(t.tracks[0].stopped).toBe(true)
    expect(t.notices).toEqual([{ type: 'full' }])
  })

  it('stops with a notice when the room ends our share (the host)', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(shares('m2', YOU), YOU)
    t.controller.setRoom(shares('m2'), YOU)
    expect(t.phase()).toBe('idle')
    expect(t.tracks[0].stopped).toBe(true)
    expect(t.notices).toEqual([{ type: 'stopped' }])
    // No unshare: the room already ended it
    expect(t.sent.filter((m) => m.t === 'unshare')).toEqual([])
  })

  it('ends a share the room still lists for us without a screen (a reload while sharing)', () => {
    const t = setup()
    t.controller.setRoom(shares([YOU, 5]), YOU)
    expect(t.sent).toEqual([{ t: 'unshare' }])
    t.controller.setRoom(shares([YOU, 5]), YOU)
    expect(t.sent).toHaveLength(1)
  })

  it('stops on audio_only with a notice', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.refused('audio_only')
    expect(t.phase()).toBe('idle')
    expect(t.tracks[0].stopped).toBe(true)
    expect(t.notices).toEqual([{ type: 'audioOnly' }])
  })

  it('sends a pending claim again after a reconnect, and stops capturing when closed', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.rejoined()
    expect(t.sent).toEqual([{ t: 'share' }, { t: 'share' }])
    t.controller.close()
    expect(t.tracks[0].stopped).toBe(true)
    // A picker still open when the page leaves: what it returns is stopped
    const u = setup()
    let resolve: (result: CaptureResult) => void = () => {}
    u.capture.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    const picking = u.controller.request()
    u.controller.close()
    const late = new FakeTrack('video', 'screen:2')
    const lateAudio = new FakeTrack('audio', 'tab-audio')
    resolve({
      ok: true,
      track: late as unknown as MediaStreamTrack,
      audio: lateAudio as unknown as MediaStreamTrack,
    })
    await picking
    expect(late.stopped).toBe(true)
    expect(lateAudio.stopped).toBe(true)
    expect(u.sent).toEqual([])
  })
})

describe('ScreenShare: 文字／動態 and the motion hint (e3-t06)', () => {
  it('starts in 文字, switches live, and keeps the mode for the next share', async () => {
    const t = setup()
    expect(t.controller.getState().mode).toBe('text')
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    t.controller.setMode('motion')
    expect(t.controller.getState()).toMatchObject({ phase: 'sharing', mode: 'motion' })
    // No message: RoomMedia applies it to the published screen
    expect(t.sent).toEqual([{ t: 'share' }])
    t.controller.stop()
    expect(t.controller.getState()).toMatchObject({ phase: 'idle', mode: 'motion' })
    const u = new ScreenShare({
      capture: async () => ({ ok: false, problem: 'cancelled' }),
      send: () => {},
      notify: () => {},
      mode: 'motion',
    })
    expect(u.getState().mode).toBe('motion')
  })

  it('hints once per screen while sharing in 文字, and not in 動態', async () => {
    const t = setup()
    t.controller.noticeMotion(true)
    // Not sharing yet: nothing
    expect(t.controller.getState().motionHint).toBe(false)
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    t.controller.noticeMotion(true)
    expect(t.controller.getState().motionHint).toBe(true)
    // It calmed down: gone, and not back for this screen
    t.controller.noticeMotion(false)
    t.controller.noticeMotion(true)
    expect(t.controller.getState().motionHint).toBe(false)
    // A screen picked again may hint again; 不用 hides it for good
    await t.controller.repick()
    t.controller.noticeMotion(true)
    expect(t.controller.getState().motionHint).toBe(true)
    t.controller.dismissMotionHint()
    t.controller.noticeMotion(false)
    t.controller.noticeMotion(true)
    expect(t.controller.getState().motionHint).toBe(false)
  })

  it('follows the hint to 動態, and gives no hint in 動態', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    t.controller.noticeMotion(true)
    t.controller.setMode('motion')
    expect(t.controller.getState()).toMatchObject({ mode: 'motion', motionHint: false })
    const u = setup()
    u.controller.setMode('motion')
    await u.controller.request()
    u.controller.setRoom(shares(YOU), YOU)
    u.controller.noticeMotion(true)
    expect(u.controller.getState().motionHint).toBe(false)
  })
})

describe('ScreenShare: 換一個畫面 (e3-t09)', () => {
  it('replaces the screen while sharing, without ending the share', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    const first = t.tracks[0]
    await t.controller.repick()
    expect(t.capture).toHaveBeenCalledTimes(2)
    expect(first.stopped).toBe(true)
    expect(t.controller.getState()).toMatchObject({
      phase: 'sharing',
      track: t.tracks[1],
      repicking: false,
    })
    // The share goes on: no unshare, no second claim
    expect(t.sent).toEqual([{ t: 'share' }])
    // The old screen's end no longer stops anything; the new one's does
    first.end()
    expect(t.phase()).toBe('sharing')
    t.tracks[1].end()
    expect(t.phase()).toBe('idle')
  })

  it('keeps the screen when the picker is closed, and explains a failure', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    t.capture.mockResolvedValueOnce({ ok: false, problem: 'cancelled' })
    await t.controller.repick()
    expect(t.controller.getState()).toMatchObject({ track: t.tracks[0], repicking: false })
    expect(t.tracks[0].stopped).toBe(false)
    t.capture.mockResolvedValueOnce({ ok: false, problem: 'failed' })
    await t.controller.repick()
    expect(t.notices).toEqual([{ type: 'problem', problem: 'failed' }])
    expect(t.phase()).toBe('sharing')
  })

  it('stops what the picker returns when the share ended meanwhile', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    let resolve: (result: CaptureResult) => void = () => {}
    t.capture.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    const picking = t.controller.repick()
    expect(t.controller.getState().repicking).toBe(true)
    t.controller.stop()
    const late = new ScreenTrack()
    resolve({ ok: true, track: late as unknown as MediaStreamTrack, audio: null })
    await picking
    expect(late.stopped).toBe(true)
    expect(t.controller.getState()).toMatchObject({ phase: 'idle', repicking: false })
  })
})

describe("ScreenShare: the share's sound (e3-t04)", () => {
  /** A capture that hands back a screen and its sound */
  function withSound() {
    const video = new ScreenTrack()
    const audio = new FakeTrack('audio', 'tab-audio')
    const t = setup([
      {
        ok: true,
        track: video as unknown as MediaStreamTrack,
        audio: audio as unknown as MediaStreamTrack,
      },
    ])
    return { ...t, video, audio }
  }

  it('keeps the sound with the screen, on at first, and the switch turns it off and on', async () => {
    const t = withSound()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    expect(t.controller.getState()).toMatchObject({
      phase: 'sharing',
      audio: t.audio,
      audioOn: true,
    })
    t.controller.toggleAudio()
    expect(t.controller.getState()).toMatchObject({ audio: t.audio, audioOn: false })
    // Turned off is not stopped: it can come back
    expect(t.audio.stopped).toBe(false)
    t.controller.toggleAudio()
    expect(t.controller.getState().audioOn).toBe(true)
    // No message for it: RoomMedia tells the room the track is muted
    expect(t.sent).toEqual([{ t: 'share' }])
  })

  it('a source without sound has no switch to press', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    t.controller.toggleAudio()
    expect(t.controller.getState()).toMatchObject({ audio: null, audioOn: true })
  })

  it('stops the sound on every way the share ends, and when another screen is picked', async () => {
    // The bar or the toolbar
    const a = withSound()
    await a.controller.request()
    a.controller.setRoom(shares(YOU), YOU)
    a.controller.stop()
    expect(a.audio.stopped).toBe(true)
    // The browser's own stop button
    const b = withSound()
    await b.controller.request()
    b.controller.setRoom(shares(YOU), YOU)
    b.video.end()
    expect(b.audio.stopped).toBe(true)
    expect(b.controller.getState()).toEqual(idleShare)
    // The host stopped it
    const c = withSound()
    await c.controller.request()
    c.controller.setRoom(shares(YOU), YOU)
    c.controller.setRoom({}, YOU)
    expect(c.audio.stopped).toBe(true)
    expect(c.notices).toEqual([{ type: 'stopped' }])
    // Turned off, then stopped: stopped too, and the next share starts with the sound on
    const d = withSound()
    await d.controller.request()
    d.controller.setRoom(shares(YOU), YOU)
    d.controller.toggleAudio()
    d.controller.stop()
    expect(d.audio.stopped).toBe(true)
    expect(d.controller.getState().audioOn).toBe(true)
    // 換一個畫面: the old sound goes with the old screen
    const e = withSound()
    await e.controller.request()
    e.controller.setRoom(shares(YOU), YOU)
    await e.controller.repick()
    expect(e.audio.stopped).toBe(true)
    expect(e.controller.getState()).toMatchObject({ audio: null, audioOn: true })
  })

  it('goes on with the screen alone when the sound ends by itself', async () => {
    const t = withSound()
    await t.controller.request()
    t.controller.setRoom(shares(YOU), YOU)
    t.audio.end()
    expect(t.controller.getState()).toMatchObject({ phase: 'sharing', track: t.video, audio: null })
    expect(t.sent.filter((m) => m.t === 'unshare')).toHaveLength(0)
  })
})

describe('ScreenShare with `prepare` (the camera guard, ShareCameraGuard.ts)', () => {
  function prepared() {
    const sent: ClientMessage[] = []
    const notices: ShareNotice[] = []
    const track = new ScreenTrack()
    let finish = () => {}
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const released = vi.fn()
    const capture = vi.fn(async (): Promise<CaptureResult> => ({
      ok: true,
      track: track as unknown as MediaStreamTrack,
      audio: null,
    }))
    const controller = new ScreenShare({
      capture,
      send: (message) => sent.push(message),
      notify: (notice) => notices.push(notice),
      prepare,
      released,
    })
    controller.setRoom({}, YOU)
    return { controller, sent, notices, track, capture, prepare, released, finish: () => finish() }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('asks the room only after `prepare` is done', async () => {
    const s = prepared()
    const running = s.controller.request()
    await tick()
    expect(s.controller.getState()).toMatchObject({ phase: 'preparing' })
    expect(s.sent).toEqual([])
    s.finish()
    await running
    expect(s.controller.getState().phase).toBe('claiming')
    expect(s.sent).toEqual([{ t: 'share' }])
    expect(s.released).not.toHaveBeenCalled()
  })

  it('does not prepare or release when the picker is closed', async () => {
    const s = prepared()
    s.capture.mockResolvedValueOnce({ ok: false, problem: 'cancelled' })
    await s.controller.request()
    expect(s.prepare).not.toHaveBeenCalled()
    expect(s.released).not.toHaveBeenCalled()
    expect(s.controller.getState().phase).toBe('idle')
  })

  it('stopping while preparing never asks the room', async () => {
    const s = prepared()
    const running = s.controller.request()
    await tick()
    s.track.end() // The browser's own stop button
    expect(s.controller.getState().phase).toBe('idle')
    expect(s.released).toHaveBeenCalledTimes(1)
    s.finish()
    await running
    expect(s.controller.getState().phase).toBe('idle')
    expect(s.sent).toEqual([])
  })

  async function sharing() {
    const s = prepared()
    const running = s.controller.request()
    await tick()
    s.finish()
    await running
    s.controller.setRoom(shares(YOU), YOU)
    expect(s.controller.getState().phase).toBe('sharing')
    return s
  }

  it('releases on every way a share ends', async () => {
    const bar = await sharing()
    bar.controller.stop()
    expect(bar.released).toHaveBeenCalledTimes(1)

    const browser = await sharing()
    browser.track.end()
    expect(browser.released).toHaveBeenCalledTimes(1)

    const host = await sharing()
    host.controller.setRoom({}, YOU)
    expect(host.released).toHaveBeenCalledTimes(1)
    expect(host.notices).toEqual([{ type: 'stopped' }])
  })

  it('releases when the room refuses the share', async () => {
    const s = prepared()
    const running = s.controller.request()
    await tick()
    s.finish()
    await running
    s.controller.refused('share_full')
    expect(s.released).toHaveBeenCalledTimes(1)
    expect(s.notices).toEqual([{ type: 'full' }])
  })

  it('does not release on leaving the room, nor for a new screen picked during the share', async () => {
    const repicked = await sharing()
    repicked.capture.mockResolvedValueOnce({
      ok: true,
      track: new ScreenTrack() as unknown as MediaStreamTrack,
      audio: null,
    })
    await repicked.controller.repick()
    expect(repicked.controller.getState().phase).toBe('sharing')
    expect(repicked.released).not.toHaveBeenCalled()
    expect(repicked.prepare).toHaveBeenCalledTimes(1)

    const left = await sharing()
    left.controller.close()
    expect(left.released).not.toHaveBeenCalled()
  })
})

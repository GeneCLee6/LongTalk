import { describe, expect, it, vi } from 'vitest'
import type { ClientMessage, ShareInfo } from '../../shared/protocol.ts'
import type { CaptureResult } from '../../src/media/share.ts'
import { idleShare, ScreenShare, type ShareNotice } from '../../src/room/ScreenShare.ts'
import { FakeTrack } from './media/fakeMedia.ts'

const YOU = 'm1'
const share = (memberId: string, since = 1): ShareInfo => ({ memberId, since })

function setup(results: CaptureResult[] = []) {
  const sent: ClientMessage[] = []
  const notices: ShareNotice[] = []
  const tracks: FakeTrack[] = []
  const capture = vi.fn(async (): Promise<CaptureResult> => {
    const next = results.shift()
    if (next) return next
    const track = new FakeTrack('video', 'screen:1')
    tracks.push(track)
    return { ok: true, track: track as unknown as MediaStreamTrack, audio: null }
  })
  const controller = new ScreenShare({
    capture,
    send: (message) => sent.push(message),
    notify: (notice) => notices.push(notice),
  })
  controller.setRoom(null, YOU)
  return { controller, sent, notices, tracks, capture, phase: () => controller.getState().phase }
}

describe('ScreenShare (e3-t02, e3-t03)', () => {
  it('picks, claims, and shares only once the room names us the sharer', async () => {
    const t = setup()
    await t.controller.request()
    expect(t.capture).toHaveBeenCalledTimes(1)
    expect(t.sent).toEqual([{ t: 'share', takeOver: false }])
    expect(t.phase()).toBe('claiming')
    t.controller.setRoom(share(YOU), YOU)
    expect(t.controller.getState()).toEqual({
      phase: 'sharing',
      track: t.tracks[0],
      audio: null,
      audioOn: true,
    })
  })

  it('stops by the bar or toolbar: unshare, and the capture stops', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(share(YOU), YOU)
    t.controller.stop()
    expect(t.sent.at(-1)).toEqual({ t: 'unshare' })
    expect(t.tracks[0].stopped).toBe(true)
    expect(t.phase()).toBe('idle')
    // The room catching up does not send unshare again
    t.controller.setRoom(share(YOU), YOU)
    t.controller.setRoom(null, YOU)
    expect(t.sent.filter((m) => m.t === 'unshare')).toHaveLength(1)
  })

  it("stops when the browser's own stop button ends the capture", async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(share(YOU), YOU)
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

  it('asks before taking over, then picks and claims with takeOver', async () => {
    const t = setup()
    t.controller.setRoom(share('m2'), YOU)
    await t.controller.request()
    expect(t.phase()).toBe('confirm')
    expect(t.capture).not.toHaveBeenCalled()
    t.controller.cancel()
    expect(t.phase()).toBe('idle')
    await t.controller.request()
    await t.controller.confirm()
    expect(t.sent).toEqual([{ t: 'share', takeOver: true }])
    t.controller.setRoom(share(YOU, 2), YOU)
    expect(t.phase()).toBe('sharing')
  })

  it('asks again with the picked screen when someone started first (share_busy)', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(share('m2'), YOU)
    t.controller.refused('share_busy')
    expect(t.controller.getState()).toMatchObject({ phase: 'confirm', track: t.tracks[0] })
    await t.controller.confirm()
    // No second picker: the screen picked before is claimed
    expect(t.capture).toHaveBeenCalledTimes(1)
    expect(t.sent.at(-1)).toEqual({ t: 'share', takeOver: true })
    // Saying no instead stops the capture
    const u = setup()
    await u.controller.request()
    u.controller.refused('share_busy')
    u.controller.cancel()
    expect(u.tracks[0].stopped).toBe(true)
    expect(u.sent).toEqual([{ t: 'share', takeOver: false }])
  })

  it('stops with a notice when someone takes over, or the room ends the share', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(share(YOU), YOU)
    t.controller.setRoom(share('m2', 2), YOU)
    expect(t.phase()).toBe('idle')
    expect(t.tracks[0].stopped).toBe(true)
    expect(t.notices).toEqual([{ type: 'takenOver', by: 'm2' }])
    // No unshare: it is not ours any more
    expect(t.sent.filter((m) => m.t === 'unshare')).toEqual([])
    await t.controller.request()
    await t.controller.confirm()
    t.controller.setRoom(share(YOU, 3), YOU)
    t.controller.setRoom(null, YOU)
    expect(t.notices.at(-1)).toEqual({ type: 'stopped' })
  })

  it('ends a share the room still lists for us without a screen (a reload while sharing)', () => {
    const t = setup()
    t.controller.setRoom(share(YOU, 5), YOU)
    expect(t.sent).toEqual([{ t: 'unshare' }])
    t.controller.setRoom(share(YOU, 5), YOU)
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
    expect(t.sent).toEqual([
      { t: 'share', takeOver: false },
      { t: 'share', takeOver: false },
    ])
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

describe("ScreenShare: the share's sound (e3-t04)", () => {
  /** A capture that hands back a screen and its sound */
  function withSound() {
    const video = new FakeTrack('video', 'screen:1')
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
    t.controller.setRoom(share(YOU), YOU)
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
    expect(t.sent).toEqual([{ t: 'share', takeOver: false }])
  })

  it('a source without sound has no switch to press', async () => {
    const t = setup()
    await t.controller.request()
    t.controller.setRoom(share(YOU), YOU)
    t.controller.toggleAudio()
    expect(t.controller.getState()).toMatchObject({ audio: null, audioOn: true })
  })

  it('stops the sound on every way the share ends', async () => {
    // The bar or the toolbar
    const a = withSound()
    await a.controller.request()
    a.controller.setRoom(share(YOU), YOU)
    a.controller.stop()
    expect(a.audio.stopped).toBe(true)
    // The browser's own stop button
    const b = withSound()
    await b.controller.request()
    b.controller.setRoom(share(YOU), YOU)
    b.video.end()
    expect(b.audio.stopped).toBe(true)
    expect(b.controller.getState()).toEqual(idleShare)
    // Someone took over
    const c = withSound()
    await c.controller.request()
    c.controller.setRoom(share(YOU), YOU)
    c.controller.setRoom(share('m2', 2), YOU)
    expect(c.audio.stopped).toBe(true)
    expect(c.notices).toEqual([{ type: 'takenOver', by: 'm2' }])
    // Turned off, then stopped: stopped too, and the next share starts with the sound on
    const d = withSound()
    await d.controller.request()
    d.controller.setRoom(share(YOU), YOU)
    d.controller.toggleAudio()
    d.controller.stop()
    expect(d.audio.stopped).toBe(true)
    expect(d.controller.getState().audioOn).toBe(true)
  })

  it('goes on with the screen alone when the sound ends by itself', async () => {
    const t = withSound()
    await t.controller.request()
    t.controller.setRoom(share(YOU), YOU)
    t.audio.end()
    expect(t.controller.getState()).toMatchObject({ phase: 'sharing', track: t.video, audio: null })
    expect(t.sent.filter((m) => m.t === 'unshare')).toHaveLength(0)
  })
})

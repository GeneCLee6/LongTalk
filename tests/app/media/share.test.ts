import { describe, expect, it, vi } from 'vitest'
import {
  captureScreen,
  DISPLAY_MEDIA_OPTIONS,
  displayMediaOptions,
  shareProblem,
} from '../../../src/media/share.ts'
import { FakeStream, FakeTrack, asStream, mediaError } from './fakeMedia.ts'

const named = (name: string, message = '') => Object.assign(new Error(message), { name })

describe('captureScreen (e3-t01)', () => {
  it('asks the picker for anything but this tab, without audio, and hands back the video', async () => {
    const video = new FakeTrack('video', 'screen:1')
    const audio = new FakeTrack('audio', 'tab-audio')
    const getDisplayMedia = vi.fn(async () => asStream(new FakeStream([video, audio])))
    const result = await captureScreen({ getDisplayMedia })
    expect(getDisplayMedia).toHaveBeenCalledWith(DISPLAY_MEDIA_OPTIONS)
    expect(DISPLAY_MEDIA_OPTIONS).toMatchObject({
      audio: false,
      selfBrowserSurface: 'exclude',
      preferCurrentTab: false,
      surfaceSwitching: 'include',
    })
    expect(result).toEqual({ ok: true, track: video, audio: null })
    expect((video as unknown as { contentHint: string }).contentHint).toBe('detail')
    // Audio nobody asked for is not kept running
    expect(audio.stopped).toBe(true)
    expect(video.stopped).toBe(false)
  })

  it("asks for the tab's or system's sound where the browser can capture it (e3-t04)", async () => {
    const video = new FakeTrack('video', 'screen:1')
    const audio = new FakeTrack('audio', 'tab-audio')
    const getDisplayMedia = vi.fn(async () => asStream(new FakeStream([video, audio])))
    const result = await captureScreen({ getDisplayMedia }, true)
    expect(getDisplayMedia).toHaveBeenCalledWith(displayMediaOptions(true))
    expect(displayMediaOptions(true)).toMatchObject({
      ...DISPLAY_MEDIA_OPTIONS,
      // Sent as it is, the sharer still hears the tab, and the meeting's own sound is left out
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: false,
        restrictOwnAudio: true,
      },
      systemAudio: 'include',
    })
    expect(result).toEqual({ ok: true, track: video, audio })
    expect(audio.stopped).toBe(false)
  })

  it('a source without sound shares the screen alone, with no error', async () => {
    const video = new FakeTrack('video', 'window:1')
    const getDisplayMedia = vi.fn(async () => asStream(new FakeStream([video])))
    expect(await captureScreen({ getDisplayMedia }, true)).toEqual({
      ok: true,
      track: video,
      audio: null,
    })
  })

  it('asks again without sound when the browser refuses the audio options outright', async () => {
    const video = new FakeTrack('video', 'screen:1')
    const getDisplayMedia = vi
      .fn()
      .mockRejectedValueOnce(named('TypeError', 'audio not supported'))
      .mockResolvedValueOnce(asStream(new FakeStream([video])))
    expect(await captureScreen({ getDisplayMedia }, true)).toEqual({
      ok: true,
      track: video,
      audio: null,
    })
    expect(getDisplayMedia).toHaveBeenLastCalledWith(DISPLAY_MEDIA_OPTIONS)
    // Without audio asked for, a TypeError is still "unsupported"
    const refusing = { getDisplayMedia: vi.fn(async () => Promise.reject(named('TypeError'))) }
    expect(await captureScreen(refusing)).toEqual({ ok: false, problem: 'unsupported' })
    expect(refusing.getDisplayMedia).toHaveBeenCalledTimes(1)
  })

  it('is unsupported without getDisplayMedia (phones)', async () => {
    expect(await captureScreen({})).toEqual({ ok: false, problem: 'unsupported' })
    expect(await captureScreen(undefined)).toEqual({ ok: false, problem: 'unsupported' })
  })

  it('sorts the failures: closing the picker is silent, the OS refusing is explained', async () => {
    const failing = (error: Error) => ({
      getDisplayMedia: vi.fn(async () => Promise.reject(error)),
    })
    expect(await captureScreen(failing(named('NotAllowedError', 'Permission denied')))).toEqual({
      ok: false,
      problem: 'cancelled',
    })
    expect(
      await captureScreen(failing(named('NotAllowedError', 'Permission denied by system'))),
    ).toEqual({ ok: false, problem: 'denied' })
    expect(await captureScreen(failing(mediaError('NotReadableError')))).toEqual({
      ok: false,
      problem: 'failed',
    })
    // A stream without video (should not happen) is a failure, not a crash
    const empty = { getDisplayMedia: vi.fn(async () => asStream(new FakeStream([]))) }
    expect(await captureScreen(empty)).toEqual({ ok: false, problem: 'failed' })
  })

  it('maps every error name it knows', () => {
    expect(shareProblem(named('AbortError'))).toBe('cancelled')
    expect(shareProblem(named('SecurityError'))).toBe('denied')
    expect(shareProblem(named('NotAllowedError', 'blocked by policy'))).toBe('denied')
    expect(shareProblem(named('TypeError'))).toBe('unsupported')
    expect(shareProblem(named('NotSupportedError'))).toBe('unsupported')
    expect(shareProblem(named('NotFoundError'))).toBe('failed')
    expect(shareProblem(null)).toBe('failed')
  })
})

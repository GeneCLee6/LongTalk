import { describe, expect, it, vi } from 'vitest'
import { captureScreen, DISPLAY_MEDIA_OPTIONS, shareProblem } from '../../../src/media/share.ts'
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
    expect(result).toEqual({ ok: true, track: video })
    expect((video as unknown as { contentHint: string }).contentHint).toBe('detail')
    // Audio nobody asked for is not kept running
    expect(audio.stopped).toBe(true)
    expect(video.stopped).toBe(false)
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

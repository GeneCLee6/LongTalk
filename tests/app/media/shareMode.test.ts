import { describe, expect, it, vi } from 'vitest'
import {
  announceMeetingTab,
  CAPTURE_HANDLE_PREFIX,
  capturedSurface,
  selfCapture,
  type CapturedSurface,
} from '../../../src/media/share.ts'
import {
  frameChange,
  isShareMode,
  MOTION_CHANGE,
  MOTION_NEEDED,
  MOTION_WINDOW,
  MotionMeter,
  PIXEL_DELTA,
  SHARE_MODE_PARAMETERS,
  withShareMode,
} from '../../../src/media/shareMode.ts'
import { chooseLayers, DOWNLINK_BUDGET_BPS, type LayerInput } from '../../../src/media/layers.ts'

const layered = [
  { rid: 'f', active: true, scaleResolutionDownBy: 1, maxBitrate: 2_500_000, maxFramerate: 30 },
  { rid: 'h', active: false, scaleResolutionDownBy: 2, maxBitrate: 600_000, maxFramerate: 15 },
]

describe('share modes (e3-t06): what the screen sender is set to', () => {
  it('文字 keeps the full capture and D1’s measured defaults: detail, balanced, up to 30 fps', () => {
    const text = SHARE_MODE_PARAMETERS.text
    expect(text.contentHint).toBe('detail')
    expect(text.degradationPreference).toBe('balanced')
    expect(withShareMode(layered, 'text', 1080)).toEqual([
      { rid: 'f', active: true, scaleResolutionDownBy: 1, maxBitrate: 2_500_000, maxFramerate: 30 },
      // `active` (the uplink's choice, e2-t15) is kept
      { rid: 'h', active: false, scaleResolutionDownBy: 2, maxBitrate: 600_000, maxFramerate: 15 },
    ])
  })

  it('動態 caps the layers at 720p and 360p, both at 30 fps, frame rate first', () => {
    const motion = SHARE_MODE_PARAMETERS.motion
    expect(motion.contentHint).toBe('motion')
    expect(motion.degradationPreference).toBe('maintain-framerate')
    const [top, second] = withShareMode(layered, 'motion', 1080)
    expect(top).toMatchObject({ rid: 'f', scaleResolutionDownBy: 1.5, maxFramerate: 30 })
    expect(second).toMatchObject({
      rid: 'h',
      active: false,
      scaleResolutionDownBy: 3,
      maxFramerate: 30,
    })
    // A 1440p screen: scaled to 720p; a small 600p window: never scaled up, its own layer scales
    expect(withShareMode(layered, 'motion', 1440)[0].scaleResolutionDownBy).toBe(2)
    expect(withShareMode(layered, 'motion', 600).map((e) => e.scaleResolutionDownBy)).toEqual([
      1, 2,
    ])
    // An unknown size: the layers' own scales
    expect(withShareMode(layered, 'motion', null).map((e) => e.scaleResolutionDownBy)).toEqual([
      1, 2,
    ])
  })

  it('a sender that refused simulcast gets the mode’s single ceiling', () => {
    expect(withShareMode([{ maxBitrate: 2_500_000 }], 'motion', 1080)).toEqual([
      { maxBitrate: 2_500_000, scaleResolutionDownBy: 1.5, maxFramerate: 30 },
    ])
    expect(withShareMode([{ maxBitrate: 2_500_000 }], 'text', 1080)).toEqual([
      { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
    ])
  })

  it('knows its modes', () => {
    expect(isShareMode('text')).toBe(true)
    expect(isShareMode('motion')).toBe(true)
    expect(isShareMode('video')).toBe(false)
  })
})

/** An RGBA frame of `pixels` grey pixels of brightness `level`, the first `changed` at `other` */
function frame(pixels: number, level: number, changed = 0, other = level) {
  const data = new Uint8ClampedArray(pixels * 4)
  for (let i = 0; i < pixels; i += 1) {
    const value = i < changed ? other : level
    data.set([value, value, value, 255], i * 4)
  }
  return data
}

describe('the dynamic-content hint (e3-t06): frame differences', () => {
  it('counts the pixels that changed brightness by more than PIXEL_DELTA', () => {
    expect(frameChange(frame(100, 100), frame(100, 100))).toBe(0)
    expect(frameChange(frame(100, 100), frame(100, 100, 10, 100 + PIXEL_DELTA + 1))).toBe(0.1)
    // Compression noise below the threshold does not count
    expect(frameChange(frame(100, 100), frame(100, 100, 50, 100 + PIXEL_DELTA - 1))).toBe(0)
    // Different sizes (the source changed): not motion
    expect(frameChange(frame(100, 100), frame(50, 0))).toBe(0)
  })

  it('says the content moves only when most of the last samples moved', () => {
    const meter = new MotionMeter()
    const moving = MOTION_CHANGE * 2
    // A scroll: two moving seconds, then still
    expect([moving, moving, 0, 0].map((c) => meter.push(c))).toEqual([false, false, false, false])
    meter.reset()
    // A video: moving second after second
    const answers = Array.from({ length: MOTION_WINDOW }, () => meter.push(moving))
    expect(answers.indexOf(true)).toBe(MOTION_NEEDED - 1)
    expect(meter.moving).toBe(true)
    // It stops: after enough still seconds, no longer moving
    for (let i = 0; i <= MOTION_WINDOW - MOTION_NEEDED; i += 1) meter.push(0)
    expect(meter.moving).toBe(false)
  })
})

describe('the self-capture guard (e3-t09)', () => {
  const surface = (s: Partial<CapturedSurface>): CapturedSurface => ({
    surface: null,
    handle: null,
    label: '',
    ...s,
  })
  const page = { pageTitle: '週會 · LongTalk', inFront: false }

  it('reads what was captured from the track', () => {
    const track = {
      label: 'web-contents-media-stream://1:2',
      getSettings: () => ({ displaySurface: 'browser' }),
      getCaptureHandle: () => ({ handle: `${CAPTURE_HANDLE_PREFIX}abc`, origin: 'x' }),
    } as unknown as MediaStreamTrack
    expect(capturedSurface(track)).toEqual({
      surface: 'browser',
      handle: `${CAPTURE_HANDLE_PREFIX}abc`,
      label: 'web-contents-media-stream://1:2',
    })
    const bare = { label: '', getSettings: () => ({}) } as unknown as MediaStreamTrack
    expect(capturedSurface(bare)).toEqual({ surface: null, handle: null, label: '' })
  })

  it('a meeting tab: its Capture Handle says so; another tab is fine', () => {
    expect(
      selfCapture(surface({ surface: 'browser', handle: `${CAPTURE_HANDLE_PREFIX}room1` }), page),
    ).toBe('meetingTab')
    expect(selfCapture(surface({ surface: 'browser', handle: 'docs:1' }), page)).toBeNull()
    expect(selfCapture(surface({ surface: 'browser' }), page)).toBeNull()
  })

  it('the meeting’s window: its title is in the window’s label (Firefox)', () => {
    expect(
      selfCapture(surface({ surface: 'window', label: '週會 · LongTalk — Mozilla Firefox' }), page),
    ).toBe('meetingWindow')
    expect(selfCapture(surface({ surface: 'window', label: 'window:1234:0' }), page)).toBeNull()
    expect(
      selfCapture(surface({ surface: 'window', label: 'anything' }), { ...page, pageTitle: ' ' }),
    ).toBeNull()
  })

  it('a whole screen: only while the meeting is in front', () => {
    expect(selfCapture(surface({ surface: 'monitor' }), page)).toBeNull()
    expect(selfCapture(surface({ surface: 'monitor' }), { ...page, inFront: true })).toBe(
      'screenWithMeeting',
    )
  })

  it('announces this tab with a handle only this site can read', () => {
    const setCaptureHandleConfig = vi.fn()
    announceMeetingTab('room1', { setCaptureHandleConfig }, 'https://longtalk.example')
    expect(setCaptureHandleConfig).toHaveBeenCalledWith({
      handle: `${CAPTURE_HANDLE_PREFIX}room1`,
      exposeOrigin: true,
      permittedOrigins: ['https://longtalk.example'],
    })
    // Not there, or refused: nothing happens
    expect(() => announceMeetingTab('room1', {}, 'https://longtalk.example')).not.toThrow()
    const refusing = vi.fn(() => {
      throw new Error('InvalidStateError')
    })
    expect(() =>
      announceMeetingTab('room1', { setCaptureHandleConfig: refusing }, 'https://x'),
    ).not.toThrow()
  })
})

describe('layers for several shares (e3-t07 with H1)', () => {
  const screen = (key: string, width: number, height: number): LayerInput => ({
    key,
    kind: 'screen',
    demand: { width, height, visible: true, aspect: 16 / 9 },
    current: null,
  })

  it('gives the main share the top layer (f) and a strip share the half layer (h)', () => {
    // 1600 × 900 device pixels in the main area; a 320 × 180 strip tile
    const chosen = chooseLayers(
      [screen('main', 1600, 900), screen('strip', 320, 180)],
      DOWNLINK_BUDGET_BPS,
    )
    expect(chosen.get('main')).toBe('high')
    expect(chosen.get('strip')).toBe('medium')
  })

  it('keeps that with three shares and cameras in the strip, under the budget', () => {
    const cams: LayerInput[] = Array.from({ length: 4 }, (_, i) => ({
      key: `cam${i}`,
      kind: 'cam',
      demand: { width: 320, height: 180, visible: true, aspect: 16 / 9 },
      current: null,
    }))
    const chosen = chooseLayers(
      [screen('main', 1600, 900), screen('s1', 320, 180), screen('s2', 320, 180), ...cams],
      DOWNLINK_BUDGET_BPS,
    )
    expect(chosen.get('main')).toBe('high')
    expect(chosen.get('s1')).toBe('medium')
    expect(chosen.get('s2')).toBe('medium')
  })
  it('judges a screen by the size it really is: a 720p window needs `f` in a 540-line main area', () => {
    const at = (
      key: string,
      w: number,
      h: number,
      received: number,
      current: 'high' | 'medium',
    ) => ({
      key,
      kind: 'screen' as const,
      demand: { width: w, height: h, visible: true, aspect: 16 / 9, sourceShortSide: received },
      current,
    })
    // Nominal 1080p: half (540) is enough for a 960 × 540 main area
    expect(chooseLayers([screen('main', 960, 540)], DOWNLINK_BUDGET_BPS).get('main')).toBe('medium')
    // The picture says the capture is 720p (720 lines at `f`, or 360 at `h`): its half is 360
    for (const [received, current] of [
      [720, 'high'],
      [360, 'medium'],
    ] as const) {
      const chosen = chooseLayers(
        [at('main', 960, 540, received, current), at('strip', 320, 180, received, current)],
        DOWNLINK_BUDGET_BPS,
      )
      expect(chosen.get('main')).toBe('high')
      expect(chosen.get('strip')).toBe('medium')
    }
    // A real 1080p capture keeps the nominal sides
    expect(
      chooseLayers([at('main', 960, 540, 540, 'medium')], DOWNLINK_BUDGET_BPS).get('main'),
    ).toBe('medium')
  })

  it('steps the main share down too once H2 lowers the budget (a struggling link)', () => {
    const chosen = chooseLayers(
      [screen('main', 1600, 900), screen('strip', 320, 180)],
      DOWNLINK_BUDGET_BPS / 2,
    )
    expect(chosen.get('main')).toBe('medium')
  })

  it('power saving (a budget of 0, H4) puts every share at its lowest layer, main too', () => {
    const chosen = chooseLayers([screen('main', 1600, 900), screen('strip', 320, 180)], 0)
    expect(chosen.get('main')).toBe('medium')
    expect(chosen.get('strip')).toBe('medium')
  })
})

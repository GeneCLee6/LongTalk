import { describe, expect, it } from 'vitest'
import doc from '../../../docs/BROWSER-SUPPORT.md?raw'
import {
  CAPABILITIES,
  canChooseSpeaker,
  canCopy,
  canMeasureLevel,
  canSuppressNoise,
  canUsePasskeys,
  canShareAudio,
  canShareScreen,
  canWebShare,
  detectCapabilities,
  shareStopsCamera,
  supportsWebRtc,
  type CapabilityEnv,
} from '../../../src/media/capabilities.ts'

// e11-t04 (AC-11.6): feature detection, and docs/BROWSER-SUPPORT.md kept in step with it.

/** A browser with everything LongTalk detects (a recent desktop Chrome) */
function fullBrowser(): CapabilityEnv {
  class MediaDevices {
    ondevicechange = null
    getUserMedia() {}
    getDisplayMedia() {}
    getSupportedConstraints() {
      return {
        deviceId: true,
        suppressLocalAudioPlayback: true,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      }
    }
  }
  class RTCRtpSender {
    replaceTrack() {}
    setParameters() {}
  }
  class HTMLMediaElement {
    setSinkId() {}
  }
  return {
    RTCPeerConnection: class {},
    RTCRtpSender,
    HTMLMediaElement,
    AudioContext: class {
      // On the prototype, as in a browser (a secure page)
      get audioWorklet() {
        return {}
      }
      createMediaStreamDestination() {}
    },
    AudioWorkletNode: class {},
    WebAssembly: { instantiate() {}, validate: () => true },
    Worker: class {},
    OffscreenCanvas: class {},
    MediaStreamTrackProcessor: class {},
    MediaStreamTrackGenerator: class {},
    VideoFrame: class {},
    MediaRecorder: class {
      static isTypeSupported(type: string) {
        return type.startsWith('video/webm')
      }
    },
    HTMLCanvasElement: class {
      captureStream() {}
    },
    indexedDB: {},
    PublicKeyCredential: class {},
    onbeforeinstallprompt: null,
    document: { fullscreenEnabled: true, createElement: () => ({ volume: 1 }) },
    navigator: {
      serviceWorker: {},
      standalone: false,
      mediaDevices: new MediaDevices(),
      clipboard: { writeText() {} },
      share() {},
      permissions: { query() {} },
      getBattery() {},
      credentials: { create() {}, get() {} },
    },
  }
}

describe('capabilities (e11-t04)', () => {
  it('finds everything in a browser that has it', () => {
    const found = detectCapabilities(fullBrowser())
    expect(Object.keys(found)).toEqual([...CAPABILITIES])
    // A precaution rather than an ability: only WebKit has it
    const { shareStopsCamera: precaution, ...abilities } = found
    expect(Object.values(abilities).every(Boolean)).toBe(true)
    expect(precaution).toBe(false)
  })

  it('advanced noise suppression needs AudioWorklet, a stream destination and WebAssembly (e6-t02)', () => {
    expect(canSuppressNoise(fullBrowser())).toBe(true)
    // An insecure page has no audioWorklet on AudioContext
    expect(canSuppressNoise({ ...fullBrowser(), AudioContext: class {} })).toBe(false)
    expect(canSuppressNoise({ ...fullBrowser(), AudioWorkletNode: undefined })).toBe(false)
    expect(canSuppressNoise({ ...fullBrowser(), WebAssembly: undefined })).toBe(false)
    // SharedArrayBuffer (cross-origin isolation) is not asked for
    expect('SharedArrayBuffer' in fullBrowser()).toBe(false)
  })

  it('passkeys need PublicKeyCredential and navigator.credentials (I2)', () => {
    expect(canUsePasskeys(fullBrowser())).toBe(true)
    expect(canUsePasskeys({ ...fullBrowser(), PublicKeyCredential: undefined })).toBe(false)
    expect(canUsePasskeys({ ...fullBrowser(), navigator: {} })).toBe(false)
  })

  it('finds nothing in an environment without browser APIs', () => {
    const found = detectCapabilities({})
    expect(Object.values(found).some(Boolean)).toBe(false)
  })

  it('a phone: calls and devices, but no screen share or speaker choice', () => {
    const phone = fullBrowser()
    phone.navigator = { mediaDevices: { getUserMedia() {}, ondevicechange: null } }
    phone.HTMLMediaElement = { prototype: {} }
    expect(detectCapabilities(phone)).toMatchObject({
      webrtc: true,
      getUserMedia: true,
      getDisplayMedia: false,
      setSinkId: false,
    })
    expect(canShareScreen(phone)).toBe(false)
    expect(canChooseSpeaker(phone)).toBe(false)
  })

  it('an http: page has WebRTC but no devices (navigator.mediaDevices is missing)', () => {
    const insecure = { ...fullBrowser(), navigator: {} }
    expect(supportsWebRtc(insecure)).toBe(true)
    expect(detectCapabilities(insecure)).toMatchObject({
      getUserMedia: false,
      getDisplayMedia: false,
      deviceChange: false,
    })
  })

  it('needs RTCPeerConnection to be a constructor, and AudioContext for the meter', () => {
    expect(supportsWebRtc({ RTCPeerConnection: undefined })).toBe(false)
    expect(supportsWebRtc({ RTCPeerConnection: {} })).toBe(false)
    expect(canMeasureLevel({})).toBe(false)
    expect(canMeasureLevel({ AudioContext: class {} })).toBe(true)
  })

  it('copies the link with the clipboard API, and shares it with Web Share when there is one', () => {
    expect(canCopy(fullBrowser())).toBe(true)
    expect(canWebShare(fullBrowser())).toBe(true)
    // Firefox on the desktop: a clipboard, no share sheet; an http: page: neither
    expect(canWebShare({ navigator: { clipboard: { writeText() {} } } })).toBe(false)
    expect(canCopy({ navigator: { share: 'not a function' } })).toBe(false)
    expect(canWebShare({ navigator: { share: 'not a function' } })).toBe(false)
  })

  it("shares the tab's or system's sound only where the display-audio constraint is known (D2)", () => {
    expect(canShareAudio(fullBrowser())).toBe(true)
    // Firefox and Safari: getDisplayMedia, but no display audio
    const noDisplayAudio = fullBrowser()
    noDisplayAudio.navigator = {
      mediaDevices: { getDisplayMedia() {}, getSupportedConstraints: () => ({ deviceId: true }) },
    }
    expect(canShareScreen(noDisplayAudio)).toBe(true)
    expect(canShareAudio(noDisplayAudio)).toBe(false)
    // No getSupportedConstraints, or one that throws: no
    expect(canShareAudio({ navigator: { mediaDevices: { getDisplayMedia() {} } } })).toBe(false)
    const throwing = {
      getDisplayMedia() {},
      getSupportedConstraints() {
        throw new Error('no')
      },
    }
    expect(canShareAudio({ navigator: { mediaDevices: throwing } })).toBe(false)
    // A phone: no screen, so no sound of it either
    const phone = {
      getUserMedia() {},
      getSupportedConstraints: () => ({ suppressLocalAudioPlayback: true }),
    }
    expect(canShareAudio({ navigator: { mediaDevices: phone } })).toBe(false)
  })

  it('looks at the real globals by default', () => {
    // jsdom: RTCPeerConnection comes from tests/setup.ts; no setSinkId, no mediaDevices
    expect(supportsWebRtc()).toBe(true)
    expect(canChooseSpeaker()).toBe('setSinkId' in HTMLMediaElement.prototype)
    expect(canShareScreen()).toBe(false)
    expect(canShareAudio()).toBe(false)
  })
})

describe('shareStopsCamera (ADR-001 「WebKit 同時送鏡頭與分享」)', () => {
  const browser = (vendor: string, share = true): CapabilityEnv => ({
    navigator: { vendor, mediaDevices: share ? { getDisplayMedia() {} } : {} },
  })

  it('is on for WebKit that can share (Mac Safari)', () => {
    expect(shareStopsCamera(browser('Apple Computer, Inc.'))).toBe(true)
  })

  it('is off for Chrome, Edge and Firefox', () => {
    expect(shareStopsCamera(browser('Google Inc.'))).toBe(false)
    expect(shareStopsCamera(browser(''))).toBe(false)
    expect(shareStopsCamera(fullBrowser())).toBe(false)
  })

  it('is off for WebKit that cannot share (iPhone, iPad)', () => {
    expect(shareStopsCamera(browser('Apple Computer, Inc.', false))).toBe(false)
  })
})

describe('docs/BROWSER-SUPPORT.md (AC-11.6)', () => {
  /** The feature table: rows whose second cell is a single `key` */
  const rows = doc
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length > 3 && /^`\w+`$/.test(cells[2] ?? ''))

  it('has a row for every capability, in the same order, and none other', () => {
    expect(rows.map((cells) => cells[2]?.slice(1, -1))).toEqual([...CAPABILITIES])
  })

  it('marks every browser in every row', () => {
    for (const cells of rows) {
      // | feature | key | six browsers | what LongTalk does |
      const browsers = cells.slice(3, 9)
      expect(browsers, cells[2]).toHaveLength(6)
      for (const mark of browsers) expect(mark, cells[2]).toMatch(/^[●○✕?]/)
      expect(cells[9], cells[2]).not.toBe('')
    }
  })

  it('has the six browsers as its columns, in order (e2-t16)', () => {
    const header = doc
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes('| `capabilities.ts` |'))
      ?.split('|')
      .map((cell) => cell.trim())
    expect(header?.slice(3, 9)).toEqual([
      'Chrome',
      'Edge',
      'Firefox',
      'Safari（macOS）',
      'iOS Safari',
      'Android Chrome',
    ])
  })

  it('says ● CI only where CI runs that engine: Chrome, Firefox and Safari (e2-t16)', () => {
    // Playwright's Chromium, Firefox and WebKit (e2e/local/browsers.spec.ts, e2e/crossbrowser.spec.ts)
    const ciColumns = [0, 2, 3]
    for (const cells of rows) {
      cells.slice(3, 9).forEach((mark, column) => {
        if (mark.startsWith('● CI'))
          expect(ciColumns, `${cells[2]} column ${column}`).toContain(column)
      })
    }
  })
})

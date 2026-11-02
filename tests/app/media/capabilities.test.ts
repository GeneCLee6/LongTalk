import { describe, expect, it } from 'vitest'
import doc from '../../../docs/BROWSER-SUPPORT.md?raw'
import {
  CAPABILITIES,
  canChooseSpeaker,
  canCopy,
  canMeasureLevel,
  canShareScreen,
  canWebShare,
  detectCapabilities,
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
    AudioContext: class {},
    navigator: { mediaDevices: new MediaDevices(), clipboard: { writeText() {} }, share() {} },
  }
}

describe('capabilities (e11-t04)', () => {
  it('finds everything in a browser that has it', () => {
    const found = detectCapabilities(fullBrowser())
    expect(Object.keys(found)).toEqual([...CAPABILITIES])
    expect(Object.values(found).every(Boolean)).toBe(true)
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

  it('looks at the real globals by default', () => {
    // jsdom: RTCPeerConnection comes from tests/setup.ts; no setSinkId, no mediaDevices
    expect(supportsWebRtc()).toBe(true)
    expect(canChooseSpeaker()).toBe('setSinkId' in HTMLMediaElement.prototype)
    expect(canShareScreen()).toBe(false)
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
})

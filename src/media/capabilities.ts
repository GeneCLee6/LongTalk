// What this browser can do (e11-t04), found by feature detection, never by reading the user agent:
// the app asks here before offering a feature, and hides or explains what is missing. Every key
// of Capabilities is a row of docs/BROWSER-SUPPORT.md (the doc writes the key in backticks), and
// tests/app/media/capabilities.test.ts fails when the two drift apart: add a capability here and
// a row there together.
//
// Detection says an API exists, not that it works well: how each browser really behaves is in the
// doc, from tests on real devices.

export interface Capabilities {
  /** RTCPeerConnection: being in a call at all; without it the room says "use another browser" */
  webrtc: boolean
  /** navigator.mediaDevices.getUserMedia: microphone and camera (only on HTTPS or localhost) */
  getUserMedia: boolean
  /** navigator.mediaDevices.getDisplayMedia: sharing the screen (not on phones; D1) */
  getDisplayMedia: boolean
  /** HTMLMediaElement.setSinkId: choosing the speaker; without it the speaker menu is hidden */
  setSinkId: boolean
  /** RTCRtpSender.replaceTrack: muting and switching devices without renegotiating (B2) */
  replaceTrack: boolean
  /** RTCRtpSender.setParameters: what simulcast layers (e2-t11) and bitrate limits need */
  senderParameters: boolean
  /** AudioContext: the microphone level meter; without it the meter stays empty */
  audioContext: boolean
  /** The `devicechange` event: noticing a device plugged in or out (B2) */
  deviceChange: boolean
}

export type Capability = keyof Capabilities

/** Every capability, in the order of the doc's table */
export const CAPABILITIES: readonly Capability[] = [
  'webrtc',
  'getUserMedia',
  'getDisplayMedia',
  'setSinkId',
  'replaceTrack',
  'senderParameters',
  'audioContext',
  'deviceChange',
]

/** Where detection looks: the browser's globals, or a stand-in in tests */
export interface CapabilityEnv {
  RTCPeerConnection?: unknown
  RTCRtpSender?: { prototype: object }
  HTMLMediaElement?: { prototype: object }
  AudioContext?: unknown
  navigator?: { mediaDevices?: object | null }
}

const browser = (): CapabilityEnv => globalThis as unknown as CapabilityEnv

const has = (target: object | null | undefined, name: string): boolean => !!target && name in target

/** Whether this browser can be in a call at all (RTCPeerConnection) */
export function supportsWebRtc(env: CapabilityEnv = browser()): boolean {
  return typeof env.RTCPeerConnection === 'function'
}

/** Whether this browser can choose the speaker (HTMLMediaElement.setSinkId) */
export function canChooseSpeaker(env: CapabilityEnv = browser()): boolean {
  return has(env.HTMLMediaElement?.prototype, 'setSinkId')
}

/** Whether this browser can share the screen (getDisplayMedia: desktop browsers only) */
export function canShareScreen(env: CapabilityEnv = browser()): boolean {
  return has(env.navigator?.mediaDevices, 'getDisplayMedia')
}

/** Whether the microphone level can be measured (AudioContext) */
export function canMeasureLevel(env: CapabilityEnv = browser()): boolean {
  return typeof env.AudioContext === 'function'
}

/** Everything at once (the doc's table, for this browser) */
export function detectCapabilities(env: CapabilityEnv = browser()): Capabilities {
  const devices = env.navigator?.mediaDevices
  const sender = env.RTCRtpSender?.prototype
  return {
    webrtc: supportsWebRtc(env),
    getUserMedia: has(devices, 'getUserMedia'),
    getDisplayMedia: canShareScreen(env),
    setSinkId: canChooseSpeaker(env),
    replaceTrack: has(sender, 'replaceTrack'),
    senderParameters: has(sender, 'setParameters'),
    audioContext: canMeasureLevel(env),
    deviceChange: has(devices, 'ondevicechange'),
  }
}

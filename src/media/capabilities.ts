// What this browser can do (e11-t04), found by feature detection, never by reading the user agent:
// the app asks here before offering a feature, and hides or explains what is missing. Every key
// of Capabilities is a row of docs/BROWSER-SUPPORT.md (the doc writes the key in backticks), and
// tests/app/media/capabilities.test.ts fails when the two drift apart: add a capability here and
// a row there together.
//
// Detection says an API exists, not that it works well: how each browser really behaves is in the
// doc, from tests on real devices.

import { PROCESSING_KEYS, type ProcessingKey } from './audioProcessing.ts'

export interface Capabilities {
  /** RTCPeerConnection: being in a call at all; without it the room says "use another browser" */
  webrtc: boolean
  /** navigator.mediaDevices.getUserMedia: microphone and camera (only on HTTPS or localhost) */
  getUserMedia: boolean
  /** navigator.mediaDevices.getDisplayMedia: sharing the screen (not on phones; D1) */
  getDisplayMedia: boolean
  /**
   * The share's own sound (tab or system audio, D2): getDisplayMedia plus the display-audio
   * constraint `suppressLocalAudioPlayback`, which only browsers that capture that sound know
   * (Chromium); without it the picker is not asked for audio and the sharing bar has no switch
   */
  shareAudio: boolean
  /** HTMLMediaElement.setSinkId: choosing the speaker; without it the speaker menu is hidden */
  setSinkId: boolean
  /** RTCRtpSender.replaceTrack: muting and switching devices without renegotiating (B2) */
  replaceTrack: boolean
  /** RTCRtpSender.setParameters: what simulcast layers (e2-t11) and bitrate limits need */
  senderParameters: boolean
  /** AudioContext: the microphone level meter; without it the meter stays empty */
  audioContext: boolean
  /**
   * The microphone processing switches (e6-t01): getSupportedConstraints knows
   * `noiseSuppression`, `echoCancellation` or `autoGainControl`; a switch the browser does not
   * know is not shown
   */
  audioProcessing: boolean
  /**
   * The advanced noise suppression (e6-t02): AudioContext with `audioWorklet` (only in secure
   * contexts), AudioWorkletNode, a MediaStream destination and WebAssembly; RNNoise runs in the
   * worklet. SharedArrayBuffer is not needed. Without it the switch is not shown.
   */
  advancedNoiseSuppression: boolean
  /** The `devicechange` event: noticing a device plugged in or out (B2) */
  deviceChange: boolean
  /** navigator.clipboard.writeText: the top bar's copy link (only on HTTPS or localhost) */
  clipboard: boolean
  /** navigator.share (Web Share API): the share sheet for the room link (mostly phones) */
  webShare: boolean
  /**
   * navigator.permissions.query (G1): the pre-join screen reads the camera and microphone
   * permissions, so it can tell a system block from a browser one and retry once allowed
   */
  permissions: boolean
  /** navigator.serviceWorker (G4): the app shell opens offline and says when a new version is out */
  serviceWorker: boolean
  /**
   * The `beforeinstallprompt` event (G4, Chromium): the home page's 「安裝 LongTalk」 button opens
   * the browser's own install dialog
   */
  installPrompt: boolean
  /**
   * navigator.standalone (G4: iOS and iPadOS Safari, which have no install dialog): the home page
   * shows a one-time hint 「分享 › 加入主畫面」 instead
   */
  homeScreenHint: boolean
  /**
   * navigator.getBattery (the Battery Status API, Chromium only; e6-t05): a low battery suggests
   * 省電模式 once; elsewhere there is no suggestion (the mode itself works everywhere)
   */
  battery: boolean
}

export type Capability = keyof Capabilities

/** Every capability, in the order of the doc's table */
export const CAPABILITIES: readonly Capability[] = [
  'webrtc',
  'getUserMedia',
  'getDisplayMedia',
  'shareAudio',
  'setSinkId',
  'replaceTrack',
  'senderParameters',
  'audioContext',
  'audioProcessing',
  'advancedNoiseSuppression',
  'deviceChange',
  'clipboard',
  'webShare',
  'permissions',
  'serviceWorker',
  'installPrompt',
  'homeScreenHint',
  'battery',
]

/** Where detection looks: the browser's globals, or a stand-in in tests */
export interface CapabilityEnv {
  RTCPeerConnection?: unknown
  RTCRtpSender?: { prototype: object }
  HTMLMediaElement?: { prototype: object }
  AudioContext?: unknown
  AudioWorkletNode?: unknown
  WebAssembly?: { instantiate?: unknown }
  onbeforeinstallprompt?: unknown
  navigator?: {
    serviceWorker?: object | null
    standalone?: boolean
    mediaDevices?: object | null
    clipboard?: object | null
    share?: unknown
    permissions?: object | null
    getBattery?: unknown
  }
}

/** The bits of BatteryManager the low-battery hint reads */
export interface BatteryLike extends EventTarget {
  level: number
  charging: boolean
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

/** Whether the share can carry its tab's or the system's sound (Chromium on the desktop) */
export function canShareAudio(env: CapabilityEnv = browser()): boolean {
  if (!canShareScreen(env)) return false
  const devices = env.navigator?.mediaDevices as {
    getSupportedConstraints?: () => Record<string, boolean | undefined>
  }
  if (typeof devices.getSupportedConstraints !== 'function') return false
  try {
    return devices.getSupportedConstraints().suppressLocalAudioPlayback === true
  } catch {
    return false
  }
}

/**
 * Which microphone processing switches this browser knows (e6-t01), from
 * getSupportedConstraints; none where it cannot say
 */
export function audioProcessingSupport(env: CapabilityEnv = browser()): ProcessingKey[] {
  const devices = env.navigator?.mediaDevices as
    { getSupportedConstraints?: () => Record<string, boolean | undefined> } | null | undefined
  if (typeof devices?.getSupportedConstraints !== 'function') return []
  try {
    const supported = devices.getSupportedConstraints()
    return PROCESSING_KEYS.filter((key) => supported[key] === true)
  } catch {
    return []
  }
}

/** Whether the microphone level can be measured (AudioContext) */
export function canMeasureLevel(env: CapabilityEnv = browser()): boolean {
  return typeof env.AudioContext === 'function'
}

/**
 * Whether the advanced noise suppression can run (e6-t02): an AudioWorklet that can take the
 * microphone and give a track back, and WebAssembly for RNNoise
 */
export function canSuppressNoise(env: CapabilityEnv = browser()): boolean {
  if (typeof env.AudioContext !== 'function' || typeof env.AudioWorkletNode !== 'function') {
    return false
  }
  const context = (env.AudioContext as { prototype?: object }).prototype
  return (
    has(context, 'audioWorklet') &&
    has(context, 'createMediaStreamDestination') &&
    typeof env.WebAssembly?.instantiate === 'function'
  )
}

/** Whether text can be copied to the clipboard (navigator.clipboard.writeText) */
export function canCopy(env: CapabilityEnv = browser()): boolean {
  return has(env.navigator?.clipboard, 'writeText')
}

/** Whether the system share sheet is there (navigator.share: phones, Safari, Chrome on Windows) */
export function canWebShare(env: CapabilityEnv = browser()): boolean {
  return typeof env.navigator?.share === 'function'
}

/** Whether permissions can be read (navigator.permissions.query) */
export function canQueryPermissions(env: CapabilityEnv = browser()): boolean {
  return has(env.navigator?.permissions, 'query')
}

/** Whether a service worker can keep the app shell (navigator.serviceWorker; HTTPS or localhost) */
export function canUseServiceWorker(env: CapabilityEnv = browser()): boolean {
  return !!env.navigator?.serviceWorker
}

/** Whether the browser offers its own install dialog (`beforeinstallprompt`: Chromium) */
export function canPromptInstall(env: CapabilityEnv = browser()): boolean {
  return 'onbeforeinstallprompt' in (env as object)
}

/**
 * Whether this is the browser that installs from its share sheet, 「加入主畫面」 (iOS and iPadOS
 * Safari: the only ones with navigator.standalone)
 */
export function hasHomeScreenHint(env: CapabilityEnv = browser()): boolean {
  return typeof env.navigator?.standalone === 'boolean'
}

/** Whether the battery level can be read (navigator.getBattery: Chromium) */
export function canReadBattery(env: CapabilityEnv = browser()): boolean {
  return typeof env.navigator?.getBattery === 'function'
}

/** The battery, where the browser tells it; null elsewhere */
export function batteryManager(env: CapabilityEnv = browser()): Promise<BatteryLike> | null {
  if (!canReadBattery(env)) return null
  try {
    const navigator = env.navigator as { getBattery: () => Promise<BatteryLike> }
    return navigator.getBattery()
  } catch {
    return null
  }
}

/** Everything at once (the doc's table, for this browser) */
export function detectCapabilities(env: CapabilityEnv = browser()): Capabilities {
  const devices = env.navigator?.mediaDevices
  const sender = env.RTCRtpSender?.prototype
  return {
    webrtc: supportsWebRtc(env),
    getUserMedia: has(devices, 'getUserMedia'),
    getDisplayMedia: canShareScreen(env),
    shareAudio: canShareAudio(env),
    setSinkId: canChooseSpeaker(env),
    replaceTrack: has(sender, 'replaceTrack'),
    senderParameters: has(sender, 'setParameters'),
    audioContext: canMeasureLevel(env),
    audioProcessing: audioProcessingSupport(env).length > 0,
    advancedNoiseSuppression: canSuppressNoise(env),
    deviceChange: has(devices, 'ondevicechange'),
    clipboard: canCopy(env),
    webShare: canWebShare(env),
    permissions: canQueryPermissions(env),
    serviceWorker: canUseServiceWorker(env),
    installPrompt: canPromptInstall(env),
    homeScreenHint: hasHomeScreenHint(env),
    battery: canReadBattery(env),
  }
}

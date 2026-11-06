// What this browser can do (e11-t04), found by feature detection, never by reading the user agent:
// the app asks here before offering a feature, and hides or explains what is missing. Every key
// of Capabilities is a row of docs/BROWSER-SUPPORT.md (the doc writes the key in backticks), and
// tests/app/media/capabilities.test.ts fails when the two drift apart: add a capability here and
// a row there together.
//
// Detection says an API exists, not that it works well: how each browser really behaves is in the
// doc, from tests on real devices.

import { pickMimeType } from '../record/format.ts'
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
  /**
   * Local recording (I4, e8-t03): MediaRecorder writing one of the formats in
   * src/record/format.ts (WebM, or MP4 on Safari), canvas.captureStream for the picture, an
   * AudioContext with a MediaStream destination for the mix, and IndexedDB for the chunks.
   * Without it 更多 › 開始錄影 is grey and says why
   */
  localRecording: boolean
  /**
   * Passkeys (I2, e1-t12): PublicKeyCredential and navigator.credentials (only in secure
   * contexts). Without them /me says this browser cannot sign in and accounts stay out of reach;
   * everything else works without an account
   */
  passkeys: boolean
  /**
   * document.fullscreenEnabled (e3-t11): a share can fill the screen. Not on iPhone Safari, where
   * only <video> has its own player; there the fullscreen button is left out (zoom still works)
   */
  fullscreen: boolean
  /**
   * 背景模糊 (e6-t06): a worker, OffscreenCanvas and WebAssembly with SIMD for the model, and a way
   * to take the camera's frames in and send drawn ones out (blurPath). Without it the switch is
   * not shown.
   */
  backgroundBlur: boolean
  /**
   * <audio>.volume can be changed (e6-t08): each person's receive volume. Not on iPhone and iPad,
   * where it is read-only: there the slider is left out and the panel says why
   */
  memberVolume: boolean
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
  'localRecording',
  'passkeys',
  'fullscreen',
  'backgroundBlur',
  'memberVolume',
]

/** Where detection looks: the browser's globals, or a stand-in in tests */
export interface CapabilityEnv {
  RTCPeerConnection?: unknown
  RTCRtpSender?: { prototype: object }
  HTMLMediaElement?: { prototype: object }
  AudioContext?: unknown
  AudioWorkletNode?: unknown
  WebAssembly?: { instantiate?: unknown; validate?: (bytes: Uint8Array<ArrayBuffer>) => boolean }
  MediaRecorder?: unknown
  HTMLCanvasElement?: { prototype: object }
  indexedDB?: unknown
  PublicKeyCredential?: unknown
  onbeforeinstallprompt?: unknown
  Worker?: unknown
  OffscreenCanvas?: unknown
  MediaStreamTrackProcessor?: unknown
  MediaStreamTrackGenerator?: unknown
  VideoFrame?: unknown
  document?: {
    fullscreenEnabled?: boolean
    createElement?: (tag: 'audio') => { volume: number }
  }
  navigator?: {
    serviceWorker?: object | null
    standalone?: boolean
    mediaDevices?: object | null
    clipboard?: object | null
    share?: unknown
    permissions?: object | null
    getBattery?: unknown
    credentials?: object | null
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

/**
 * Whether this browser can record the meeting itself (I4, e8-t03): MediaRecorder with a format
 * it writes, a canvas it can capture, Web Audio to mix into, IndexedDB to keep the chunks
 */
export function canRecordLocally(env: CapabilityEnv = browser()): boolean {
  const recorder: unknown = env.MediaRecorder
  if (typeof recorder !== 'function') return false
  const { isTypeSupported } = recorder as { isTypeSupported?: unknown }
  if (typeof isTypeSupported !== 'function') return false
  const context = (env.AudioContext as { prototype?: object } | undefined)?.prototype
  if (
    !has(env.HTMLCanvasElement?.prototype, 'captureStream') ||
    !has(context, 'createMediaStreamDestination') ||
    !env.indexedDB
  ) {
    return false
  }
  return pickMimeType((type) => isTypeSupported.call(recorder, type) === true, false) !== null
}

/** Whether this browser can make and use passkeys (I2): WebAuthn in a secure context */
export function canUsePasskeys(env: CapabilityEnv = browser()): boolean {
  return (
    typeof env.PublicKeyCredential === 'function' &&
    has(env.navigator?.credentials, 'create') &&
    has(env.navigator?.credentials, 'get')
  )
}

/** Whether an element can fill the screen (document.fullscreenEnabled) */
export function canFullscreen(env: CapabilityEnv = browser()): boolean {
  return env.document?.fullscreenEnabled === true
}

/** How 背景模糊 takes the camera's frames in and sends drawn ones out (media/backgroundBlur.ts) */
export type BlurPath = 'insertable' | 'canvas'

/** A minimal module using a v128 instruction: valid only where WebAssembly has SIMD */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
])

/** How this browser would run 背景模糊; null where it cannot */
export function blurPath(env: CapabilityEnv = browser()): BlurPath | null {
  if (typeof env.Worker !== 'function' || typeof env.OffscreenCanvas !== 'function') return null
  try {
    if (env.WebAssembly?.validate?.(SIMD_PROBE) !== true) return null
  } catch {
    return null
  }
  if (
    typeof env.MediaStreamTrackProcessor === 'function' &&
    typeof env.MediaStreamTrackGenerator === 'function' &&
    typeof env.VideoFrame === 'function'
  ) {
    return 'insertable'
  }
  return has(env.HTMLCanvasElement?.prototype, 'captureStream') ? 'canvas' : null
}

export function canBlurBackground(env: CapabilityEnv = browser()): boolean {
  return blurPath(env) !== null
}

/** Whether <audio>.volume takes a new value (iOS Safari keeps it at 1, whatever is set) */
export function canSetMemberVolume(env: CapabilityEnv = browser()): boolean {
  try {
    const audio = env.document?.createElement?.('audio')
    if (!audio) return false
    audio.volume = 0.5
    return audio.volume === 0.5
  } catch {
    return false
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
    localRecording: canRecordLocally(env),
    passkeys: canUsePasskeys(env),
    fullscreen: canFullscreen(env),
    backgroundBlur: canBlurBackground(env),
    memberVolume: canSetMemberVolume(env),
  }
}

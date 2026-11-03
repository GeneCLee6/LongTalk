import { isLayoutChoice, type LayoutChoice } from '../../shared/layout.ts'
import { isClientId, isSessionToken, normalizeName } from '../../shared/protocol.ts'
import {
  DEFAULT_PROCESSING,
  PROCESSING_KEYS,
  type AudioProcessing,
} from '../media/audioProcessing.ts'

// What the browser remembers between visits (AC-1.2, AC-4.2):
// - the display name, in localStorage: every room, every tab;
// - the chosen microphone, camera and speaker (e2-t06), in localStorage: the pre-join screen
//   and the room read and write the same choice. G1 (e4-t09) keeps each one's label too: Safari
//   and Firefox give a site new device ids now and then (and every browser does after its data is
//   cleared), so a remembered id that is gone is looked up again by its label (resolveDevice);
// - the room's session token, in sessionStorage: it survives a reload of the tab, but a second
//   tab (or the next visit) joins as someone new instead of taking the first tab's place;
// - this browser's own random id (F1), in localStorage: every `join` carries it, and a member the
//   host removes is banned by it for 10 minutes. Without accounts nothing better identifies a
//   browser; a private window, another browser or clearing the site's data gets a new one;
// - how the stage looks (G2): the layout chosen on a desktop and 隱藏自己, in localStorage. Pins
//   and 隱藏沒有視訊的人 are not remembered: they are for this meeting (someone hidden by the
//   latter would otherwise be missing from the next meeting with no sign why).
// - 更多's switches (G3): 音效 and 隱藏表情反應, in localStorage.
// - the settings panel's media choices (H3): the microphone's processing and HD, in localStorage.
// Storage can be missing or throw (private mode, blocked cookies): then nothing is remembered.

const NAME_KEY = 'longtalk.name'
const DEVICES_KEY = 'longtalk.devices'
const DEVICE_LABELS_KEY = 'longtalk.deviceLabels'
const CLIENT_KEY = 'longtalk.client'
const VIEW_KEY = 'longtalk.view'
const PREFS_KEY = 'longtalk.prefs'
const MEDIA_KEY = 'longtalk.media'
const tokenKey = (roomId: string) => `longtalk.session.${roomId}`

function storage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return globalThis[kind] ?? null
  } catch {
    return null
  }
}

function read(kind: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(kind: 'localStorage' | 'sessionStorage', key: string, value: string | null): void {
  try {
    const store = storage(kind)
    if (value === null) store?.removeItem(key)
    else store?.setItem(key, value)
  } catch {
    // Full or blocked: the name or session is simply not remembered
  }
}

export function loadName(): string {
  return normalizeName(read('localStorage', NAME_KEY)) ?? ''
}

export function saveName(name: string): void {
  write('localStorage', NAME_KEY, name)
}

/** The token this tab was given in the room, if it joined and did not leave */
export function loadSession(roomId: string): string | null {
  const token = read('sessionStorage', tokenKey(roomId))
  return isSessionToken(token) ? token : null
}

export function saveSession(roomId: string, token: string): void {
  write('sessionStorage', tokenKey(roomId), token)
}

export function clearSession(roomId: string): void {
  write('sessionStorage', tokenKey(roomId), null)
}

/** Kept for the page's life when storage is blocked: one id per tab then */
let memoryClientId: string | null = null

/** This browser's own id (F1): made once, then the same in every room and tab */
export function loadClientId(): string {
  const saved = read('localStorage', CLIENT_KEY)
  if (isClientId(saved)) return saved
  memoryClientId ??= newClientId()
  write('localStorage', CLIENT_KEY, memoryClientId)
  return memoryClientId
}

/** 16 random bytes, base64url without padding (22 characters) */
function newClientId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Which device of each kind the person chose last (null: the browser's default) */
export type DeviceChoices = Record<'mic' | 'cam' | 'speaker', string | null>

export const defaultDevices = (): DeviceChoices => ({ mic: null, cam: null, speaker: null })

const isDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512

export function loadDevices(): DeviceChoices {
  const choices = defaultDevices()
  try {
    const saved = JSON.parse(read('localStorage', DEVICES_KEY) ?? '{}') as Record<string, unknown>
    for (const kind of ['mic', 'cam', 'speaker'] as const) {
      if (isDeviceId(saved[kind])) choices[kind] = saved[kind]
    }
  } catch {
    // Unreadable: start from the defaults
  }
  return choices
}

/** The label of each remembered device (G1), for when its id has changed; null when unknown */
export function loadDeviceLabels(): DeviceChoices {
  const labels = defaultDevices()
  try {
    const saved = JSON.parse(read('localStorage', DEVICE_LABELS_KEY) ?? '{}') as Record<
      string,
      unknown
    >
    for (const kind of ['mic', 'cam', 'speaker'] as const) {
      if (isDeviceId(saved[kind])) labels[kind] = saved[kind]
    }
  } catch {
    // Unreadable: no labels
  }
  return labels
}

/** Remembers one choice (with its label, when the browser shows labels), keeping the others */
export function saveDevice(kind: keyof DeviceChoices, deviceId: string, label = ''): void {
  write('localStorage', DEVICES_KEY, JSON.stringify({ ...loadDevices(), [kind]: deviceId }))
  write(
    'localStorage',
    DEVICE_LABELS_KEY,
    JSON.stringify({ ...loadDeviceLabels(), [kind]: label || null }),
  )
}

/**
 * Where a remembered device is now (G1, e4-t09): its id when the list still has it; otherwise the
 * device with the same label (the browser gave it a new id); null when it is gone (unplugged:
 * the browser's default is used meanwhile, and the choice stays remembered for when it is back).
 * An empty list (no permission yet: no ids to compare) keeps the remembered id.
 */
export function resolveDevice(
  deviceId: string | null,
  label: string | null,
  options: readonly { deviceId: string; label: string }[],
): string | null {
  if (deviceId === null || options.length === 0) return deviceId
  if (options.some((option) => option.deviceId === deviceId)) return deviceId
  if (label) return options.find((option) => option.label === label)?.deviceId ?? null
  return null
}

/** How the stage looks, remembered between meetings (G2, e4-t10, e4-t11) */
export interface ViewPrefs {
  layout: LayoutChoice
  hideSelf: boolean
}

export const DEFAULT_VIEW: ViewPrefs = { layout: 'grid', hideSelf: false }

export function loadView(): ViewPrefs {
  try {
    const saved: unknown = JSON.parse(read('localStorage', VIEW_KEY) ?? 'null')
    if (typeof saved !== 'object' || saved === null) return DEFAULT_VIEW
    const { layout, hideSelf } = saved as Record<string, unknown>
    return {
      layout: isLayoutChoice(layout) ? layout : DEFAULT_VIEW.layout,
      hideSelf: typeof hideSelf === 'boolean' ? hideSelf : DEFAULT_VIEW.hideSelf,
    }
  } catch {
    return DEFAULT_VIEW
  }
}

export function saveView(view: ViewPrefs): void {
  write('localStorage', VIEW_KEY, JSON.stringify(view))
}

/** 更多's switches, remembered between meetings (G3: e4-t16, e5-t03) */
export interface RoomPrefs {
  /** 音效: join, leave, raised hands, chat while it is closed */
  sounds: boolean
  /** 隱藏表情反應: nobody's reactions float over the tiles (this browser only) */
  hideReactions: boolean
}

export const DEFAULT_PREFS: RoomPrefs = { sounds: true, hideReactions: false }

export function loadPrefs(): RoomPrefs {
  try {
    const saved: unknown = JSON.parse(read('localStorage', PREFS_KEY) ?? 'null')
    if (typeof saved !== 'object' || saved === null) return DEFAULT_PREFS
    const { sounds, hideReactions } = saved as Record<string, unknown>
    return {
      sounds: typeof sounds === 'boolean' ? sounds : DEFAULT_PREFS.sounds,
      hideReactions:
        typeof hideReactions === 'boolean' ? hideReactions : DEFAULT_PREFS.hideReactions,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(prefs: RoomPrefs): void {
  write('localStorage', PREFS_KEY, JSON.stringify(prefs))
}

/**
 * The settings panel's media choices, remembered between meetings (H3: e6-t01, e6-t04): the
 * microphone's processing switches, and HD (null: never chosen, so the device's default, see
 * defaultHd). 純音訊模式 is not remembered: it is for this meeting (the next one would otherwise
 * show nobody's video with no sign why).
 */
export interface MediaPrefs {
  processing: AudioProcessing
  hd: boolean | null
}

export const DEFAULT_MEDIA: MediaPrefs = { processing: DEFAULT_PROCESSING, hd: null }

export function loadMediaPrefs(): MediaPrefs {
  try {
    const saved: unknown = JSON.parse(read('localStorage', MEDIA_KEY) ?? 'null')
    if (typeof saved !== 'object' || saved === null) return DEFAULT_MEDIA
    const { processing, hd } = saved as Record<string, unknown>
    const switches = (typeof processing === 'object' && processing !== null ? processing : {}) as
      Record<string, unknown>
    const loaded = { ...DEFAULT_PROCESSING }
    for (const key of PROCESSING_KEYS) {
      if (typeof switches[key] === 'boolean') loaded[key] = switches[key]
    }
    return { processing: loaded, hd: typeof hd === 'boolean' ? hd : null }
  } catch {
    return DEFAULT_MEDIA
  }
}

export function saveMediaPrefs(prefs: MediaPrefs): void {
  write('localStorage', MEDIA_KEY, JSON.stringify(prefs))
}

/**
 * HD when it was never chosen (e6-t04): on for a computer, off for a phone or tablet (a
 * touch-first screen): a phone's 720p layer costs uplink (often mobile data) and battery for a
 * picture most receivers show small. The uplink check still holds HD back on a thin uplink.
 */
export function defaultHd(touchPrimary: boolean): boolean {
  return !touchPrimary
}

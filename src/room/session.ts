import { isClientId, isSessionToken, normalizeName } from '../../shared/protocol.ts'

// What the browser remembers between visits (AC-1.2, AC-4.2):
// - the display name, in localStorage: every room, every tab;
// - the chosen microphone, camera and speaker (e2-t06), in localStorage: the pre-join screen
//   and the room read and write the same choice;
// - the room's session token, in sessionStorage: it survives a reload of the tab, but a second
//   tab (or the next visit) joins as someone new instead of taking the first tab's place;
// - this browser's own random id (F1), in localStorage: every `join` carries it, and a member the
//   host removes is banned by it for 10 minutes. Without accounts nothing better identifies a
//   browser; a private window, another browser or clearing the site's data gets a new one.
// Storage can be missing or throw (private mode, blocked cookies): then nothing is remembered.

const NAME_KEY = 'longtalk.name'
const DEVICES_KEY = 'longtalk.devices'
const CLIENT_KEY = 'longtalk.client'
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

/** Remembers one choice, keeping the others */
export function saveDevice(kind: keyof DeviceChoices, deviceId: string): void {
  write('localStorage', DEVICES_KEY, JSON.stringify({ ...loadDevices(), [kind]: deviceId }))
}

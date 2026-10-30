import { isSessionToken, normalizeName } from '../../shared/protocol.ts'

// What the browser remembers between visits (AC-1.2, AC-4.2):
// - the display name, in localStorage: every room, every tab;
// - the room's session token, in sessionStorage: it survives a reload of the tab, but a second
//   tab (or the next visit) joins as someone new instead of taking the first tab's place.
// Storage can be missing or throw (private mode, blocked cookies): then nothing is remembered.

const NAME_KEY = 'longtalk.name'
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

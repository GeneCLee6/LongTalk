// Whether a local recording may be waiting in IndexedDB (I4, e8-t01): one localStorage flag the
// recording store sets and clears, so pages can skip loading the store (and opening IndexedDB)
// for everyone who never recorded. Tiny on purpose: the home page and the room import it.

export const PENDING_KEY = 'longtalk.recording.pending'

/** Whether any recording may be stored (cheap: no IndexedDB) */
export function recordingPending(): boolean {
  try {
    return localStorage.getItem(PENDING_KEY) === '1'
  } catch {
    return false
  }
}

export function markPending(on: boolean): void {
  try {
    if (on) localStorage.setItem(PENDING_KEY, '1')
    else localStorage.removeItem(PENDING_KEY)
  } catch {
    // Private mode without storage: nothing to offer next time anyway
  }
}

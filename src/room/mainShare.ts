// Whose share this viewer chose for the main area (H5, e3-t07): kept for the session (this tab,
// sessionStorage), so a reload or a reconnect keeps showing the same share. shared/layout.ts
// shareSlots decides what is shown from it; a choice whose member no longer shares is ignored
// there, and kept here in case they share again.

const key = (roomId: string) => `longtalk:mainShare:${roomId}`

export function loadMainShare(roomId: string): string | null {
  try {
    return sessionStorage.getItem(key(roomId))
  } catch {
    return null
  }
}

export function saveMainShare(roomId: string, memberId: string): void {
  try {
    sessionStorage.setItem(key(roomId), memberId)
  } catch {
    // Storage refused (a private window's quota): the choice lasts while the page does
  }
}

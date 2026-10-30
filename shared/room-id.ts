// Room ids (ARCHITECTURE.md §5): 10 random characters from the base58 alphabet (no 0, O, I, l, so
// an id read aloud or copied by hand is not misread), about 58.6 bits: not enumerable.
export const ROOM_ID_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export const ROOM_ID_LENGTH = 10

const ROOM_ID_PATTERN = new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`)

export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value)
}

/** Fills the array with random bytes: crypto.getRandomValues in the Worker and the browser */
export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => void

const cryptoBytes: RandomBytes = (bytes) => {
  crypto.getRandomValues(bytes)
}

/**
 * A new room id. Bytes ≥ 232 (4 × 58) are thrown away so every character is equally likely
 * (rejection sampling, no modulo bias).
 */
export function newRoomId(random: RandomBytes = cryptoBytes): string {
  const n = ROOM_ID_ALPHABET.length
  const limit = 256 - (256 % n)
  let id = ''
  const bytes = new Uint8Array(16)
  while (id.length < ROOM_ID_LENGTH) {
    random(bytes)
    for (const byte of bytes) {
      if (byte >= limit) continue
      id += ROOM_ID_ALPHABET[byte % n]
      if (id.length === ROOM_ID_LENGTH) break
    }
  }
  return id
}

/**
 * The room id in what someone pasted into the home page's join box: a bare id, or any link whose
 * path has `/r/<id>` (this site's or another deployment's). Null when there is none.
 */
export function parseRoomInput(input: string): string | null {
  const text = input.trim()
  if (isRoomId(text)) return text
  const match = /(?:^|\/)r\/([^/?#\s]+)/.exec(text)
  return match && isRoomId(match[1]) ? match[1] : null
}

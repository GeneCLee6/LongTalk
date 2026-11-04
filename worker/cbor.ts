// A small CBOR decoder (RFC 8949), enough for WebAuthn (I2): the attestation object and COSE
// public keys. Unsigned and negative integers, byte and text strings, arrays, maps (any key
// type: COSE keys are integers), true, false, null, undefined. No indefinite lengths, tags,
// floats or big numbers: WebAuthn's CTAP2 canonical CBOR never has them, and anything else is
// refused rather than guessed at.

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>

export class CborError extends Error {}

/** Nesting deeper than this is refused (WebAuthn's objects are 3 levels deep at most) */
const MAX_DEPTH = 16

/**
 * Decodes the first CBOR item of `bytes` from `offset`; `end` is where it ended (the
 * authenticator data has a COSE key followed by extensions, so the caller needs to know)
 */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const reader = new Reader(bytes, offset)
  const value = reader.item(0)
  return { value, end: reader.pos }
}

/** Decodes `bytes` as exactly one CBOR item (nothing may follow it) */
export function decodeCborExactly(bytes: Uint8Array): CborValue {
  const { value, end } = decodeCbor(bytes)
  if (end !== bytes.length) throw new CborError('trailing bytes')
  return value
}

class Reader {
  pos: number
  private readonly bytes: Uint8Array

  constructor(bytes: Uint8Array, pos: number) {
    this.bytes = bytes
    this.pos = pos
  }

  private byte(): number {
    if (this.pos >= this.bytes.length) throw new CborError('unexpected end')
    return this.bytes[this.pos++]
  }

  private length(info: number): number {
    if (info < 24) return info
    let size: number
    if (info === 24) size = 1
    else if (info === 25) size = 2
    else if (info === 26) size = 4
    else if (info === 27) size = 8
    else throw new CborError('indefinite or reserved length')
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + this.byte()
    if (!Number.isSafeInteger(value)) throw new CborError('integer too large')
    return value
  }

  private take(count: number): Uint8Array {
    if (this.pos + count > this.bytes.length) throw new CborError('unexpected end')
    const out = this.bytes.slice(this.pos, this.pos + count)
    this.pos += count
    return out
  }

  item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError('too deep')
    const initial = this.byte()
    const major = initial >> 5
    const info = initial & 0x1f
    switch (major) {
      case 0:
        return this.length(info)
      case 1:
        return -1 - this.length(info)
      case 2:
        return this.take(this.length(info))
      case 3:
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(this.take(this.length(info)))
      case 4: {
        const count = this.length(info)
        const items: CborValue[] = []
        for (let i = 0; i < count; i++) items.push(this.item(depth + 1))
        return items
      }
      case 5: {
        const count = this.length(info)
        const map = new Map<CborValue, CborValue>()
        for (let i = 0; i < count; i++) {
          const key = this.item(depth + 1)
          if (map.has(key)) throw new CborError('duplicate map key')
          map.set(key, this.item(depth + 1))
        }
        return map
      }
      case 7:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        if (info === 23) return undefined
        throw new CborError('unsupported simple value or float')
      default:
        throw new CborError('tags are not supported')
    }
  }
}

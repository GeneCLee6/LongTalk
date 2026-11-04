import { toBase64url, fromBase64url } from '../../shared/base64url.ts'
import { COSE_ALG } from '../../worker/webauthn.ts'

// A software passkey authenticator for the account tests (I2): makes key pairs with WebCrypto
// and answers navigator.credentials.create / get the way a platform authenticator does
// (attestation "none", user present and verified, a discoverable credential with the user handle).
// Options and answers are the JSON the browser and the Worker exchange.

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | boolean

/** CTAP2-style CBOR, enough for COSE keys and attestation objects */
export function encodeCbor(value: Cbor): Uint8Array {
  const out: number[] = []
  const head = (major: number, n: number) => {
    if (n < 24) out.push((major << 5) | n)
    else if (n < 256) out.push((major << 5) | 24, n)
    else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255)
    else out.push((major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const write = (v: Cbor) => {
    if (typeof v === 'boolean') out.push(v ? 0xf5 : 0xf4)
    else if (typeof v === 'number') head(v >= 0 ? 0 : 1, v >= 0 ? v : -1 - v)
    else if (typeof v === 'string') {
      const bytes = new TextEncoder().encode(v)
      head(3, bytes.length)
      out.push(...bytes)
    } else if (v instanceof Uint8Array) {
      head(2, v.length)
      out.push(...v)
    } else if (Array.isArray(v)) {
      head(4, v.length)
      v.forEach(write)
    } else {
      head(5, v.size)
      for (const [k, item] of v) {
        write(k)
        write(item)
      }
    }
  }
  write(value)
  return new Uint8Array(out)
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const sha256 = async (data: Uint8Array | string) =>
  new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      (typeof data === 'string' ? new TextEncoder().encode(data) : data) as Uint8Array<ArrayBuffer>,
    ),
  )

/** r ‖ s (WebCrypto's ECDSA) as ASN.1 DER (what authenticators send) */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let v = bytes
    while (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) v = v.subarray(1)
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v)
    return concat(new Uint8Array([0x02, v.length]), v)
  }
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

type Stored = {
  id: Uint8Array
  rpId: string
  userHandle: string
  alg: number
  privateKey: CryptoKey
  counter: number
}

const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 }

export type AuthenticatorOptions = {
  alg?: number
  /** A synced passkey (backup eligible and backed up) keeps its counter at 0 */
  synced?: boolean
  /** Leave the user-verified flag off */
  noUserVerification?: boolean
  aaguid?: string
}

type CreationJSON = {
  rp: { id: string }
  user: { id: string; name: string }
  challenge: string
  excludeCredentials?: { id: string }[]
  pubKeyCredParams: { alg: number }[]
}

type RequestJSON = { rpId: string; challenge: string }

export class SoftAuthenticator {
  readonly credentials: Stored[] = []
  private readonly options: AuthenticatorOptions

  constructor(options: AuthenticatorOptions = {}) {
    this.options = options
  }

  private flags(extra: number): number {
    let flags = FLAGS.UP | extra
    if (!this.options.noUserVerification) flags |= FLAGS.UV
    if (this.options.synced) flags |= FLAGS.BE | FLAGS.BS
    return flags
  }

  async create(options: CreationJSON, origin: string) {
    const excluded = new Set((options.excludeCredentials ?? []).map((c) => c.id))
    if (this.credentials.some((c) => excluded.has(toBase64url(c.id)))) {
      throw new Error('InvalidStateError: already registered')
    }
    const alg = this.options.alg ?? COSE_ALG.ES256
    const { privateKey, cose } = await keyPair(alg)
    const id = crypto.getRandomValues(new Uint8Array(16))
    const counter = this.options.synced ? 0 : 1
    this.credentials.push({ id, rpId: options.rp.id, userHandle: options.user.id, alg, privateKey, counter })
    const aaguid = fromAaguid(this.options.aaguid ?? '01020304-0506-0708-0102-030405060708')
    const authData = concat(
      await sha256(options.rp.id),
      new Uint8Array([this.flags(FLAGS.AT)]),
      u32(counter),
      aaguid,
      new Uint8Array([id.length >> 8, id.length & 255]),
      id,
      cose,
    )
    const clientDataJSON = JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin,
      crossOrigin: false,
    })
    const attestationObject = encodeCbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    )
    return {
      id: toBase64url(id),
      rawId: toBase64url(id),
      type: 'public-key',
      response: {
        clientDataJSON: toBase64url(new TextEncoder().encode(clientDataJSON)),
        attestationObject: toBase64url(attestationObject),
        transports: ['internal'],
      },
    }
  }

  /** Answers with the first passkey for the RP (or `pick`), like the account chooser */
  async get(options: RequestJSON, origin: string, pick = 0) {
    const credential = this.credentials.filter((c) => c.rpId === options.rpId)[pick]
    if (!credential) throw new Error('NotAllowedError: no passkey')
    if (!this.options.synced) credential.counter += 1
    const authData = concat(
      await sha256(options.rpId),
      new Uint8Array([this.flags(0)]),
      u32(credential.counter),
    )
    const clientData = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }),
    )
    const signed = concat(authData, await sha256(clientData))
    const signature = await sign(credential.alg, credential.privateKey, signed)
    return {
      id: toBase64url(credential.id),
      rawId: toBase64url(credential.id),
      type: 'public-key',
      response: {
        clientDataJSON: toBase64url(clientData),
        authenticatorData: toBase64url(authData),
        signature: toBase64url(signature),
        userHandle: credential.userHandle,
      },
    }
  }
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255])

const fromAaguid = (text: string) =>
  new Uint8Array(text.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)))

async function keyPair(alg: number): Promise<{ privateKey: CryptoKey; cose: Uint8Array }> {
  if (alg === COSE_ALG.ES256) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
    const cose = encodeCbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64url(jwk.x)!],
        [-3, fromBase64url(jwk.y)!],
      ]),
    )
    return { privateKey: pair.privateKey, cose }
  }
  if (alg === COSE_ALG.EdDSA) {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
    const cose = encodeCbor(
      new Map<Cbor, Cbor>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, raw],
      ]),
    )
    return { privateKey: pair.privateKey, cose }
  }
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const cose = encodeCbor(
    new Map<Cbor, Cbor>([
      [1, 3],
      [3, -257],
      [-1, fromBase64url(jwk.n)!],
      [-2, fromBase64url(jwk.e)!],
    ]),
  )
  return { privateKey: pair.privateKey, cose }
}

async function sign(alg: number, key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const message = data as Uint8Array<ArrayBuffer>
  if (alg === COSE_ALG.ES256) {
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, message))
    return rawToDer(raw)
  }
  if (alg === COSE_ALG.EdDSA) {
    return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message))
  }
  return new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, message))
}

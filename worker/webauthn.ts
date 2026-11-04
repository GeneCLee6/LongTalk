import { fromBase64url, toBase64url } from '../shared/base64url.ts'
import { CborError, decodeCbor, decodeCborExactly, type CborValue } from './cbor.ts'

// WebAuthn for passkey sign-in (I2, e1-t12), verified here with WebCrypto: no library (the
// checks are the Level 3 spec's §7.1 and §7.2, the parts a relying party that asks for no
// attestation needs). Discoverable credentials (resident keys) with user verification required,
// so signing in needs neither a user name nor a password: the passkey is the account.
//
// Attestation is not checked: the options ask for none, and the account never depends on which
// authenticator made the key (a packed or other statement a browser still sends is ignored, its
// format recorded nowhere). What is checked, every time: the type, the challenge (single use,
// issued by the Worker), the origin, the RP ID hash, user presence and user verification, the
// signature over the authenticator data and the client data hash, and the signature counter.

/** COSE algorithm identifiers this site accepts, in order of preference */
export const COSE_ALG = { EdDSA: -8, ES256: -7, RS256: -257 } as const
export const SUPPORTED_ALGS: readonly number[] = [COSE_ALG.EdDSA, COSE_ALG.ES256, COSE_ALG.RS256]

/** The time the browser shows its passkey dialog for (milliseconds) */
export const WEBAUTHN_TIMEOUT_MS = 5 * 60_000

/** Credential ids are at most 1023 bytes (WebAuthn §5.1) */
const MAX_CREDENTIAL_ID_BYTES = 1023
/** RSA keys shorter than this are refused */
const MIN_RSA_BITS = 2048

/** Why a credential was refused (the Worker logs it; the browser only hears verification_failed) */
export class WebAuthnError extends Error {}

/** What the browser sends after navigator.credentials.create (base64url, like toJSON()) */
export type RegistrationJSON = {
  id: string
  rawId: string
  type: 'public-key'
  response: { clientDataJSON: string; attestationObject: string; transports: string[] }
}

/** What the browser sends after navigator.credentials.get */
export type AuthenticationJSON = {
  id: string
  rawId: string
  type: 'public-key'
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle: string | null
  }
}

/** What the Worker expects of the answer: the challenge it issued, its origin and RP ID */
export type Expected = { challenge: string; origin: string; rpId: string }

/** A passkey that passed registration, as the account keeps it */
export type NewCredential = {
  id: string
  /** The COSE public key, base64url */
  publicKey: string
  alg: number
  signCount: number
  /** The authenticator model's AAGUID (all zeros when it gives none) */
  aaguid: string
  backedUp: boolean
  transports: string[]
}

/** A stored passkey, to check an assertion against */
export type StoredCredential = { publicKey: string; alg: number; signCount: number }

const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])

const isB64 = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && fromBase64url(value) !== null

/** The browser's registration answer, or null when it is not shaped like one */
export function parseRegistration(raw: unknown): RegistrationJSON | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const response = value.response as Record<string, unknown> | undefined
  if (value.type !== 'public-key' || !isB64(value.id) || !isB64(value.rawId)) return null
  if (typeof response !== 'object' || response === null) return null
  if (!isB64(response.clientDataJSON) || !isB64(response.attestationObject)) return null
  const transports = Array.isArray(response.transports)
    ? response.transports.filter((t): t is string => typeof t === 'string' && TRANSPORTS.has(t))
    : []
  return {
    id: value.id,
    rawId: value.rawId,
    type: 'public-key',
    response: {
      clientDataJSON: response.clientDataJSON,
      attestationObject: response.attestationObject,
      transports: [...new Set(transports)],
    },
  }
}

/** The browser's sign-in answer, or null when it is not shaped like one */
export function parseAuthentication(raw: unknown): AuthenticationJSON | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const response = value.response as Record<string, unknown> | undefined
  if (value.type !== 'public-key' || !isB64(value.id) || !isB64(value.rawId)) return null
  if (typeof response !== 'object' || response === null) return null
  if (
    !isB64(response.clientDataJSON) ||
    !isB64(response.authenticatorData) ||
    !isB64(response.signature)
  ) {
    return null
  }
  const userHandle = response.userHandle
  if (userHandle !== undefined && userHandle !== null && !isB64(userHandle)) return null
  return {
    id: value.id,
    rawId: value.rawId,
    type: 'public-key',
    response: {
      clientDataJSON: response.clientDataJSON,
      authenticatorData: response.authenticatorData,
      signature: response.signature,
      userHandle: (userHandle as string | null | undefined) ?? null,
    },
  }
}

type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean }

function clientData(encoded: string): ClientData {
  const bytes = fromBase64url(encoded)
  if (!bytes) throw new WebAuthnError('clientDataJSON is not base64url')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    throw new WebAuthnError('clientDataJSON is not JSON')
  }
  const data = value as Partial<ClientData>
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof data.type !== 'string' ||
    typeof data.challenge !== 'string' ||
    typeof data.origin !== 'string'
  ) {
    throw new WebAuthnError('clientDataJSON lacks type, challenge or origin')
  }
  return data as ClientData
}

/**
 * The challenge the browser answered (from its client data), to look the issued challenge up by;
 * null when there is none. Nothing is verified yet.
 */
export function answeredChallenge(clientDataJSON: string): string | null {
  try {
    const { challenge } = clientData(clientDataJSON)
    return fromBase64url(challenge) ? challenge : null
  } catch {
    return null
  }
}

function checkClientData(encoded: string, type: string, expected: Expected): void {
  const data = clientData(encoded)
  if (data.type !== type) throw new WebAuthnError(`type is ${data.type}`)
  if (data.challenge !== expected.challenge) throw new WebAuthnError('challenge differs')
  if (data.origin !== expected.origin) throw new WebAuthnError(`origin is ${data.origin}`)
  // Never asked for from a frame (frame-ancestors 'none' anyway)
  if (data.crossOrigin === true) throw new WebAuthnError('cross-origin')
}

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40
const FLAG_ED = 0x80

type AuthData = {
  rpIdHash: Uint8Array
  flags: number
  signCount: number
  credential: { aaguid: string; id: Uint8Array; publicKey: Uint8Array } | null
}

/** The authenticator data (WebAuthn §6.1), every length checked */
export function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new WebAuthnError('authenticator data too short')
  const flags = bytes[32]
  const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0)
  let pos = 37
  let credential: AuthData['credential'] = null
  try {
    if (flags & FLAG_AT) {
      if (bytes.length < pos + 18) throw new WebAuthnError('attested credential data too short')
      const aaguid = formatAaguid(bytes.slice(pos, pos + 16))
      const idLength = (bytes[pos + 16] << 8) | bytes[pos + 17]
      pos += 18
      if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES) {
        throw new WebAuthnError('credential id length')
      }
      if (bytes.length < pos + idLength) throw new WebAuthnError('credential id too short')
      const id = bytes.slice(pos, pos + idLength)
      pos += idLength
      const { end } = decodeCbor(bytes, pos)
      credential = { aaguid, id, publicKey: bytes.slice(pos, end) }
      pos = end
    }
    if (flags & FLAG_ED) pos = decodeCbor(bytes, pos).end
  } catch (error) {
    if (error instanceof CborError) throw new WebAuthnError(`authenticator data: ${error.message}`)
    throw error
  }
  if (pos !== bytes.length) throw new WebAuthnError('authenticator data has trailing bytes')
  if (flags & FLAG_BS && !(flags & FLAG_BE)) throw new WebAuthnError('backed up but not eligible')
  return { rpIdHash: bytes.slice(0, 32), flags, signCount, credential }
}

function formatAaguid(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function checkAuthData(data: AuthData, rpId: string): Promise<void> {
  if (!equalBytes(data.rpIdHash, await sha256(rpId))) throw new WebAuthnError('RP ID hash differs')
  if (!(data.flags & FLAG_UP)) throw new WebAuthnError('user not present')
  // The options require user verification: a passkey is the only factor
  if (!(data.flags & FLAG_UV)) throw new WebAuthnError('user not verified')
}

/**
 * Verifies a registration (WebAuthn §7.1) against what the Worker issued; the new passkey, or a
 * WebAuthnError saying why not
 */
export async function verifyRegistration(
  credential: RegistrationJSON,
  expected: Expected,
): Promise<NewCredential> {
  checkClientData(credential.response.clientDataJSON, 'webauthn.create', expected)
  let attestation: CborValue
  try {
    attestation = decodeCborExactly(fromBase64url(credential.response.attestationObject)!)
  } catch {
    throw new WebAuthnError('attestation object is not CBOR')
  }
  if (!(attestation instanceof Map)) throw new WebAuthnError('attestation object is not a map')
  const fmt = attestation.get('fmt')
  const authBytes = attestation.get('authData')
  if (typeof fmt !== 'string' || !(authBytes instanceof Uint8Array)) {
    throw new WebAuthnError('attestation object lacks fmt or authData')
  }
  if (fmt === 'none' && !(attestation.get('attStmt') instanceof Map)) {
    throw new WebAuthnError('none attestation without an empty statement')
  }
  const authData = parseAuthData(authBytes)
  await checkAuthData(authData, expected.rpId)
  if (!authData.credential) throw new WebAuthnError('no attested credential data')
  const rawId = fromBase64url(credential.rawId)!
  if (!equalBytes(rawId, authData.credential.id) || credential.id !== toBase64url(rawId)) {
    throw new WebAuthnError('credential id differs')
  }
  const { alg } = await importCoseKey(authData.credential.publicKey)
  return {
    id: credential.id,
    publicKey: toBase64url(authData.credential.publicKey),
    alg,
    signCount: authData.signCount,
    aaguid: authData.credential.aaguid,
    backedUp: (authData.flags & FLAG_BS) !== 0,
    transports: credential.response.transports,
  }
}

/**
 * Verifies a sign-in (WebAuthn §7.2) with the stored passkey `stored` (found by the credential's
 * id; the caller checks the user handle belongs to the same account). The new signature counter
 * and backup state, or a WebAuthnError.
 */
export async function verifyAuthentication(
  credential: AuthenticationJSON,
  expected: Expected,
  stored: StoredCredential,
): Promise<{ signCount: number; backedUp: boolean }> {
  checkClientData(credential.response.clientDataJSON, 'webauthn.get', expected)
  const authBytes = fromBase64url(credential.response.authenticatorData)!
  const authData = parseAuthData(authBytes)
  await checkAuthData(authData, expected.rpId)
  const publicKey = fromBase64url(stored.publicKey)
  if (!publicKey) throw new WebAuthnError('stored key is not base64url')
  const { key, alg } = await importCoseKey(publicKey)
  if (alg !== stored.alg) throw new WebAuthnError('stored algorithm differs')
  const clientHash = await sha256(fromBase64url(credential.response.clientDataJSON)!)
  const signed = new Uint8Array(authBytes.length + clientHash.length)
  signed.set(authBytes)
  signed.set(clientHash, authBytes.length)
  const signature = fromBase64url(credential.response.signature)!
  if (!(await verifySignature(alg, key, signature, signed))) {
    throw new WebAuthnError('signature does not verify')
  }
  // A counter that did not go up means a cloned authenticator; synced passkeys always say 0
  if ((authData.signCount !== 0 || stored.signCount !== 0) && authData.signCount <= stored.signCount) {
    throw new WebAuthnError('signature counter did not increase')
  }
  return { signCount: authData.signCount, backedUp: (authData.flags & FLAG_BS) !== 0 }
}

/** A COSE_Key (RFC 9053) as a WebCrypto key for one of SUPPORTED_ALGS */
export async function importCoseKey(cose: Uint8Array): Promise<{ key: CryptoKey; alg: number }> {
  let value: CborValue
  try {
    value = decodeCborExactly(cose)
  } catch {
    throw new WebAuthnError('public key is not CBOR')
  }
  if (!(value instanceof Map)) throw new WebAuthnError('public key is not a map')
  const kty = value.get(1)
  const alg = value.get(3)
  const bytes = (label: number, length?: number): Uint8Array => {
    const field = value.get(label)
    if (!(field instanceof Uint8Array) || (length !== undefined && field.length !== length)) {
      throw new WebAuthnError(`public key field ${label}`)
    }
    return field
  }
  try {
    if (alg === COSE_ALG.ES256 && kty === 2 && value.get(-1) === 1) {
      const jwk = { kty: 'EC', crv: 'P-256', x: toBase64url(bytes(-2, 32)), y: toBase64url(bytes(-3, 32)) }
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      return { key, alg }
    }
    if (alg === COSE_ALG.EdDSA && kty === 1 && value.get(-1) === 6) {
      const key = await crypto.subtle.importKey('raw', bytes(-2, 32) as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify'])
      return { key, alg }
    }
    if (alg === COSE_ALG.RS256 && kty === 3) {
      const n = bytes(-1)
      if (n.length * 8 < MIN_RSA_BITS) throw new WebAuthnError('RSA key too short')
      const jwk = { kty: 'RSA', n: toBase64url(n), e: toBase64url(bytes(-2)), alg: 'RS256' }
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      return { key, alg }
    }
  } catch (error) {
    if (error instanceof WebAuthnError) throw error
    throw new WebAuthnError(`public key does not import: ${String(error)}`)
  }
  throw new WebAuthnError(`unsupported key: kty ${String(kty)}, alg ${String(alg)}`)
}

async function verifySignature(
  alg: number,
  key: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const message = data as Uint8Array<ArrayBuffer>
  if (alg === COSE_ALG.ES256) {
    const raw = derToRaw(signature)
    if (!raw) return false
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, message)
  }
  if (alg === COSE_ALG.EdDSA) {
    return crypto.subtle.verify({ name: 'Ed25519' }, key, signature as Uint8Array<ArrayBuffer>, message)
  }
  return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature as Uint8Array<ArrayBuffer>, message)
}

/**
 * An ECDSA P-256 signature in ASN.1 DER (what authenticators send) as WebCrypto's r ‖ s (32
 * bytes each); null when it is not a well-formed DER signature
 */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null
  let pos = 2
  const out = new Uint8Array(64)
  for (let part = 0; part < 2; part++) {
    if (der[pos] !== 0x02) return null
    const length = der[pos + 1]
    pos += 2
    if (length === 0 || length > 33 || pos + length > der.length) return null
    let value = der.subarray(pos, pos + length)
    pos += length
    // A negative integer is no signature; extra leading zeros (not strictly DER) are let through
    if (value[0] & 0x80) return null
    while (value.length > 32 && value[0] === 0) value = value.subarray(1)
    if (value.length > 32) return null
    out.set(value, part * 32 + 32 - value.length)
  }
  return pos === der.length ? out : null
}

/** navigator.credentials.create's options for a new passkey (JSON, base64url for the bytes) */
export function creationOptions(options: {
  rpId: string
  challenge: string
  user: { id: string; name: string }
  exclude: { id: string; transports: string[] }[]
}) {
  return {
    rp: { id: options.rpId, name: 'LongTalk' },
    user: { id: options.user.id, name: options.user.name, displayName: options.user.name },
    challenge: options.challenge,
    pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key' as const, alg })),
    timeout: WEBAUTHN_TIMEOUT_MS,
    excludeCredentials: options.exclude.map(({ id, transports }) => ({
      type: 'public-key' as const,
      id,
      ...(transports.length > 0 ? { transports } : {}),
    })),
    authenticatorSelection: {
      residentKey: 'required' as const,
      requireResidentKey: true,
      userVerification: 'required' as const,
    },
    attestation: 'none' as const,
    extensions: { credProps: true },
  }
}

/** navigator.credentials.get's options: no allow list (discoverable credentials, no user name) */
export function requestOptions(options: { rpId: string; challenge: string }) {
  return {
    rpId: options.rpId,
    challenge: options.challenge,
    timeout: WEBAUTHN_TIMEOUT_MS,
    userVerification: 'required' as const,
    allowCredentials: [] as never[],
  }
}

export type CreationOptionsJSON = ReturnType<typeof creationOptions>
export type RequestOptionsJSON = ReturnType<typeof requestOptions>

/** A fresh challenge: 32 random bytes, base64url */
export function newChallenge(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

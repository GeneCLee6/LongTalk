// I2 (e1-t12): passkey verification. A registration and a sign-in recorded from Chromium's
// virtual authenticator (fixtures/chromium-passkey.json), and a software authenticator for
// every algorithm and every way an answer can be wrong.
import { describe, expect, it } from 'vitest'
import { fromBase64url, toBase64url } from '../../shared/base64url.ts'
import { decodeCbor, decodeCborExactly } from '../../worker/cbor.ts'
import {
  COSE_ALG,
  answeredChallenge,
  creationOptions,
  derToRaw,
  parseAuthentication,
  parseRegistration,
  verifyAuthentication,
  verifyRegistration,
  type Expected,
} from '../../worker/webauthn.ts'
import { SoftAuthenticator, encodeCbor, rawToDer } from './authenticator.ts'
import recorded from './fixtures/chromium-passkey.json'

const ORIGIN = 'https://longtalk.example'
const RP_ID = 'longtalk.example'

const options = (challenge: string) =>
  creationOptions({ rpId: RP_ID, challenge, user: { id: 'dXNlcg', name: 'Gene' }, exclude: [] })

/** Re-encodes the client data with `change` applied (the signature then no longer matches) */
function withClientData<T extends { response: { clientDataJSON: string } }>(
  credential: T,
  change: Record<string, unknown>,
): T {
  const data = JSON.parse(new TextDecoder().decode(fromBase64url(credential.response.clientDataJSON)!))
  const clientDataJSON = toBase64url(new TextEncoder().encode(JSON.stringify({ ...data, ...change })))
  return { ...credential, response: { ...credential.response, clientDataJSON } }
}

describe('recorded Chromium passkey', () => {
  const expectedReg: Expected = {
    challenge: recorded.registrationChallenge,
    origin: recorded.origin,
    rpId: recorded.rpId,
  }
  const expectedAuth: Expected = { ...expectedReg, challenge: recorded.authenticationChallenge }

  it('registers and signs in', async () => {
    const registration = parseRegistration(recorded.registration)!
    expect(answeredChallenge(registration.response.clientDataJSON)).toBe(recorded.registrationChallenge)
    const credential = await verifyRegistration(registration, expectedReg)
    expect(credential.id).toBe(recorded.registration.id)
    // Chromium's virtual authenticator takes the first algorithm offered: Ed25519
    expect(credential.alg).toBe(COSE_ALG.EdDSA)
    const authentication = parseAuthentication(recorded.authentication)!
    expect(authentication.response.userHandle).toBe(recorded.userHandle)
    const result = await verifyAuthentication(authentication, expectedAuth, {
      publicKey: credential.publicKey,
      alg: credential.alg,
      signCount: credential.signCount,
    })
    expect(result.signCount).toBeGreaterThan(credential.signCount)
  })

  it('refuses the recording elsewhere, for another challenge or replayed', async () => {
    const registration = parseRegistration(recorded.registration)!
    const credential = await verifyRegistration(registration, expectedReg)
    await expect(verifyRegistration(registration, { ...expectedReg, origin: ORIGIN })).rejects.toThrow(/origin/)
    await expect(verifyRegistration(registration, { ...expectedReg, rpId: RP_ID })).rejects.toThrow(/RP ID/)
    await expect(
      verifyRegistration(registration, { ...expectedReg, challenge: recorded.authenticationChallenge }),
    ).rejects.toThrow(/challenge/)
    const authentication = parseAuthentication(recorded.authentication)!
    const stored = { publicKey: credential.publicKey, alg: credential.alg, signCount: 0 }
    const { signCount } = await verifyAuthentication(authentication, expectedAuth, stored)
    // The same answer again: the counter did not go up
    await expect(
      verifyAuthentication(authentication, expectedAuth, { ...stored, signCount }),
    ).rejects.toThrow(/counter/)
    // A sign-in answer is not a registration, nor the other way round
    await expect(verifyAuthentication(authentication, expectedReg, stored)).rejects.toThrow()
  })
})

describe('software authenticator', () => {
  for (const [label, alg] of Object.entries(COSE_ALG)) {
    it(`registers and signs in with ${label}`, async () => {
      const authenticator = new SoftAuthenticator({ alg })
      const challenge = toBase64url(crypto.getRandomValues(new Uint8Array(32)))
      const registration = parseRegistration(await authenticator.create(options(challenge), ORIGIN))!
      const credential = await verifyRegistration(registration, { challenge, origin: ORIGIN, rpId: RP_ID })
      expect(credential.alg).toBe(alg)
      expect(credential.transports).toEqual(['internal'])
      const loginChallenge = toBase64url(crypto.getRandomValues(new Uint8Array(32)))
      const answer = parseAuthentication(
        await authenticator.get({ rpId: RP_ID, challenge: loginChallenge }, ORIGIN),
      )!
      const expected = { challenge: loginChallenge, origin: ORIGIN, rpId: RP_ID }
      const result = await verifyAuthentication(answer, expected, credential)
      expect(result.signCount).toBe(2)
      // Tampered signature
      const signature = fromBase64url(answer.response.signature)!
      signature[signature.length - 1] ^= 1
      const tampered = { ...answer, response: { ...answer.response, signature: toBase64url(signature) } }
      await expect(verifyAuthentication(tampered, expected, credential)).rejects.toThrow()
    })
  }

  it('keeps a synced passkey working with its counter at 0, and records the backup state', async () => {
    const authenticator = new SoftAuthenticator({ synced: true })
    const challenge = 'c2lnbi11cA'
    const registration = parseRegistration(await authenticator.create(options(challenge), ORIGIN))!
    const credential = await verifyRegistration(registration, { challenge, origin: ORIGIN, rpId: RP_ID })
    expect(credential).toMatchObject({ signCount: 0, backedUp: true })
    for (const n of [1, 2]) {
      const answer = parseAuthentication(await authenticator.get({ rpId: RP_ID, challenge: `bG9naW4${n}` }, ORIGIN))!
      const result = await verifyAuthentication(answer, { challenge: `bG9naW4${n}`, origin: ORIGIN, rpId: RP_ID }, credential)
      expect(result).toEqual({ signCount: 0, backedUp: true })
    }
  })

  it('needs user verification', async () => {
    const authenticator = new SoftAuthenticator({ noUserVerification: true })
    const registration = parseRegistration(await authenticator.create(options('Y2g'), ORIGIN))!
    await expect(verifyRegistration(registration, { challenge: 'Y2g', origin: ORIGIN, rpId: RP_ID })).rejects.toThrow(
      /not verified/,
    )
  })

  it('checks the type, the origin, a cross-origin frame and the credential id', async () => {
    const authenticator = new SoftAuthenticator()
    const registration = parseRegistration(await authenticator.create(options('Y2g'), ORIGIN))!
    const expected = { challenge: 'Y2g', origin: ORIGIN, rpId: RP_ID }
    await expect(verifyRegistration(withClientData(registration, { type: 'webauthn.get' }), expected)).rejects.toThrow(/type/)
    await expect(
      verifyRegistration(withClientData(registration, { origin: 'https://evil.example' }), expected),
    ).rejects.toThrow(/origin/)
    await expect(verifyRegistration(withClientData(registration, { crossOrigin: true }), expected)).rejects.toThrow(
      /cross-origin/,
    )
    const otherId = toBase64url(new Uint8Array(16))
    await expect(verifyRegistration({ ...registration, id: otherId, rawId: otherId }, expected)).rejects.toThrow(
      /credential id/,
    )
  })

  it('refuses malformed answers before verifying', () => {
    expect(parseRegistration(null)).toBeNull()
    expect(parseRegistration({ type: 'public-key', id: 'a', rawId: 'a', response: {} })).toBeNull()
    expect(parseAuthentication({ type: 'password', id: 'YQ', rawId: 'YQ', response: {} })).toBeNull()
    expect(answeredChallenge('not base64!')).toBeNull()
  })
})

describe('CBOR and DER', () => {
  it('decodes what the encoder wrote, and reports where an item ends', () => {
    const map = new Map<number | string, number | string | Uint8Array>([
      [1, 2],
      [-1, 'text'],
      ['b', new Uint8Array([1, 2, 3])],
    ])
    const bytes = encodeCbor(map)
    expect(decodeCborExactly(bytes)).toEqual(map)
    const twice = new Uint8Array([...bytes, ...bytes])
    expect(decodeCbor(twice).end).toBe(bytes.length)
    expect(() => decodeCborExactly(twice)).toThrow(/trailing/)
    // Indefinite length, a tag and a float are refused
    expect(() => decodeCborExactly(new Uint8Array([0x5f]))).toThrow()
    expect(() => decodeCborExactly(new Uint8Array([0xc0, 0x00]))).toThrow()
    expect(() => decodeCborExactly(new Uint8Array([0xf9, 0, 0]))).toThrow()
  })

  it('turns DER signatures into r ‖ s and back', () => {
    const raw = crypto.getRandomValues(new Uint8Array(64))
    raw[0] = 0x80 // needs a leading zero in DER
    raw[32] = 0x00 // a short s
    expect(derToRaw(rawToDer(raw))).toEqual(raw)
    expect(derToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toBeNull()
  })
})

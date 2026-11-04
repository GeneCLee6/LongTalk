import { fromBase64url, toBase64url } from '../../shared/base64url.ts'

// The browser's half of passkeys (I2, e1-t12): turns the Worker's JSON options into what
// navigator.credentials wants (binary as ArrayBuffers) and the credential back into JSON
// (base64url), like the newer PublicKeyCredential.parseCreationOptionsFromJSON / toJSON, which
// not every browser has yet. Only the /me page loads this (lazy, never in the home page's JS).

type Descriptor = { type: 'public-key'; id: string; transports?: string[] }

export type CreationOptionsJSON = {
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: { type: 'public-key'; alg: number }[]
  timeout?: number
  excludeCredentials?: Descriptor[]
  authenticatorSelection?: AuthenticatorSelectionCriteria
  attestation?: AttestationConveyancePreference
  extensions?: Record<string, unknown>
}

export type RequestOptionsJSON = {
  rpId: string
  challenge: string
  timeout?: number
  userVerification?: UserVerificationRequirement
  allowCredentials?: Descriptor[]
}

/** The person closed the passkey dialog, or it timed out: nothing to report but 「已取消」 */
export class PasskeyCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

const bytes = (text: string): ArrayBuffer => {
  const value = fromBase64url(text)
  if (!value) throw new Error('bad base64url from the server')
  return value.buffer
}

const descriptor = (d: Descriptor): PublicKeyCredentialDescriptor => ({
  type: 'public-key',
  id: bytes(d.id),
  transports: d.transports as AuthenticatorTransport[] | undefined,
})

function cancelled(error: unknown): boolean {
  // NotAllowedError: dismissed, timed out, or no passkey picked; AbortError: aborted
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')
}

/** navigator.credentials.create with the Worker's options; the new passkey as JSON */
export async function createPasskey(options: CreationOptionsJSON) {
  let credential: Credential | null
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        user: { ...options.user, id: bytes(options.user.id) },
        challenge: bytes(options.challenge),
        excludeCredentials: (options.excludeCredentials ?? []).map(descriptor),
        extensions: options.extensions as AuthenticationExtensionsClientInputs | undefined,
      },
    })
  } catch (error) {
    if (cancelled(error)) throw new PasskeyCancelled()
    throw error
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyCancelled()
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
  }
}

/** navigator.credentials.get with the Worker's options (any of this site's passkeys) */
export async function getPasskey(options: RequestOptionsJSON) {
  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: bytes(options.challenge),
        allowCredentials: (options.allowCredentials ?? []).map(descriptor),
      },
    })
  } catch (error) {
    if (cancelled(error)) throw new PasskeyCancelled()
    throw error
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyCancelled()
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      userHandle: response.userHandle ? toBase64url(response.userHandle) : null,
    },
  }
}

/**
 * The site no longer knows this passkey (deleted here, or the account is gone): tell the
 * password manager so it can drop it (Chrome 132+; elsewhere nothing happens)
 */
export function forgetPasskey(rpId: string, credentialId: string): void {
  const signal = (
    PublicKeyCredential as unknown as {
      signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>
    }
  ).signalUnknownCredential
  void signal?.call(PublicKeyCredential, { rpId, credentialId }).catch(() => {})
}

import {
  ACCOUNT_API,
  type AccountError,
  type AccountInfo,
  type MeResponse,
  type PasskeyInfo,
  type PersistentRoomInfo,
  type RoomSettingsChange,
} from '../../shared/account.ts'
import { TURNSTILE_HEADER } from '../../shared/abuse.ts'
import type { MeetingInfo, MeetingInput, MeetingProblem } from '../../shared/meeting.ts'
import type { SlugProblem } from '../../shared/slug.ts'
import { forgetAccountHint, rememberAccountHint } from '../room/session.ts'
import {
  createPasskey,
  forgetPasskey,
  getPasskey,
  type CreationOptionsJSON,
  type RequestOptionsJSON,
} from '../account/webauthn.ts'

// The /me page's calls to /api/account (I2, worker/accounts.ts). Every call is same-origin JSON:
// the browser adds the Origin header the Worker checks, and the HttpOnly session cookie.

/** Why a call failed: the Worker's error, or `failed` when it could not be reached */
export class AccountApiError extends Error {
  readonly code: AccountError | 'failed'
  readonly retryAfter: number
  readonly slugProblem: SlugProblem | null
  readonly meetingProblem: MeetingProblem | null
  readonly siteKey: string | null

  constructor(code: AccountError | 'failed', body: Record<string, unknown> = {}) {
    super(`account API: ${code}`)
    this.code = code
    this.retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : 60
    const problem = typeof body.problem === 'string' ? body.problem : null
    this.slugProblem = code === 'slug_invalid' ? (problem as SlugProblem | null) : null
    this.meetingProblem = code === 'meeting_invalid' ? (problem as MeetingProblem | null) : null
    this.siteKey = typeof body.siteKey === 'string' ? body.siteKey : null
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${ACCOUNT_API}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new AccountApiError('failed')
  }
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // Not ours (a proxy's error page)
  }
  if (!res.ok) {
    const code = typeof json.error === 'string' ? (json.error as AccountError) : 'failed'
    // Signed out on the server: the home page's link stops saying 我的帳號
    if (code === 'signed_out') forgetAccountHint()
    if (code === 'unknown_passkey' && typeof json.credentialId === 'string') {
      forgetPasskey(location.hostname, json.credentialId)
    }
    throw new AccountApiError(code, json)
  }
  return json as T
}

/** Everything /me shows, or null when this browser is not signed in */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    const me = await call<MeResponse>('GET', '')
    rememberAccountHint(me.account.name)
    return me
  } catch (error) {
    if (error instanceof AccountApiError && error.code === 'signed_out') return null
    throw error
  }
}

/** A new account with a passkey made on this device; `turnstileToken` when the Worker asked */
export async function signUp(name: string, turnstileToken?: string): Promise<AccountInfo> {
  const { options } = await call<{ options: CreationOptionsJSON }>(
    'POST',
    '/register/options',
    { name },
    turnstileToken ? { [TURNSTILE_HEADER]: turnstileToken } : {},
  )
  const credential = await createPasskey(options)
  const { account } = await call<{ account: AccountInfo }>('POST', '/register', { credential })
  rememberAccountHint(account.name)
  return account
}

/** Signs in with any of this site's passkeys (the browser lists them; no user name) */
export async function signIn(): Promise<AccountInfo> {
  const { options } = await call<{ options: RequestOptionsJSON }>('POST', '/login/options', {})
  const credential = await getPasskey(options)
  const { account } = await call<{ account: AccountInfo }>('POST', '/login', { credential })
  rememberAccountHint(account.name)
  return account
}

export async function signOut(): Promise<void> {
  try {
    await call('POST', '/logout', {})
  } finally {
    forgetAccountHint()
  }
}

export async function renameAccount(name: string): Promise<AccountInfo> {
  const { account } = await call<{ account: AccountInfo }>('PATCH', '', { name })
  rememberAccountHint(account.name)
  return account
}

export async function deleteAccount(): Promise<void> {
  await call('DELETE', '')
  forgetAccountHint()
}

/** One more passkey for the signed-in account, made on this device */
export async function addPasskey(): Promise<PasskeyInfo> {
  const { options } = await call<{ options: CreationOptionsJSON }>('POST', '/passkeys/options', {})
  const credential = await createPasskey(options)
  const { passkey } = await call<{ passkey: PasskeyInfo }>('POST', '/passkeys', { credential })
  return passkey
}

export async function removePasskey(id: string): Promise<void> {
  await call('DELETE', `/passkeys/${encodeURIComponent(id)}`)
}

export async function signOutSession(id: string): Promise<void> {
  await call('DELETE', `/sessions/${encodeURIComponent(id)}`)
}

export async function signOutOthers(): Promise<number> {
  const { signedOut } = await call<{ signedOut: number }>('DELETE', '/sessions')
  return signedOut
}

export async function createPersistentRoom(slug: string, name: string): Promise<PersistentRoomInfo> {
  const { room } = await call<{ room: PersistentRoomInfo }>('POST', '/rooms', {
    slug,
    name: name || null,
  })
  return room
}

export async function updatePersistentRoom(
  slug: string,
  change: RoomSettingsChange,
): Promise<PersistentRoomInfo> {
  const { room } = await call<{ room: PersistentRoomInfo }>(
    'PATCH',
    `/rooms/${encodeURIComponent(slug)}`,
    change,
  )
  return room
}

export async function deletePersistentRoom(slug: string): Promise<void> {
  await call('DELETE', `/rooms/${encodeURIComponent(slug)}`)
}

// Scheduled meetings (I3, e1-t14)

export async function createMeeting(input: MeetingInput): Promise<MeetingInfo> {
  const { meeting } = await call<{ meeting: MeetingInfo }>('POST', '/meetings', input)
  return meeting
}

export async function updateMeeting(id: string, input: MeetingInput): Promise<MeetingInfo> {
  const { meeting } = await call<{ meeting: MeetingInfo }>('PUT', `/meetings/${encodeURIComponent(id)}`, input)
  return meeting
}

export async function deleteMeeting(id: string): Promise<void> {
  await call('DELETE', `/meetings/${encodeURIComponent(id)}`)
}

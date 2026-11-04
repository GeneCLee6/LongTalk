// @vitest-environment node
// I2 (e1-t12, e1-t13): the account API on a real SQLite with the real migrations (d1.ts) and a
// software passkey authenticator: sign-up, sign-in, sessions (cookie, rotation, expiry, signing
// others out), CSRF, limits, passkeys, persistent rooms and deleting everything.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHALLENGE_TTL_MS,
  MAX_PERSISTENT_ROOMS,
  SESSION_IDLE_MS,
  SESSION_ROTATE_GRACE_MS,
  SESSION_ROTATE_MS,
} from '../../shared/account.ts'
import { resetAbuseState, type GuardDeps } from '../../worker/abuse.ts'
import { handleAccount } from '../../worker/accounts.ts'
import type { Env } from '../../worker/app.ts'
import { SESSION_COOKIE } from '../../worker/session.ts'
import { ORIGIN, setup } from './accountHarness.ts'
import { SoftAuthenticator } from './authenticator.ts'
import { fakeD1 } from './d1.ts'

beforeEach(() => resetAbuseState())

describe('signing up and in with a passkey', () => {
  it('makes an account signed in with a secure cookie, and nothing but what it needs', async () => {
    const t = setup()
    const alice = new t.Browser()
    const res = await alice.signUp('  Alice  ')
    expect(res.status).toBe(201)
    expect(res.setCookie).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=\\d+; HttpOnly; Secure; SameSite=Lax$`),
    )
    const me = await alice.me()
    expect(me.account.name).toBe('Alice')
    expect(me.passkeys).toHaveLength(1)
    expect(me.sessions).toEqual([expect.objectContaining({ current: true })])
    // Only the token's hash is stored, never the token
    const row = t.sqlite.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }
    expect(row.token_hash).not.toBe(alice.cookie)
    const columns = t.sqlite.prepare("SELECT name FROM pragma_table_info('accounts')").all()
    expect(columns.map((c) => (c as { name: string }).name)).toEqual(['id', 'name', 'created_at'])
  })

  it('signs out, and back in with no user name', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    const out = await alice.call('POST', '/logout', {})
    expect(out.status).toBe(204)
    expect(out.setCookie).toContain('Max-Age=0')
    expect(alice.cookie).toBeNull()
    expect((await alice.call('GET', '')).status).toBe(401)
    expect(t.count('sessions')).toBe(0)
    const back = await alice.signIn()
    expect(back.status).toBe(200)
    expect((back.json.account as { name: string }).name).toBe('Alice')
    const me = await alice.me()
    expect(me.passkeys[0].lastUsedAt).not.toBeNull()
  })

  it('uses a challenge once, and only while it lasts', async () => {
    const t = setup()
    const alice = new t.Browser()
    const options = await alice.call('POST', '/register/options', { name: 'Alice' })
    const credential = await alice.authenticator.create(options.json.options as never, ORIGIN)
    expect((await alice.call('POST', '/register', { credential })).status).toBe(201)
    const again = await alice.call('POST', '/register', { credential })
    expect(again.json.error).toBe('challenge_expired')
    const login = await alice.call('POST', '/login/options', {})
    t.tick(CHALLENGE_TTL_MS + 1)
    const late = await alice.authenticator.get(login.json.options as never, ORIGIN)
    expect((await alice.call('POST', '/login', { credential: late })).json.error).toBe('challenge_expired')
  })

  it('refuses a passkey from another site, an unknown one, and a wrong user handle', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    await alice.call('POST', '/logout', {})
    const options = await alice.call('POST', '/login/options', {})
    const elsewhere = await alice.authenticator.get(options.json.options as never, 'https://evil.example')
    expect((await alice.call('POST', '/login', { credential: elsewhere })).json.error).toBe('verification_failed')
    const stranger = new t.Browser()
    const strangerKey = new SoftAuthenticator()
    await strangerKey.create(
      { rp: { id: 'longtalk.example' }, user: { id: 'eA', name: 'x' }, challenge: 'eA', pubKeyCredParams: [] },
      ORIGIN,
    )
    const unknown = await stranger.signIn(strangerKey)
    expect(unknown.json).toMatchObject({ error: 'unknown_passkey', credentialId: expect.any(String) })
    const options2 = await alice.call('POST', '/login/options', {})
    const answer = await alice.authenticator.get(options2.json.options as never, ORIGIN)
    answer.response.userHandle = 'b3RoZXI'
    expect((await alice.call('POST', '/login', { credential: answer })).json.error).toBe('verification_failed')
    expect(alice.cookie).toBeNull()
  })

  it('needs a name, and counts sign-ups and sign-ins per network', async () => {
    const t = setup()
    const alice = new t.Browser()
    expect((await alice.call('POST', '/register/options', { name: '   ' })).status).toBe(400)
    const ip = { 'CF-Connecting-IP': '203.0.113.7' }
    t.refuseLimit('register')
    const refused = await alice.call('POST', '/register/options', { name: 'Alice' }, ip)
    expect(refused.status).toBe(429)
    expect(refused.json).toEqual({ error: 'rate_limited', retryAfter: 61 })
    t.refuseLimit('signin')
    expect((await alice.call('POST', '/login/options', {}, ip)).status).toBe(429)
    expect(t.limits).toEqual(['register', 'signin'])
  })
})

describe('CSRF', () => {
  it('refuses a state change without this origin or a JSON body', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    expect((await alice.call('DELETE', '', undefined, { Origin: 'https://evil.example' })).json.error).toBe(
      'forbidden_origin',
    )
    // A preview on the same workers.dev site is another origin
    expect(
      (await alice.call('POST', '/logout', {}, { Origin: 'https://longtalk-pr-1.example' })).status,
    ).toBe(403)
    const noOrigin = new Request(`${ORIGIN}/api/account/logout`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${alice.cookie}`, 'Content-Type': 'application/json' },
    })
    const env = { DB: fakeD1().db } as unknown as Env
    expect((await handleAccount(noOrigin, env, new URL(noOrigin.url), { guard: {} as GuardDeps, room: () => ({}) as never })).status).toBe(403)
    expect((await alice.call('PATCH', '', 'x', { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await alice.me()).account.name).toBe('Alice')
  })
})

describe('sessions', () => {
  it('rotates the token once a day, the old one working a moment longer', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    const first = alice.cookie!
    t.tick(SESSION_ROTATE_MS)
    const res = await alice.call('GET', '')
    expect(res.status).toBe(200)
    expect(res.setCookie).not.toBeNull()
    expect(alice.cookie).not.toBe(first)
    // A request already on its way with the old cookie
    const late = new t.Browser()
    late.cookie = first
    expect((await late.call('GET', '')).status).toBe(200)
    t.tick(SESSION_ROTATE_GRACE_MS)
    expect((await late.call('GET', '')).status).toBe(401)
    expect((await alice.call('GET', '')).status).toBe(200)
  })

  it('ends after SESSION_IDLE_MS unused', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    t.tick(SESSION_IDLE_MS)
    expect((await alice.call('GET', '')).status).toBe(401)
  })

  it('lists the signed-in browsers and signs the others out', async () => {
    const t = setup()
    const phone = new t.Browser()
    await phone.signUp('Alice')
    const laptop = new t.Browser()
    expect((await laptop.signIn(phone.authenticator)).status).toBe(200)
    const tablet = new t.Browser()
    await tablet.signIn(phone.authenticator)
    const me = await laptop.me()
    expect(me.sessions).toHaveLength(3)
    expect(me.sessions.filter((s) => s.current)).toHaveLength(1)
    const phoneSession = (await phone.me()).sessions.find((s) => s.current)!
    expect((await laptop.call('DELETE', `/sessions/${phoneSession.id}`)).status).toBe(204)
    expect((await phone.call('GET', '')).status).toBe(401)
    expect((await laptop.call('DELETE', '/sessions')).json).toEqual({ signedOut: 1 })
    expect((await tablet.call('GET', '')).status).toBe(401)
    expect((await laptop.me()).sessions).toHaveLength(1)
  })
})

describe('passkeys', () => {
  it('adds another device, refuses the same one twice, and never removes the last', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    const options = await alice.call('POST', '/passkeys/options', {})
    const exclude = (options.json.options as { excludeCredentials: unknown[] }).excludeCredentials
    expect(exclude).toHaveLength(1)
    // The same authenticator says it already has one
    await expect(alice.authenticator.create(options.json.options as never, ORIGIN)).rejects.toThrow()
    const second = new SoftAuthenticator({ synced: true, aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4' })
    const credential = await second.create(options.json.options as never, ORIGIN)
    const added = await alice.call('POST', '/passkeys', { credential })
    expect(added.status).toBe(201)
    expect(added.json.passkey).toMatchObject({ provider: 'google', backedUp: true })
    const other = new t.Browser()
    expect((await other.signIn(second)).status).toBe(200)
    const [firstKey] = (await alice.me()).passkeys
    expect((await alice.call('DELETE', `/passkeys/${firstKey.id}`)).status).toBe(204)
    const [last] = (await alice.me()).passkeys
    expect((await alice.call('DELETE', `/passkeys/${last.id}`)).json.error).toBe('last_passkey')
    // A challenge for someone else's account does not add to this one
    const bob = new t.Browser()
    await bob.signUp('Bob')
    const bobOptions = await bob.call('POST', '/passkeys/options', {})
    const stolen = await new SoftAuthenticator().create(bobOptions.json.options as never, ORIGIN)
    expect((await alice.call('POST', '/passkeys', { credential: stolen })).json.error).toBe('challenge_expired')
  })
})

describe('persistent rooms', () => {
  it('checks the slug, keeps it unique and limits how many', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    const created = await alice.call('POST', '/rooms', { slug: ' Gene-Weekly ', name: '週會' })
    expect(created.status).toBe(201)
    expect(created.json.room).toMatchObject({ slug: 'gene-weekly', name: '週會' })
    expect(t.rooms.get('gene-weekly')?.owner).toBe((await alice.me()).account.id)
    for (const [slug, problem] of [
      ['ab', 'length'],
      ['bad--slug', 'chars'],
      ['-x-y', 'chars'],
      ['admin', 'reserved'],
      ['abcdefghij', 'roomId'],
    ]) {
      expect((await alice.call('POST', '/rooms', { slug })).json, slug).toEqual({ error: 'slug_invalid', problem })
    }
    const bob = new t.Browser()
    await bob.signUp('Bob')
    expect((await bob.call('POST', '/rooms', { slug: 'gene-weekly' })).json.error).toBe('slug_taken')
    for (let i = 1; i < MAX_PERSISTENT_ROOMS; i++) {
      expect((await alice.call('POST', '/rooms', { slug: `room-${i}` })).status).toBe(201)
    }
    expect((await alice.call('POST', '/rooms', { slug: 'one-more' })).json.error).toBe('too_many_rooms')
    expect((await alice.me()).rooms.map((r) => r.slug)).toHaveLength(MAX_PERSISTENT_ROOMS)
  })

  it('edits and deletes only its own rooms', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    await alice.call('POST', '/rooms', { slug: 'alice-room' })
    const edited = await alice.call('PATCH', '/rooms/alice-room', {
      name: 'Standup',
      waitingRoom: true,
      password: '１２３４',
    })
    expect(edited.json.room).toMatchObject({ name: 'Standup', waitingRoom: true, password: true })
    expect((await alice.call('PATCH', '/rooms/alice-room', { password: '12' })).status).toBe(400)
    expect((await alice.call('PATCH', '/rooms/alice-room', { locked: 'yes' })).status).toBe(400)
    const bob = new t.Browser()
    await bob.signUp('Bob')
    expect((await bob.call('PATCH', '/rooms/alice-room', { locked: true })).status).toBe(404)
    expect((await bob.call('DELETE', '/rooms/alice-room')).status).toBe(404)
    expect((await alice.call('DELETE', '/rooms/alice-room')).status).toBe(204)
    expect(t.destroyed).toEqual(['alice-room'])
    expect((await alice.me()).rooms).toEqual([])
    // The slug is free again
    expect((await bob.call('POST', '/rooms', { slug: 'alice-room' })).status).toBe(201)
  })
})

describe('deleting the account', () => {
  it('deletes every row and every room, and signs the browser out', async () => {
    const t = setup()
    const alice = new t.Browser()
    await alice.signUp('Alice')
    const laptop = new t.Browser()
    await laptop.signIn(alice.authenticator)
    await alice.call('POST', '/rooms', { slug: 'alice-one' })
    await alice.call('POST', '/rooms', { slug: 'alice-two' })
    const bob = new t.Browser()
    await bob.signUp('Bob')
    const res = await alice.call('DELETE', '')
    expect(res.status).toBe(204)
    expect(alice.cookie).toBeNull()
    expect(t.destroyed.sort()).toEqual(['alice-one', 'alice-two'])
    expect((await laptop.call('GET', '')).status).toBe(401)
    expect(t.count('accounts')).toBe(1)
    expect(t.count('credentials')).toBe(1)
    expect(t.count('sessions')).toBe(1)
    expect(t.count('rooms')).toBe(0)
    // The passkey still in the password manager no longer signs in
    expect((await alice.signIn()).json.error).toBe('unknown_passkey')
  })
})

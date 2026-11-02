import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ServerMessage } from '../../shared/protocol.ts'
import { STUN_SERVER, TURN_TTL_SECONDS, usableIceServers } from '../../shared/turn.ts'
import { RoomHost } from '../../worker/room-host.ts'
import { REALTIME_API_BASE } from '../../worker/sfu.ts'
import { handleTurn, type TurnDeps, type TurnEnv } from '../../worker/turn.ts'

const ROOM_ID = 'abcdefghij'
const configured: TurnEnv = { REALTIME_TURN_KEY_ID: 'key1', REALTIME_TURN_KEY_API_TOKEN: 'k3y' }

const CLOUDFLARE_ANSWER = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'user1',
      credential: 'cred1',
    },
  ],
}

function setup(answer: unknown = CLOUDFLARE_ANSWER, status = 201) {
  const sent = new Map<string, ServerMessage[]>()
  const host = new RoomHost({
    sockets: {
      send: (conn, message) => sent.set(conn, [...(sent.get(conn) ?? []), message]),
      close() {},
    },
    storage: {
      saveRoom() {},
      saveRev() {},
      saveSessions() {},
      saveUsage() {},
      saveSchedule() {},
      clear() {},
    },
    now: () => 1000,
    newMemberId: () => 'm1',
    newToken: () => 't'.repeat(43),
  })
  host.create({ id: ROOM_ID, createdAt: 1 })
  expect(host.admit(String(PROTOCOL_VERSION))).toEqual({ ok: true })
  host.opened('c1')
  host.message('c1', JSON.stringify({ t: 'join', name: 'Gene', token: null }))
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(answer), { status }),
  )
  const deps: TurnDeps = {
    room: () => ({ sfuAccess: async (token, s, pulls) => host.sfuAccess(token, s, pulls) }),
    fetch: fetchMock,
  }
  return { host, fetchMock, deps, token: 't'.repeat(43) }
}

const req = (token: string | null, method = 'POST', path = `/api/turn/${ROOM_ID}`) =>
  new Request(`https://x${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })

describe('TURN credentials', () => {
  it('gives a member short-lived credentials, without port 53 and without the key', async () => {
    const t = setup()
    const res = await handleTurn(req(t.token), configured, t.deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(text).not.toContain('k3y')
    expect(text).not.toMatch(/:53[?"]/)
    expect(JSON.parse(text)).toEqual({
      turn: true,
      ttlSeconds: TURN_TTL_SECONDS,
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turn:turn.cloudflare.com:3478?transport=tcp',
            'turns:turn.cloudflare.com:5349?transport=tcp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'user1',
          credential: 'cred1',
        },
      ],
    })
    const [url, init] = t.fetchMock.mock.calls[0]
    expect(url).toBe(`${REALTIME_API_BASE}/turn/keys/key1/credentials/generate-ice-servers`)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer k3y')
    expect(JSON.parse(String(init?.body))).toEqual({ ttl: TURN_TTL_SECONDS })
  })

  it.each([
    ['no token', null],
    ['a malformed token', 'abc'],
    ['a token the room does not know', 'S'.repeat(43)],
  ])('refuses %s with 401, before asking Cloudflare', async (_label, token) => {
    const t = setup()
    const res = await handleTurn(req(token), configured, t.deps)
    expect(res.status).toBe(401)
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a member who left', async () => {
    const t = setup()
    t.host.message('c1', JSON.stringify({ t: 'leave' }))
    expect((await handleTurn(req(t.token), configured, t.deps)).status).toBe(401)
  })

  it('answers 404 and 405 for other paths and methods', async () => {
    const t = setup()
    expect(
      (await handleTurn(req(t.token, 'POST', '/api/turn/nope'), configured, t.deps)).status,
    ).toBe(404)
    const get = await handleTurn(req(t.token, 'GET'), configured, t.deps)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
  })

  it('falls back to STUN only without the secrets', async () => {
    const t = setup()
    const res = await handleTurn(req(t.token), {}, t.deps)
    expect(await res.json()).toEqual({ iceServers: [STUN_SERVER], turn: false, ttlSeconds: null })
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['an error status', { errors: [] }, 500],
    ['an answer without credentials', { iceServers: [{ urls: 'stun:x:3478' }] }, 201],
    ['an answer that is not a list', { iceServers: 'nope' }, 201],
  ])('falls back to STUN only on %s', async (_label, answer, status) => {
    const t = setup(answer, status)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await handleTurn(req(t.token), configured, t.deps)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ turn: false, iceServers: [STUN_SERVER] })
  })

  it('falls back to STUN only when Cloudflare cannot be reached', async () => {
    const t = setup()
    t.fetchMock.mockRejectedValueOnce(new Error('network'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await (await handleTurn(req(t.token), configured, t.deps)).json()).toMatchObject({
      turn: false,
    })
  })

  it('adds the STUN server when the answer has none', async () => {
    const t = setup({ iceServers: [{ urls: 'turn:t:3478', username: 'u', credential: 'c' }] })
    const body = (await (await handleTurn(req(t.token), configured, t.deps)).json()) as {
      iceServers: unknown
    }
    expect(body.iceServers).toEqual([
      STUN_SERVER,
      { urls: ['turn:t:3478'], username: 'u', credential: 'c' },
    ])
  })
})

describe('usableIceServers', () => {
  it('drops port 53 and empty entries, refuses what is not a server list', () => {
    expect(
      usableIceServers([{ urls: 'stun:a:53' }, { urls: ['turn:b:3478', 'turn:b:53'] }]),
    ).toEqual([{ urls: ['turn:b:3478'] }])
    expect(usableIceServers(null)).toBeNull()
    expect(usableIceServers([{ urls: 5 }])).toBeNull()
    expect(usableIceServers([null])).toBeNull()
  })
})

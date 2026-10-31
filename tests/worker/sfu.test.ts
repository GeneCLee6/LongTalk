import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ServerMessage } from '../../shared/protocol.ts'
import type { UsageState } from '../../shared/usage.ts'
import { RoomHost, type RoomHostDeps } from '../../worker/room-host.ts'
import {
  REALTIME_API_BASE,
  handleSfu,
  planTracks,
  sdpMidKinds,
  type SfuDeps,
  type SfuEnv,
} from '../../worker/sfu.ts'

const configured: SfuEnv = { REALTIME_APP_ID: 'app1', REALTIME_APP_SECRET: 's3cret' }
const ROOM_ID = 'abcdefghij'
const OTHER_ROOM = 'bcdefghijk'
const STRANGER = 'S'.repeat(43)

// An offer with an audio and a video m-section, as a browser makes for mic + cam
const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:0',
  'a=sendonly',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=sendonly',
  '',
].join('\r\n')

const quietDeps = (overrides: Partial<RoomHostDeps> = {}): RoomHostDeps => ({
  sockets: { send() {}, close() {} },
  storage: { saveRoom() {}, saveRev() {}, saveSessions() {}, saveUsage() {} },
  now: () => 1000,
  newMemberId: () => 'x',
  newToken: () => 'x',
  ...overrides,
})

/** A real RoomHost behind the proxy, with two members: Gene and Wei */
function room() {
  let n = 0
  const sent = new Map<string, ServerMessage[]>()
  const host = new RoomHost(
    quietDeps({
      sockets: {
        send: (conn, message) => sent.set(conn, [...(sent.get(conn) ?? []), message]),
        close: () => {},
      },
      newMemberId: () => `m${++n}`,
      newToken: () => `${'t'.repeat(42)}${n}`,
    }),
  )
  host.create({ id: ROOM_ID, createdAt: 1 })
  const join = (name: string) => {
    expect(host.admit(String(PROTOCOL_VERSION))).toEqual({ ok: true })
    const conn = `c-${name}`
    host.opened(conn)
    host.message(conn, JSON.stringify({ t: 'join', name, token: null }))
    const welcome = sent.get(conn)!.find((m) => m.t === 'welcome')
    if (welcome?.t !== 'welcome') throw new Error('not welcomed')
    return { conn, token: welcome.token, id: welcome.you }
  }
  return { host, gene: join('Gene'), wei: join('Wei') }
}

function setup(body: unknown = {}, status = 200, usage: UsageState = 'normal') {
  const r = room()
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  )
  const usageMock = vi.fn(async () => usage)
  const deps: SfuDeps = {
    room: (roomId) => {
      // Another room's object knows nobody
      const host = roomId === ROOM_ID ? r.host : new RoomHost(quietDeps())
      return {
        sfuAccess: async (token, sessionId, pulls) => host.sfuAccess(token, sessionId, pulls),
        bindSfu: async (token, sessionId) => host.bindSfu(token, sessionId),
      }
    },
    usage: usageMock,
    fetch: fetchMock,
  }
  /** `who` publishes `tracks` on `sessionId` */
  const publish = (
    who: { conn: string; token: string },
    sessionId: string,
    tracks: { trackName: string; kind: string }[],
  ) => {
    r.host.bindSfu(who.token, sessionId)
    r.host.message(who.conn, JSON.stringify({ t: 'tracks', sessionId, tracks }))
  }
  return { ...r, fetchMock, usageMock, deps, publish }
}

function req(method: string, path: string, token: string | null, body?: unknown): Request {
  return new Request(`https://x${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const base = `/api/sfu/${ROOM_ID}/sessions`

describe('SFU proxy: membership', () => {
  it('creates a session for a member and records it as theirs; the secret never leaks', async () => {
    const t = setup({ sessionId: 'sess-g' }, 201)
    const res = await handleSfu(req('POST', base, t.gene.token), configured, t.deps)
    expect(res.status).toBe(201)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ sessionId: 'sess-g' })
    expect(text).not.toContain('s3cret')
    const [url, init] = t.fetchMock.mock.calls[0]
    expect(url).toBe(`${REALTIME_API_BASE}/apps/app1/sessions/new`)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer s3cret')
    expect(t.host.sfuAccess(t.gene.token, 'sess-g', [])).toMatchObject({ ok: true })
  })

  it.each([
    ['no token', null],
    ['a malformed token', 'abc'],
    ['a token the room does not know', STRANGER],
  ])('refuses %s with 401, before calling Realtime', async (_label, token) => {
    const t = setup({ sessionId: 'sess-x' })
    const res = await handleSfu(req('POST', base, token), configured, t.deps)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a member's token in another room", async () => {
    const t = setup({ sessionId: 'sess-x' })
    const res = await handleSfu(
      req('POST', `/api/sfu/${OTHER_ROOM}/sessions`, t.gene.token),
      configured,
      t.deps,
    )
    expect(res.status).toBe(401)
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it("refuses to drive someone else's session (403)", async () => {
    const t = setup({})
    t.host.bindSfu(t.wei.token, 'sess-w')
    const res = await handleSfu(
      req('PUT', `${base}/sess-w/renegotiate`, t.gene.token, { sessionDescription: {} }),
      configured,
      t.deps,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['PUT', '/tracks/update', '/sessions/sess-g/tracks/update'],
    ['PUT', '/tracks/close', '/sessions/sess-g/tracks/close'],
    ['PUT', '/renegotiate', '/sessions/sess-g/renegotiate'],
  ])("forwards %s %s on the member's own session", async (method, suffix, upPath) => {
    const t = setup({ tracks: [] })
    t.host.bindSfu(t.gene.token, 'sess-g')
    const body = { tracks: [{ mid: '0' }], force: false }
    const res = await handleSfu(
      req(method, `${base}/sess-g${suffix}`, t.gene.token, body),
      configured,
      t.deps,
    )
    expect(res.status).toBe(200)
    const [url, init] = t.fetchMock.mock.calls[0]
    expect(url).toBe(`${REALTIME_API_BASE}/apps/app1${upPath}`)
    expect(init?.method).toBe(method)
    expect(JSON.parse(String(init?.body))).toEqual(body)
  })

  it('pushes local tracks and pulls tracks published in the room', async () => {
    const t = setup({ tracks: [] })
    t.host.bindSfu(t.gene.token, 'sess-g')
    t.publish(t.wei, 'sess-w', [{ trackName: 'cam-1', kind: 'cam' }])
    const push = {
      sessionDescription: { type: 'offer', sdp: OFFER },
      tracks: [{ location: 'local', mid: '0', trackName: 'mic-1' }],
    }
    const pull = { tracks: [{ location: 'remote', sessionId: 'sess-w', trackName: 'cam-1' }] }
    for (const body of [push, pull]) {
      const res = await handleSfu(
        req('POST', `${base}/sess-g/tracks`, t.gene.token, body),
        configured,
        t.deps,
      )
      expect(res.status).toBe(200)
    }
    expect(t.fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${REALTIME_API_BASE}/apps/app1/sessions/sess-g/tracks/new`,
      `${REALTIME_API_BASE}/apps/app1/sessions/sess-g/tracks/new`,
    ])
    // The month's state is only asked for when a call adds video: the camera pull
    expect(t.usageMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to pull a track that is not published in this room (404)', async () => {
    const t = setup({ tracks: [] })
    t.host.bindSfu(t.gene.token, 'sess-g')
    const res = await handleSfu(
      req('POST', `${base}/sess-g/tracks`, t.gene.token, {
        tracks: [{ location: 'remote', sessionId: 'someone-elsewhere', trackName: 'cam-1' }],
      }),
      configured,
      t.deps,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'track_not_in_room' })
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('does not hand out a session when the member left while it was being created', async () => {
    const t = setup({ sessionId: 'sess-g' }, 201)
    const deps: SfuDeps = {
      ...t.deps,
      room: () => ({
        sfuAccess: async (token, sessionId, pulls) => t.host.sfuAccess(token, sessionId, pulls),
        bindSfu: async () => false,
      }),
    }
    const res = await handleSfu(req('POST', base, t.gene.token), configured, deps)
    expect(res.status).toBe(401)
  })
})

describe('SFU proxy: free-tier guard (e11-t13)', () => {
  const pushVideo = {
    sessionDescription: { type: 'offer', sdp: OFFER },
    tracks: [{ location: 'local', mid: '1', trackName: 'cam-1' }],
  }
  const pushAudio = {
    sessionDescription: { type: 'offer', sdp: OFFER },
    tracks: [{ location: 'local', mid: '0', trackName: 'mic-1' }],
  }

  it('refuses a new video track once the month is audio-only; audio still goes through', async () => {
    const t = setup({ tracks: [] }, 200, 'audioOnly')
    t.host.bindSfu(t.gene.token, 'sess-g')
    const send = (body: unknown) =>
      handleSfu(req('POST', `${base}/sess-g/tracks`, t.gene.token, body), configured, t.deps)
    const video = await send(pushVideo)
    expect(video.status).toBe(403)
    expect(await video.json()).toEqual({ error: 'usage_audio_only' })
    expect(t.fetchMock).not.toHaveBeenCalled()
    expect((await send(pushAudio)).status).toBe(200)
  })

  it("refuses to pull someone's camera once the month is audio-only, not their microphone", async () => {
    const t = setup({ tracks: [] }, 200, 'audioOnly')
    t.host.bindSfu(t.gene.token, 'sess-g')
    t.publish(t.wei, 'sess-w', [
      { trackName: 'mic-1', kind: 'mic' },
      { trackName: 'cam-1', kind: 'cam' },
    ])
    const pull = (trackName: string) =>
      handleSfu(
        req('POST', `${base}/sess-g/tracks`, t.gene.token, {
          tracks: [{ location: 'remote', sessionId: 'sess-w', trackName }],
        }),
        configured,
        t.deps,
      )
    expect((await pull('cam-1')).status).toBe(403)
    expect((await pull('mic-1')).status).toBe(200)
  })

  it('lets video through below the audio-only threshold', async () => {
    for (const state of ['normal', 'low'] as const) {
      const t = setup({ tracks: [] }, 200, state)
      t.host.bindSfu(t.gene.token, 'sess-g')
      const res = await handleSfu(
        req('POST', `${base}/sess-g/tracks`, t.gene.token, pushVideo),
        configured,
        t.deps,
      )
      expect(res.status).toBe(200)
    }
  })
})

describe('SFU proxy: what it forwards', () => {
  it('passes Realtime errors through with their status', async () => {
    const t = setup({ errorCode: 'session_error', errorDescription: 'nope' }, 400)
    t.host.bindSfu(t.gene.token, 'sess-g')
    const res = await handleSfu(
      req('PUT', `${base}/sess-g/renegotiate`, t.gene.token, { sessionDescription: {} }),
      configured,
      t.deps,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ errorCode: 'session_error', errorDescription: 'nope' })
  })

  it('answers 503 to a member when the Realtime app is not configured', async () => {
    const t = setup({})
    const res = await handleSfu(req('POST', base, t.gene.token), {}, t.deps)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'sfu_not_configured' })
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', base],
    ['GET', `${base}/sess-g`],
    ['DELETE', `${base}/sess-g`],
    ['POST', `${base}/sess-g/datachannels/new`],
    ['GET', '/api/sfu/apps'],
    ['POST', '/api/sfu/sessions'],
    ['POST', '/api/sfu/not-a-room/sessions'],
  ])('refuses %s %s, which is not on the allow-list', async (method, path) => {
    const t = setup({})
    const res = await handleSfu(req(method, path, t.gene.token), configured, t.deps)
    expect(res.status).toBe(404)
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('rejects malformed session ids and bodies before calling Realtime', async () => {
    const t = setup({})
    t.host.bindSfu(t.gene.token, 's')
    const send = (path: string, body?: unknown) =>
      handleSfu(req('PUT', path, t.gene.token, body), configured, t.deps)
    expect((await send(`${base}/a%2F..%2Fb/renegotiate`, {})).status).toBe(400)
    expect((await send(`${base}/s/renegotiate`, 'sdp')).status).toBe(400)
    expect((await send(`${base}/s/renegotiate`, [])).status).toBe(400)
    expect((await send(`${base}/s/renegotiate`, { sdp: 'x'.repeat(70_000) })).status).toBe(400)
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('only forwards track bodies the client sends', () => {
    const offer = { type: 'offer', sdp: OFFER }
    const remote = { location: 'remote', sessionId: 's', trackName: 't' }
    expect(planTracks({ tracks: [] })).toBeNull()
    expect(planTracks({ autoDiscover: true, tracks: [remote] })).toBeNull()
    // A local track whose mid is not in the offer
    expect(
      planTracks({ sessionDescription: offer, tracks: [{ location: 'local', mid: '7' }] }),
    ).toBeNull()
    expect(planTracks({ tracks: [{ location: 'remote', trackName: 'x' }] })).toBeNull()
    expect(planTracks({ tracks: [{ location: 'elsewhere' }] })).toBeNull()
    expect(planTracks({ tracks: Array(9).fill(remote) })).toBeNull()
    expect(
      planTracks({ sessionDescription: offer, tracks: [{ location: 'local', mid: '1' }, remote] }),
    ).toEqual({ pushesVideo: true, pulls: [{ sessionId: 's', trackName: 't' }] })
  })

  it('reads the media type of each mid from an SDP', () => {
    expect([...sdpMidKinds(OFFER)]).toEqual([
      ['0', 'audio'],
      ['1', 'video'],
    ])
    expect(sdpMidKinds('').size).toBe(0)
  })

  it('answers 502 when Realtime is unreachable, answers non-JSON or no session id', async () => {
    for (const fetchImpl of [
      vi.fn(async () => {
        throw new Error('network')
      }),
      vi.fn(async () => new Response('<html>', { status: 500 })),
      vi.fn(async () => Response.json({}, { status: 201 })),
    ]) {
      const t = setup()
      const res = await handleSfu(req('POST', base, t.gene.token), configured, {
        ...t.deps,
        fetch: fetchImpl,
      })
      expect(res.status).toBe(502)
    }
  })
})

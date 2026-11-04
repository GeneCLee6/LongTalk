import { describe, expect, it, vi } from 'vitest'
import { isRoomId } from '../../shared/room-id.ts'
import type { UsageStatus } from '../../shared/usage.ts'
import type { ClientEvent } from '../../shared/telemetry.ts'
import { handleRequest, type Env } from '../../worker/app.ts'
import { TelemetryLedger } from '../../worker/telemetry.ts'

/** A fake ROOM namespace: one object per name, with `create`, `summary` and `fetch` like RoomDO's */
function fakeRooms() {
  const created = new Set<string>()
  const fetched: Request[] = []
  let collisions = 0
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      create: async (id: string) => {
        if (collisions > 0) {
          collisions--
          return false
        }
        if (created.has(id) || id !== name) return false
        created.add(id)
        return true
      },
      summary: async () => (created.has(name) ? { id: name, createdAt: 1, memberCount: 2 } : null),
      fetch: async (request: Request) => {
        fetched.push(request)
        return new Response('upgraded')
      },
    }),
  }
  return {
    namespace: namespace as unknown as Env['ROOM'],
    created,
    fetched,
    collide: (n: number) => {
      collisions = n
    },
  }
}

/** A fake USAGE namespace: one object answering `status` */
function fakeUsage(status: UsageStatus | Error = { month: '2026-10', bytes: 12, state: 'normal' }) {
  const calls: string[] = []
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      status: async () => {
        calls.push(name)
        if (status instanceof Error) throw status
        return status
      },
    }),
  }
  return { namespace: namespace as unknown as Env['USAGE'], calls }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response('<html>')) } as unknown as Fetcher,
    ROOM: fakeRooms().namespace,
    USAGE: fakeUsage().namespace,
    TELEMETRY: fakeTelemetry().namespace,
    // Requests without CF-Connecting-IP (all of these) are never limited: no guard calls
    GUARD: { idFromName: (name: string) => name, get: () => ({}) } as unknown as Env['GUARD'],
    ...overrides,
  }
}

/** A fake TELEMETRY namespace: accepts everything, answers an empty summary */
function fakeTelemetry() {
  const recorded: { client: string; events: ClientEvent[] }[] = []
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      record: async (client: string, events: ClientEvent[]) => {
        recorded.push({ client, events })
        return events
      },
      summary: async () => new TelemetryLedger(null).summary(5000),
    }),
  }
  return { namespace: namespace as unknown as Env['TELEMETRY'], recorded }
}

const post = () => new Request('https://x/api/rooms', { method: 'POST' })
const upgrade = { headers: { Upgrade: 'websocket' } }

describe('worker', () => {
  it('answers the health check with the deployed version', async () => {
    const res = await handleRequest(
      new Request('https://x/api/health'),
      env({ APP_VERSION: 'abc123' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: 'abc123' })
  })

  it('answers unknown API paths with 404 instead of the app', async () => {
    const e = env()
    const res = await handleRequest(new Request('https://x/api/nope'), e)
    expect(res.status).toBe(404)
    expect(e.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('hands every other path to the static assets', async () => {
    const e = env()
    const res = await handleRequest(new Request('https://x/r/abc'), e)
    expect(await res.text()).toBe('<html>')
    expect(e.ASSETS.fetch).toHaveBeenCalledOnce()
  })
})

describe('POST /api/rooms', () => {
  it('creates the room in its own Durable Object and answers its id', async () => {
    const rooms = fakeRooms()
    const res = await handleRequest(post(), env({ ROOM: rooms.namespace }))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect(isRoomId(id)).toBe(true)
    expect([...rooms.created]).toEqual([id])
  })

  it('tries a fresh id when one is taken', async () => {
    const rooms = fakeRooms()
    rooms.collide(2)
    const res = await handleRequest(post(), env({ ROOM: rooms.namespace }))
    expect(res.status).toBe(201)
    expect(rooms.created.size).toBe(1)
  })

  it('gives up after three collisions', async () => {
    const rooms = fakeRooms()
    rooms.collide(3)
    const res = await handleRequest(post(), env({ ROOM: rooms.namespace }))
    expect(res.status).toBe(503)
  })

  it('only accepts POST', async () => {
    const res = await handleRequest(new Request('https://x/api/rooms'), env())
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })
})

describe('GET /api/rooms/:id', () => {
  it("answers the room's summary, or 404 when there is no such room", async () => {
    const rooms = fakeRooms()
    rooms.created.add('abcdefghij')
    const e = env({ ROOM: rooms.namespace })
    const res = await handleRequest(new Request('https://x/api/rooms/abcdefghij'), e)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ id: 'abcdefghij', createdAt: 1, memberCount: 2, viewer: null })
    const missing = await handleRequest(new Request('https://x/api/rooms/bbbbbbbbbb'), e)
    expect(missing.status).toBe(404)
    const bad = await handleRequest(new Request('https://x/api/rooms/no_pe'), e)
    expect(bad.status).toBe(404)
  })

  it('only accepts GET', async () => {
    const res = await handleRequest(
      new Request('https://x/api/rooms/abcdefghij', { method: 'DELETE' }),
      env(),
    )
    expect(res.status).toBe(405)
  })
})

describe('GET /api/rooms/:id/ws', () => {
  it('hands the WebSocket upgrade to the Durable Object of that room', async () => {
    const rooms = fakeRooms()
    const url = 'https://x/api/rooms/abcdefghij/ws?v=2'
    const res = await handleRequest(new Request(url, upgrade), env({ ROOM: rooms.namespace }))
    expect(await res.text()).toBe('upgraded')
    expect(rooms.fetched.map((request) => request.url)).toEqual([url])
  })

  it('accepts its own origin and refuses a socket opened from another site', async () => {
    const rooms = fakeRooms()
    const url = 'https://x/api/rooms/abcdefghij/ws?v=2'
    const own = await handleRequest(
      new Request(url, { headers: { Upgrade: 'websocket', Origin: 'https://x' } }),
      env({ ROOM: rooms.namespace }),
    )
    expect(await own.text()).toBe('upgraded')
    for (const origin of ['https://evil.example', 'http://x', 'https://x.evil.example', 'null']) {
      const res = await handleRequest(
        new Request(url, { headers: { Upgrade: 'websocket', Origin: origin } }),
        env({ ROOM: rooms.namespace }),
      )
      expect(res.status, origin).toBe(403)
    }
    expect(rooms.fetched).toHaveLength(1)
  })

  it('refuses a path that cannot be a room without waking any object', async () => {
    const rooms = fakeRooms()
    for (const path of [
      '/api/rooms/Short/ws',
      '/api/rooms/abcdefghI0/ws',
      '/api/rooms/abcdefghij/other',
    ]) {
      const res = await handleRequest(
        new Request(`https://x${path}`, upgrade),
        env({ ROOM: rooms.namespace }),
      )
      expect(res.status, path).toBe(404)
    }
    expect(rooms.fetched).toHaveLength(0)
  })

  it('asks for a WebSocket upgrade', async () => {
    const res = await handleRequest(new Request('https://x/api/rooms/abcdefghij/ws'), env())
    expect(res.status).toBe(426)
  })
})

describe('GET /api/usage', () => {
  it("answers the month's count from the one UsageDO", async () => {
    const usage = fakeUsage({ month: '2026-10', bytes: 801e9, state: 'low' })
    const res = await handleRequest(
      new Request('https://x/api/usage'),
      env({ USAGE: usage.namespace }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ month: '2026-10', bytes: 801e9, state: 'low' })
    expect(usage.calls).toEqual(['global'])
  })

  it('only answers GET', async () => {
    const res = await handleRequest(new Request('https://x/api/usage', { method: 'POST' }), env())
    expect(res.status).toBe(405)
  })
})

describe('/api/sfu through the router', () => {
  it('refuses a caller without a member session token, before any Durable Object', async () => {
    const e = env({ REALTIME_APP_ID: 'a', REALTIME_APP_SECRET: 's' })
    const res = await handleRequest(
      new Request('https://x/api/sfu/abcdefghij/sessions', { method: 'POST' }),
      e,
    )
    expect(res.status).toBe(401)
    expect(e.ASSETS.fetch).not.toHaveBeenCalled()
  })
})

describe('/api/turn through the router', () => {
  it('refuses a caller without a member session token, before any Durable Object', async () => {
    const e = env({ REALTIME_TURN_KEY_ID: 'k', REALTIME_TURN_KEY_API_TOKEN: 't' })
    const res = await handleRequest(
      new Request('https://x/api/turn/abcdefghij', { method: 'POST' }),
      e,
    )
    expect(res.status).toBe(401)
    expect(e.ASSETS.fetch).not.toHaveBeenCalled()
  })
})

describe('/api/events and /api/admin through the router (e11-t03)', () => {
  it('hands events to TelemetryDO and answers 202', async () => {
    const telemetry = fakeTelemetry()
    const e = env({ TELEMETRY: telemetry.namespace })
    const res = await handleRequest(
      new Request('https://x/api/events', {
        method: 'POST',
        body: JSON.stringify({ events: [{ type: 'join', ok: true }] }),
      }),
      e,
    )
    expect(res.status).toBe(202)
    expect(telemetry.recorded[0].events).toEqual([{ type: 'join', ok: true }])
    expect(e.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('keeps /api/admin closed without the secret, and opens it with the header', async () => {
    const closed = await handleRequest(new Request('https://x/api/admin/summary'), env())
    expect(closed.status).toBe(503)
    const e = env({ ADMIN_TOKEN: 'fake-test-token' })
    const wrong = await handleRequest(
      new Request('https://x/api/admin/summary', { headers: { Authorization: 'Bearer nope' } }),
      e,
    )
    expect(wrong.status).toBe(401)
    const ok = await handleRequest(
      new Request('https://x/api/admin/summary', {
        headers: { Authorization: 'Bearer fake-test-token' },
      }),
      e,
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ usage: { month: '2026-10' }, analyticsEngine: false })
    const other = await handleRequest(new Request('https://x/api/admin/other'), e)
    expect(other.status).toBe(404)
  })
})

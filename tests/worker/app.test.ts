import { describe, expect, it, vi } from 'vitest'
import { isRoomId } from '../../shared/room-id.ts'
import { handleRequest, type Env } from '../../worker/app.ts'

/** A fake ROOM namespace: one object per name, with `create` and `fetch` like RoomDO's */
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

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response('<html>')) } as unknown as Fetcher,
    ROOM: fakeRooms().namespace,
    ...overrides,
  }
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

describe('GET /api/rooms/:id/ws', () => {
  it('hands the WebSocket upgrade to the Durable Object of that room', async () => {
    const rooms = fakeRooms()
    const url = 'https://x/api/rooms/abcdefghij/ws?v=1'
    const res = await handleRequest(new Request(url, upgrade), env({ ROOM: rooms.namespace }))
    expect(await res.text()).toBe('upgraded')
    expect(rooms.fetched.map((request) => request.url)).toEqual([url])
  })

  it('refuses a path that cannot be a room without waking any object', async () => {
    const rooms = fakeRooms()
    for (const path of [
      '/api/rooms/short/ws',
      '/api/rooms/abcdefghi0/ws',
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_BLOCKS_PATH,
  ISOLATE_ROOM_RATE,
  MAX_OFFENDERS,
  parseBlockRequest,
  ROOM_CREATE_LIMITS,
  takeFromWindows,
  TURNSTILE_HEADER,
} from '../../shared/abuse.ts'
import { API_HEADERS, PAGE_HEADERS } from '../../shared/security-headers.ts'
import type { ClientEvent } from '../../shared/telemetry.ts'
import { isBlocked, resetAbuseState, type GuardDeps } from '../../worker/abuse.ts'
import { handleRequest, type Env } from '../../worker/app.ts'
import { clientKeyOf, networkOf } from '../../worker/client-key.ts'
import { blockedSource, cspEvents, parseCspReport } from '../../worker/csp-report.ts'
import { GuardStore, type GuardStorage } from '../../worker/guard.ts'
import { withApiHeaders } from '../../worker/headers.ts'
import { SITEVERIFY_URL, turnstileSiteKey, verifyTurnstile } from '../../worker/turnstile.ts'

// I1 (e11-t05, e11-t06): the creation limit, Turnstile, the blocklist and /admin's side of it,
// CSP reports and the security headers. The per-socket limits are in room-host.test.ts.

function memoryStorage(): GuardStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, structuredClone(value))
    },
    delete: async (key: string) => data.delete(key),
  }
}

describe('takeFromWindows', () => {
  it('allows up to each window and says how long until the next one fits', () => {
    const windows = [
      { count: 2, windowMs: 1000 },
      { count: 3, windowMs: 10_000 },
    ]
    let times: number[] = []
    for (const at of [0, 100]) {
      const result = takeFromWindows(times, windows, at)
      expect(result.ok).toBe(true)
      times = result.times
    }
    expect(takeFromWindows(times, windows, 500)).toMatchObject({ ok: false, retryAfterMs: 500 })
    let result = takeFromWindows(times, windows, 1000)
    expect(result.ok).toBe(true)
    times = result.times
    // Now the long window is full until the first one leaves it
    result = takeFromWindows(times, windows, 2000)
    expect(result).toMatchObject({ ok: false, retryAfterMs: 8000 })
    expect(takeFromWindows(result.times, windows, 10_000).ok).toBe(true)
  })
})

describe('client keys', () => {
  it('treats an IPv6 /64 as one network, and IPv4-mapped as IPv4', () => {
    expect(networkOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(networkOf('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64')
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(networkOf('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(networkOf('203.0.113.9')).toBe('203.0.113.9')
    expect(networkOf('999.1.1.1')).toBeNull()
    expect(networkOf('not an ip')).toBeNull()
  })

  it('hashes, never keeps the address, and the pepper changes every key', async () => {
    const plain = await clientKeyOf('203.0.113.9', {})
    const peppered = await clientKeyOf('203.0.113.9', { IP_HASH_PEPPER: 'secret-pepper' })
    expect(plain).toMatch(/^[0-9a-f]{24}$/)
    expect(peppered).toMatch(/^[0-9a-f]{24}$/)
    expect(plain).not.toBe(peppered)
    expect(await clientKeyOf('2001:db8:1:2::5', {})).toBe(await clientKeyOf('2001:db8:1:2::9', {}))
    expect(await clientKeyOf('2001:db8:1:3::5', {})).not.toBe(
      await clientKeyOf('2001:db8:1:2::5', {}),
    )
  })
})

describe('GuardStore', () => {
  it('limits room creation per client in every window and remembers it in storage', async () => {
    const storage = memoryStorage()
    let store = await GuardStore.load(storage)
    const [short] = ROOM_CREATE_LIMITS
    for (let i = 0; i < short.count; i++) expect(await store.create('a', i)).toEqual({ ok: true })
    const refused = await store.create('a', short.count)
    expect(refused.ok).toBe(false)
    expect(await store.create('b', short.count)).toEqual({ ok: true })
    // A fresh object (eviction) reads the times back
    store = await GuardStore.load(storage)
    expect((await store.create('a', short.count + 1)).ok).toBe(false)
    expect(await store.create('a', short.windowMs)).toEqual({ ok: true })
    expect(store.summary(0).offenders.map((o) => [o.key, o.counts])).toEqual([
      ['a', { createLimit: 2 }],
    ])
  })

  it('stops a client at the daily limit', async () => {
    const store = await GuardStore.load(memoryStorage())
    const [short, day] = ROOM_CREATE_LIMITS
    let at = 0
    for (let i = 0; i < day.count; i++) {
      expect((await store.create('a', at)).ok).toBe(true)
      // Spread out so the short window never fills
      at += Math.ceil(short.windowMs / short.count) + 1
    }
    expect((await store.create('a', at)).ok).toBe(false)
  })

  it('keeps blocks until they expire, and only the latest offenders', async () => {
    const storage = memoryStorage()
    const store = await GuardStore.load(storage)
    await store.block('k1', 1, 'spam', 0)
    await store.block('k2', 24, '', 0)
    expect(store.blocked(0).sort()).toEqual(['k1', 'k2'])
    expect(store.blocked(3_600_000)).toEqual(['k2'])
    expect(await store.unblock('k2', 0)).toBe(true)
    expect(await store.unblock('k2', 0)).toBe(false)
    expect(store.blocked(0)).toEqual(['k1'])
    expect((await GuardStore.load(storage)).blocked(0)).toEqual(['k1'])
    for (let i = 0; i < MAX_OFFENDERS + 5; i++) await store.note(`o${i}`, 'flood', i)
    const { offenders } = store.summary(0)
    expect(offenders).toHaveLength(MAX_OFFENDERS)
    expect(offenders[0].key).toBe(`o${MAX_OFFENDERS + 4}`)
  })
})

describe('parseBlockRequest', () => {
  it('takes an address or a key, a listed duration and a short note', () => {
    expect(parseBlockRequest({ ip: ' 203.0.113.9 ', hours: 24 })).toEqual({
      ip: '203.0.113.9',
      hours: 24,
      note: undefined,
    })
    expect(parseBlockRequest({ key: 'a'.repeat(24), hours: 1, note: 'x'.repeat(200) })).toEqual({
      key: 'a'.repeat(24),
      hours: 1,
      note: 'x'.repeat(80),
    })
    expect(parseBlockRequest({ ip: '203.0.113.9', hours: 5 })).toBeNull()
    expect(parseBlockRequest({ ip: 'example.com', hours: 1 })).toBeNull()
    expect(parseBlockRequest({ ip: '203.0.113.9', key: 'a'.repeat(24), hours: 1 })).toBeNull()
    expect(parseBlockRequest(null)).toBeNull()
  })
})

/** A GuardDO stand-in around a real GuardStore */
async function fakeGuard() {
  const store = await GuardStore.load(memoryStorage())
  const calls: string[] = []
  const deps: GuardDeps = {
    create: async (key) => {
      calls.push(`create:${key}`)
      return store.create(key, Date.now())
    },
    limit: async (kind, key) => {
      calls.push(`${kind}:${key}`)
      return store.limit(kind, key, Date.now())
    },
    note: async (key, kind) => {
      calls.push(`note:${kind}`)
      await store.note(key, kind, Date.now())
    },
    blocked: async () => {
      calls.push('blocked')
      return store.blocked(Date.now())
    },
    block: (key, hours, note) => store.block(key, hours, note, Date.now()),
    unblock: (key) => store.unblock(key, Date.now()),
    summary: async () => store.summary(Date.now()),
  }
  const namespace = { idFromName: (name: string) => name, get: () => deps }
  return { store, deps, calls, namespace: namespace as unknown as Env['GUARD'] }
}

function fakeRooms() {
  const created: string[] = []
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      create: async (id: string) => {
        created.push(id)
        return id === name
      },
      summary: async () => ({ id: name, createdAt: 1, memberCount: 0 }),
      fetch: async () => new Response('upgraded'),
    }),
  }
  return { created, namespace: namespace as unknown as Env['ROOM'] }
}

function fakeTelemetry() {
  const recorded: { client: string; events: ClientEvent[] }[] = []
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      record: async (client: string, events: ClientEvent[]) => {
        recorded.push({ client, events })
        return events
      },
    }),
  }
  return { recorded, namespace: namespace as unknown as Env['TELEMETRY'] }
}

const IP = '198.51.100.7'
const fromIp = (path: string, init: RequestInit = {}, ip = IP) =>
  new Request(`https://x${path}`, {
    ...init,
    headers: { 'CF-Connecting-IP': ip, ...(init.headers as Record<string, string>) },
  })

describe('POST /api/rooms abuse protection', () => {
  let guard: Awaited<ReturnType<typeof fakeGuard>>
  let rooms: ReturnType<typeof fakeRooms>
  let env: Env
  beforeEach(async () => {
    resetAbuseState()
    vi.unstubAllGlobals()
    guard = await fakeGuard()
    rooms = fakeRooms()
    env = {
      ASSETS: { fetch: async () => new Response('<html>') } as unknown as Fetcher,
      ROOM: rooms.namespace,
      USAGE: {} as Env['USAGE'],
      TELEMETRY: fakeTelemetry().namespace,
      GUARD: guard.namespace,
      FILE_LEDGER: undefined as never,
    }
  })

  it('counts creations per network and answers 429 with Retry-After past the limit', async () => {
    const [short] = ROOM_CREATE_LIMITS
    for (let i = 0; i < short.count; i++) {
      expect((await handleRequest(fromIp('/api/rooms', { method: 'POST' }), env)).status).toBe(201)
    }
    const res = await handleRequest(fromIp('/api/rooms', { method: 'POST' }), env)
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: string; retryAfter: number }
    expect(body.error).toBe('rate_limited')
    expect(body.retryAfter).toBeGreaterThan(0)
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfter))
    // Another network is not affected
    const other = await handleRequest(fromIp('/api/rooms', { method: 'POST' }, '203.0.113.1'), env)
    expect(other.status).toBe(201)
  })

  it('does not limit requests without a client address (local development)', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await handleRequest(new Request('https://x/api/rooms', { method: 'POST' }), env)
      expect(res.status).toBe(201)
    }
    expect(guard.calls).toEqual([])
  })

  it('lets rooms through when GuardDO cannot be reached', async () => {
    guard.deps.create = async () => {
      throw new Error('down')
    }
    guard.deps.blocked = async () => {
      throw new Error('down')
    }
    const res = await handleRequest(fromIp('/api/rooms', { method: 'POST' }), env)
    expect(res.status).toBe(201)
  })

  it('answers 403 blocked to a blocked network on creation, lookup and socket', async () => {
    const key = (await clientKeyOf(IP, env))!
    await guard.store.block(key, 1, '', Date.now())
    for (const request of [
      fromIp('/api/rooms', { method: 'POST' }),
      fromIp('/api/rooms/abcdefghij'),
      fromIp('/api/rooms/abcdefghij/ws', { headers: { Upgrade: 'websocket' } }),
    ]) {
      const res = await handleRequest(request, env)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'blocked' })
    }
    expect(rooms.created).toEqual([])
    // The list is read once per BLOCKLIST_CACHE_MS, not per request
    expect(guard.calls.filter((call) => call === 'blocked')).toHaveLength(1)
  })

  it('limits lookups and upgrades per isolate', async () => {
    for (let i = 0; i < ISOLATE_ROOM_RATE.count; i++) {
      expect((await handleRequest(fromIp('/api/rooms/abcdefghij'), env)).status).toBe(200)
    }
    const res = await handleRequest(fromIp('/api/rooms/abcdefghij'), env)
    expect(res.status).toBe(429)
  })

  describe('with Turnstile', () => {
    beforeEach(() => {
      env.TURNSTILE_SITE_KEY = '1x00000000000000000000BB'
      env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA'
    })

    it('asks for a token, with the site key, before counting anything', async () => {
      const res = await handleRequest(fromIp('/api/rooms', { method: 'POST' }), env)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: 'turnstile_required',
        siteKey: '1x00000000000000000000BB',
      })
      expect(guard.calls.filter((call) => call.startsWith('create'))).toEqual([])
    })

    it('checks the token with siteverify (secret, token, address) and creates the room', async () => {
      const siteverify = vi.fn(async (_url: string, init: RequestInit) => {
        const form = init.body as FormData
        return Response.json({
          success: form.get('response') === 'good' && form.get('secret') === env.TURNSTILE_SECRET_KEY,
        })
      })
      vi.stubGlobal('fetch', siteverify)
      const ok = await handleRequest(
        fromIp('/api/rooms', { method: 'POST', headers: { [TURNSTILE_HEADER]: 'good' } }),
        env,
      )
      expect(ok.status).toBe(201)
      expect(siteverify.mock.calls[0][0]).toBe(SITEVERIFY_URL)
      expect((siteverify.mock.calls[0][1].body as FormData).get('remoteip')).toBe(IP)
      const bad = await handleRequest(
        fromIp('/api/rooms', { method: 'POST', headers: { [TURNSTILE_HEADER]: 'bad' } }),
        env,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      )
      expect(bad.status).toBe(403)
      expect(await bad.json()).toEqual({ error: 'turnstile_failed' })
    })

    it('is off unless both keys are set', () => {
      expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: 'x' })).toBeNull()
      expect(turnstileSiteKey({ TURNSTILE_SECRET_KEY: 'y' })).toBeNull()
      expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: 'x', TURNSTILE_SECRET_KEY: 'y' })).toBe('x')
    })

    it('fails closed when siteverify cannot be reached or the token is absurd', async () => {
      const down = async () => {
        throw new Error('offline')
      }
      expect(await verifyTurnstile(env, 'token', null, down as typeof fetch)).toBe(false)
      expect(await verifyTurnstile(env, 'x'.repeat(5000), null)).toBe(false)
      expect(await verifyTurnstile({}, 'token', null)).toBe(false)
    })
  })
})

describe('/api/admin/blocks', () => {
  let guard: Awaited<ReturnType<typeof fakeGuard>>
  let env: Env
  const auth = { Authorization: 'Bearer owner-secret' }
  beforeEach(async () => {
    resetAbuseState()
    guard = await fakeGuard()
    env = {
      ASSETS: { fetch: async () => new Response('<html>') } as unknown as Fetcher,
      ROOM: fakeRooms().namespace,
      USAGE: {} as Env['USAGE'],
      TELEMETRY: fakeTelemetry().namespace,
      GUARD: guard.namespace,
      FILE_LEDGER: undefined as never,
      ADMIN_TOKEN: 'owner-secret',
    }
  })

  const post = (body: unknown, headers: Record<string, string> = auth) =>
    handleRequest(
      new Request(`https://x${ADMIN_BLOCKS_PATH}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    )

  it('needs the admin password', async () => {
    expect((await post({ ip: IP, hours: 1 }, {})).status).toBe(401)
    expect((await post({ ip: IP, hours: 1 }, { Authorization: 'Bearer nope' })).status).toBe(401)
    env.ADMIN_TOKEN = undefined
    expect((await post({ ip: IP, hours: 1 })).status).toBe(503)
  })

  it('blocks an address by its hash only, and it takes effect at once', async () => {
    const res = await post({ ip: IP, hours: 24, note: 'spam' })
    expect(res.status).toBe(201)
    const entry = (await res.json()) as { key: string; note: string }
    expect(entry.key).toBe(await clientKeyOf(IP, env))
    expect(entry.note).toBe('spam')
    expect(JSON.stringify(guard.store.summary(Date.now()))).not.toContain(IP)
    const blocked = await handleRequest(fromIp('/api/rooms', { method: 'POST' }), env)
    expect(blocked.status).toBe(403)

    const del = await handleRequest(
      new Request(`https://x${ADMIN_BLOCKS_PATH}/${entry.key}`, { method: 'DELETE', headers: auth }),
      env,
    )
    expect(del.status).toBe(200)
    expect((await handleRequest(fromIp('/api/rooms', { method: 'POST' }), env)).status).toBe(201)
  })

  it('refuses bad bodies and unknown keys', async () => {
    expect((await post({ ip: 'nope', hours: 1 })).status).toBe(400)
    expect((await post({ ip: IP, hours: 2 })).status).toBe(400)
    const missing = await handleRequest(
      new Request(`https://x${ADMIN_BLOCKS_PATH}/${'b'.repeat(24)}`, {
        method: 'DELETE',
        headers: auth,
      }),
      env,
    )
    expect(missing.status).toBe(404)
  })

  it('lists blocks, offenders and the switches in the summary', async () => {
    await guard.store.note('c'.repeat(24), 'flood', 5)
    const res = await handleRequest(
      new Request('https://x/api/admin/summary', { headers: auth }),
      {
        ...env,
        TELEMETRY: {
          idFromName: (name: string) => name,
          get: () => ({
            summary: async () =>
              (await import('../../worker/telemetry.ts')).TelemetryLedger.prototype.summary.call(
                new (await import('../../worker/telemetry.ts')).TelemetryLedger(null),
                5,
              ),
          }),
        } as unknown as Env['TELEMETRY'],
        USAGE: {
          idFromName: (name: string) => name,
          get: () => ({ status: async () => ({ month: '2026-11', bytes: 0, state: 'normal' }) }),
        } as unknown as Env['USAGE'],
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { abuse: { offenders: unknown[]; turnstile: boolean } }
    expect(body.abuse.offenders).toHaveLength(1)
    expect(body.abuse.turnstile).toBe(false)
  })
})

describe('isBlocked', () => {
  it('keeps the last list when GuardDO fails', async () => {
    resetAbuseState()
    let fail = false
    const guard = {
      blocked: async () => {
        if (fail) throw new Error('down')
        return ['k']
      },
    } as GuardDeps
    expect(await isBlocked('k', guard, 0)).toBe(true)
    fail = true
    expect(await isBlocked('k', guard, 60_000)).toBe(true)
    expect(await isBlocked('other', guard, 120_000)).toBe(false)
  })
})

describe('CSP reports', () => {
  it('reads both report formats and keeps only hosts and keywords', () => {
    const legacy = JSON.stringify({
      'csp-report': {
        'document-uri': 'https://longtalk.example/r/AbCdEfGhJk?pwd=secret',
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'https://evil.example/x.js?token=1',
      },
    })
    const modern = JSON.stringify([
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://longtalk.example/',
          effectiveDirective: 'style-src-attr',
          blockedURL: 'inline',
        },
      },
      { type: 'deprecation', body: {} },
    ])
    expect(cspEvents(parseCspReport(legacy))).toEqual([
      {
        type: 'error',
        kind: 'error',
        name: 'CSP',
        message: 'script-src-elem blocked evil.example',
        source: '/r/<room>',
      },
    ])
    expect(parseCspReport(modern)).toEqual([
      { directive: 'style-src-attr', blocked: 'inline', document: '/' },
    ])
    expect(parseCspReport('nope')).toEqual([])
    expect(blockedSource('data:image/png;base64,xx')).toBe('data')
    expect(blockedSource('eval')).toBe('eval')
  })

  it('records them as client errors under the telemetry rate limit, and answers 204', async () => {
    const telemetry = fakeTelemetry()
    const env = {
      ASSETS: {} as Fetcher,
      ROOM: {} as Env['ROOM'],
      USAGE: {} as Env['USAGE'],
      TELEMETRY: telemetry.namespace,
      GUARD: {} as Env['GUARD'],
      FILE_LEDGER: undefined as never,
    } satisfies Env
    const res = await handleRequest(
      fromIp('/api/csp-report', {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report' },
        body: JSON.stringify({
          'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'https://a.example/i' },
        }),
      }),
      env,
    )
    expect(res.status).toBe(204)
    expect(telemetry.recorded).toHaveLength(1)
    expect(telemetry.recorded[0].client).not.toContain(IP)
    expect(telemetry.recorded[0].events[0]).toMatchObject({ name: 'CSP', message: 'img-src blocked a.example' })
  })
})

describe('security headers', () => {
  it('the policy is strict where it matters', () => {
    const csp = PAGE_HEADERS['Content-Security-Policy']
    const script = csp.split('; ').find((d) => d.startsWith('script-src '))!
    expect(script).not.toContain("'unsafe-inline'")
    expect(script).not.toContain("'unsafe-eval'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(PAGE_HEADERS['Permissions-Policy']).toContain('camera=(self)')
    expect(PAGE_HEADERS['Permissions-Policy']).toContain('geolocation=()')
  })

  it('every API answer carries API_HEADERS; a WebSocket upgrade is passed through', async () => {
    const res = await handleRequest(new Request('https://x/api/nope'), {
      ASSETS: {} as Fetcher,
    } as Env)
    for (const [name, value] of Object.entries(API_HEADERS)) {
      expect(res.headers.get(name)).toBe(value)
    }
    const upgrade = { status: 101, webSocket: {}, headers: new Headers() } as unknown as Response
    expect(withApiHeaders(upgrade)).toBe(upgrade)
  })

})

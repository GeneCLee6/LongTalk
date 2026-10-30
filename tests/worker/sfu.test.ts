import { describe, expect, it, vi } from 'vitest'
import { handleRequest, type Env } from '../../worker/app.ts'
import { handleSfu, REALTIME_API_BASE, type SfuEnv } from '../../worker/sfu.ts'

const configured: SfuEnv = { REALTIME_APP_ID: 'app1', REALTIME_APP_SECRET: 's3cret' }

function upstream(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  )
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://x${path}`, {
    method,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('SFU proxy', () => {
  it('creates a session with the App Secret, which never appears in the response', async () => {
    const fetchMock = upstream({ sessionId: 'sess1' }, 201)
    const res = await handleSfu(req('POST', '/api/sfu/sessions'), configured, fetchMock)
    expect(res.status).toBe(201)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ sessionId: 'sess1' })
    expect(text).not.toContain('s3cret')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${REALTIME_API_BASE}/apps/app1/sessions/new`)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer s3cret')
  })

  it.each([
    ['POST', '/tracks', 'POST', '/sessions/sess1/tracks/new'],
    ['PUT', '/tracks/update', 'PUT', '/sessions/sess1/tracks/update'],
    ['PUT', '/tracks/close', 'PUT', '/sessions/sess1/tracks/close'],
    ['PUT', '/renegotiate', 'PUT', '/sessions/sess1/renegotiate'],
  ])('forwards %s %s with its JSON body', async (method, suffix, upMethod, upPath) => {
    const fetchMock = upstream({ tracks: [] })
    const body = { tracks: [{ location: 'remote', sessionId: 'pub', trackName: 'cam' }] }
    const res = await handleSfu(
      req(method, `/api/sfu/sessions/sess1${suffix}`, body),
      configured,
      fetchMock,
    )
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${REALTIME_API_BASE}/apps/app1${upPath}`)
    expect(init?.method).toBe(upMethod)
    expect(JSON.parse(String(init?.body))).toEqual(body)
  })

  it('reads a session without a body', async () => {
    const fetchMock = upstream({ tracks: [] })
    await handleSfu(req('GET', '/api/sfu/sessions/sess1'), configured, fetchMock)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${REALTIME_API_BASE}/apps/app1/sessions/sess1`)
    expect(init?.body).toBeUndefined()
  })

  it('passes Realtime errors through with their status', async () => {
    const fetchMock = upstream({ errorCode: 'session_error', errorDescription: 'nope' }, 400)
    const res = await handleSfu(
      req('POST', '/api/sfu/sessions/sess1/tracks', { tracks: [] }),
      configured,
      fetchMock,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ errorCode: 'session_error', errorDescription: 'nope' })
  })

  it('answers 503 when the Realtime app is not configured', async () => {
    const fetchMock = upstream({})
    const res = await handleSfu(req('POST', '/api/sfu/sessions'), {}, fetchMock)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'sfu_not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', '/api/sfu/sessions'],
    ['DELETE', '/api/sfu/sessions/sess1'],
    ['POST', '/api/sfu/sessions/sess1/datachannels/new'],
    ['GET', '/api/sfu/apps'],
  ])('refuses %s %s, which is not on the allow-list', async (method, path) => {
    const fetchMock = upstream({})
    const res = await handleSfu(req(method, path), configured, fetchMock)
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects malformed session ids and bodies before calling Realtime', async () => {
    const fetchMock = upstream({})
    const badId = await handleSfu(req('GET', '/api/sfu/sessions/a%2F..%2Fb'), configured, fetchMock)
    expect(badId.status).toBe(400)
    const notJson = await handleSfu(
      req('PUT', '/api/sfu/sessions/s/renegotiate', 'sdp'),
      configured,
      fetchMock,
    )
    expect(notJson.status).toBe(400)
    const array = await handleSfu(
      req('PUT', '/api/sfu/sessions/s/renegotiate', []),
      configured,
      fetchMock,
    )
    expect(array.status).toBe(400)
    const huge = { sdp: 'x'.repeat(70_000) }
    const tooBig = await handleSfu(
      req('PUT', '/api/sfu/sessions/s/renegotiate', huge),
      configured,
      fetchMock,
    )
    expect(tooBig.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 502 when Realtime is unreachable or answers non-JSON', async () => {
    const down = vi.fn(async () => {
      throw new Error('network')
    })
    expect((await handleSfu(req('POST', '/api/sfu/sessions'), configured, down)).status).toBe(502)
    const html = vi.fn(async () => new Response('<html>', { status: 500 }))
    expect((await handleSfu(req('POST', '/api/sfu/sessions'), configured, html)).status).toBe(502)
  })

  it('is reachable through the Worker router', async () => {
    const env = {
      ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
      ROOM: {} as Env['ROOM'],
    } satisfies Env
    const res = await handleRequest(req('POST', '/api/sfu/sessions'), env)
    expect(res.status).toBe(503)
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })
})

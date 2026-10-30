import { describe, expect, it, vi } from 'vitest'
import { handleRequest, type Env } from '../../worker/app.ts'

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response('<html>')) } as unknown as Fetcher,
    ROOM: {} as DurableObjectNamespace,
    ...overrides,
  }
}

describe('worker', () => {
  it('answers the health check with the deployed version', async () => {
    const res = await handleRequest(new Request('https://x/api/health'), env({ APP_VERSION: 'abc123' }))
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

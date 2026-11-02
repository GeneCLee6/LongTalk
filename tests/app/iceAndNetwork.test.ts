import { describe, expect, it, vi } from 'vitest'
import { TURN_REFRESH_FRACTION } from '../../shared/turn.ts'
import { fetchIceConfig } from '../../src/api/turn.ts'
import { Backoff } from '../../src/room/backoff.ts'
import { watchNetwork } from '../../src/room/network.ts'

const TOKEN = 'T'.repeat(43)
const turnServer = { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }

const answer = (body: unknown, status = 200) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json(body, { status }),
  )

describe('fetchIceConfig (e2-t07)', () => {
  it('asks the Worker with the session token and refreshes before the TTL runs out', async () => {
    const fetcher = answer({ iceServers: [turnServer], turn: true, ttlSeconds: 3600 })
    const config = await fetchIceConfig('abcdefghij', TOKEN, false, fetcher)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/api/turn/abcdefghij')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(config).toEqual({
      connect: { iceServers: [turnServer], iceTransportPolicy: 'all' },
      refreshAfterMs: 3600 * 1000 * TURN_REFRESH_FRACTION,
    })
  })

  it('forces the relay only when asked and TURN is there', async () => {
    const withTurn = answer({ iceServers: [turnServer], turn: true, ttlSeconds: 60 })
    expect((await fetchIceConfig('abcdefghij', TOKEN, true, withTurn))?.connect).toMatchObject({
      iceTransportPolicy: 'relay',
    })
    // STUN only: forcing the relay would leave no path at all
    const stunOnly = answer({
      iceServers: [{ urls: 'stun:x:3478' }],
      turn: false,
      ttlSeconds: null,
    })
    expect(await fetchIceConfig('abcdefghij', TOKEN, true, stunOnly)).toEqual({
      connect: { iceServers: [{ urls: ['stun:x:3478'] }], iceTransportPolicy: 'all' },
      refreshAfterMs: null,
    })
  })

  it('gives nothing without a token or when the Worker refuses', async () => {
    const fetcher = answer({ error: 'unauthorized' }, 401)
    expect(await fetchIceConfig('abcdefghij', null, false, fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await fetchIceConfig('abcdefghij', TOKEN, false, fetcher)).toBeNull()
    expect(await fetchIceConfig('abcdefghij', TOKEN, false, answer({ iceServers: [] }))).toBeNull()
  })
})

describe('watchNetwork (e2-t08)', () => {
  it('passes on online, offline and the page becoming visible, until unwatched', () => {
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'hidden' as DocumentVisibilityState,
    })
    const handlers = { online: vi.fn(), offline: vi.fn(), visible: vi.fn() }
    const unwatch = watchNetwork(handlers, { window: win, document: doc })
    win.dispatchEvent(new Event('offline'))
    win.dispatchEvent(new Event('online'))
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(handlers.visible).not.toHaveBeenCalled()
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(handlers.online).toHaveBeenCalledOnce()
    expect(handlers.offline).toHaveBeenCalledOnce()
    expect(handlers.visible).toHaveBeenCalledOnce()
    unwatch()
    win.dispatchEvent(new Event('online'))
    expect(handlers.online).toHaveBeenCalledOnce()
  })
})

describe('Backoff (e2-t08)', () => {
  it('doubles up to the cap and gives up after the bound', () => {
    let now = 0
    const backoff = new Backoff({ random: () => 0.5, giveUpAfterMs: 20_000, now: () => now })
    const delays: (number | null)[] = []
    for (let i = 0; i < 6; i++) {
      const delay = backoff.next()
      delays.push(delay)
      now += delay ?? 0
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, null])
    backoff.reset()
    expect(backoff.next()).toBe(1000)
    backoff.restart()
    expect(backoff.attempts).toBe(0)
  })
})

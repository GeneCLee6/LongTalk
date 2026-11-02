import { describe, expect, it, vi } from 'vitest'
import {
  ADMIN_SUMMARY_PATH,
  ERROR_ALERT_PER_HOUR,
  EVENTS_PATH,
  MAX_EVENTS_BODY_BYTES,
  MAX_EVENTS_PER_BATCH,
  parseEvent,
  parseEventBatch,
  scrubErrorText,
  type ClientEvent,
} from '../../shared/telemetry.ts'
import { handleAdmin, handleEvents, sameSecret, type TelemetryDeps } from '../../worker/events.ts'
import {
  EVENT_RATE,
  EventRateLimit,
  MAX_ERROR_SAMPLES,
  TELEMETRY_DAYS,
  TelemetryLedger,
} from '../../worker/telemetry.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 2, 12, 30)

const error = (message = 'x is undefined'): ClientEvent => ({
  type: 'error',
  kind: 'error',
  name: 'TypeError',
  message,
  source: 'room.js:1:2',
})

describe('event validation (e11-t03)', () => {
  it('accepts every kind it knows, normalized', () => {
    expect(parseEvent({ type: 'join', ok: true, extra: 'dropped' })).toEqual({
      type: 'join',
      ok: true,
    })
    expect(parseEvent({ type: 'join', ok: false, reason: 'full' })).toEqual({
      type: 'join',
      ok: false,
      reason: 'full',
    })
    expect(parseEvent({ type: 'reconnect', layer: 'media' })).toEqual({
      type: 'reconnect',
      layer: 'media',
    })
    expect(parseEvent({ type: 'rebuild' })).toEqual({ type: 'rebuild' })
    expect(parseEvent({ type: 'media', relay: true })).toEqual({ type: 'media', relay: true })
    expect(parseEvent({ ...error(), type: 'error' })).toEqual(error())
  })

  it('refuses unknown kinds and bad fields', () => {
    expect(parseEvent({ type: 'join', ok: false, reason: 'because' })).toBeNull()
    expect(parseEvent({ type: 'reconnect', layer: 'wifi' })).toBeNull()
    expect(parseEvent({ type: 'media', relay: 'yes' })).toBeNull()
    expect(
      parseEvent({ type: 'error', kind: 'panic', name: '', message: '', source: '' }),
    ).toBeNull()
    // D4's rating is not known yet: dropped, not an error (browsers may be deployed first)
    expect(parseEvent({ type: 'rating', score: 5 })).toBeNull()
    expect(parseEvent(null)).toBeNull()
    expect(parseEvent([])).toBeNull()
  })

  it('takes a batch of 1–20, dropping what it does not understand one by one', () => {
    const batch = (events: unknown[]) => JSON.stringify({ events })
    expect(parseEventBatch(batch([{ type: 'rebuild' }, { type: 'rating', score: 5 }]))).toEqual([
      { type: 'rebuild' },
    ])
    expect(parseEventBatch(batch([]))).toBeNull()
    expect(parseEventBatch(batch([{ type: 'rating' }]))).toBeNull()
    expect(
      parseEventBatch(batch(Array(MAX_EVENTS_PER_BATCH + 1).fill({ type: 'rebuild' }))),
    ).toBeNull()
    expect(parseEventBatch('not json')).toBeNull()
    expect(parseEventBatch('[]')).toBeNull()
  })

  it('scrubs what could identify someone from an error, on the server too', () => {
    expect(
      scrubErrorText(
        'Failed https://longtalk.example/r/k7pq2x9m4a?x=1 for gene@example.com id 12345678',
      ),
    ).toBe('Failed <url> for <email> id <n>')
    expect(scrubErrorText('at /r/k7pq2x9m4a')).toBe('at /r/<room>')
    expect(scrubErrorText('x'.repeat(500))).toHaveLength(160)
    const parsed = parseEvent({ ...error('see https://evil.example/a'), type: 'error' })
    expect(parsed).toMatchObject({ message: 'see <url>' })
  })
})

describe('TelemetryLedger', () => {
  it('counts by hour and day and sums the last 24 hours and 7 days', () => {
    const ledger = new TelemetryLedger(null)
    ledger.add(
      [
        { type: 'join', ok: true },
        { type: 'join', ok: false, reason: 'lost' },
      ],
      NOW - 3 * DAY,
    )
    ledger.add(
      [
        { type: 'join', ok: true },
        { type: 'reconnect', layer: 'socket' },
        { type: 'reconnect', layer: 'media' },
        { type: 'rebuild' },
        { type: 'media', relay: true },
        { type: 'media', relay: false },
        error(),
      ],
      NOW,
    )
    const summary = ledger.summary(NOW)
    expect(summary.last24h).toEqual({
      joinOk: 1,
      joinFail: {},
      reconnect: { socket: 1, media: 1 },
      rebuild: 1,
      media: 2,
      relayed: 1,
      errors: 1,
    })
    expect(summary.last7d).toMatchObject({ joinOk: 2, joinFail: { lost: 1 } })
    expect(summary.days.map((d) => d.day)).toEqual(['2026-11-02', '2026-10-30'])
  })

  it(`forgets days after ${TELEMETRY_DAYS} days and survives being stored`, () => {
    const ledger = new TelemetryLedger(null)
    ledger.add([{ type: 'rebuild' }], NOW - TELEMETRY_DAYS * DAY)
    ledger.add([{ type: 'rebuild' }], NOW)
    const stored = structuredClone(ledger.record)
    expect(Object.keys(stored.days)).toEqual(['2026-11-02'])
    expect(new TelemetryLedger(stored).summary(NOW).last24h.rebuild).toBe(1)
  })

  it('keeps one sample per distinct error, newest first, with a count', () => {
    const ledger = new TelemetryLedger(null)
    ledger.add([error('a'), error('b'), error('a')], NOW)
    const { recentErrors } = ledger.summary(NOW)
    expect(recentErrors.map((e) => [e.message, e.count])).toEqual([
      ['a', 2],
      ['b', 1],
    ])
    for (let i = 0; i < MAX_ERROR_SAMPLES + 5; i++) ledger.add([error(`e${i}`)], NOW)
    expect(ledger.summary(NOW).recentErrors).toHaveLength(MAX_ERROR_SAMPLES)
  })

  it('raises the error alert past the threshold and the join alert past 20 % failures', () => {
    const ledger = new TelemetryLedger(null)
    ledger.add(Array(ERROR_ALERT_PER_HOUR - 1).fill(error()), NOW - HOUR)
    expect(ledger.summary(NOW).alerts).toEqual([])
    ledger.add([error()], NOW)
    expect(ledger.summary(NOW).alerts).toEqual(['errors'])
    // Two hours later the errors are old news
    expect(ledger.summary(NOW + 2 * HOUR).alerts).toEqual([])

    const joins = new TelemetryLedger(null)
    joins.add(Array(8).fill({ type: 'join', ok: true }), NOW)
    joins.add(Array(2).fill({ type: 'join', ok: false, reason: 'lost' }), NOW)
    expect(joins.summary(NOW).alerts).toEqual(['joinFailures'])
    joins.add([{ type: 'join', ok: true }], NOW)
    expect(joins.summary(NOW).alerts).toEqual([])
  })
})

describe('EventRateLimit', () => {
  it(`takes ${EVENT_RATE.events} events (${EVENT_RATE.errors} errors) per client per window`, () => {
    const limit = new EventRateLimit()
    const many = Array<ClientEvent>(EVENT_RATE.events + 5).fill({ type: 'rebuild' })
    expect(limit.take('a', many, 0)).toHaveLength(EVENT_RATE.events)
    expect(limit.take('a', [{ type: 'rebuild' }], 1)).toEqual([])
    expect(limit.take('b', [{ type: 'rebuild' }], 1)).toHaveLength(1)
    expect(limit.take('a', [{ type: 'rebuild' }], EVENT_RATE.windowMs)).toHaveLength(1)

    const errors = Array<ClientEvent>(EVENT_RATE.errors + 3).fill(error())
    const taken = limit.take('c', [...errors, { type: 'rebuild' }], 0)
    expect(taken.filter((e) => e.type === 'error')).toHaveLength(EVENT_RATE.errors)
    expect(taken.at(-1)).toEqual({ type: 'rebuild' })
  })
})

function deps(overrides: Partial<TelemetryDeps> = {}) {
  const recorded: { client: string; events: ClientEvent[] }[] = []
  const all: TelemetryDeps = {
    record: async (client, events) => {
      recorded.push({ client, events })
      return events
    },
    summary: async () => new TelemetryLedger(null).summary(NOW),
    usage: async () => ({ month: '2026-11', bytes: 5, state: 'normal' }),
    ...overrides,
  }
  return { deps: all, recorded }
}

const SITE = 'https://lt.example'
const eventsUrl = new URL(SITE + EVENTS_PATH)

function postEvents(body: string, headers: Record<string, string> = {}) {
  return new Request(eventsUrl, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers },
  })
}

describe('POST /api/events', () => {
  const body = JSON.stringify({
    events: [
      { type: 'join', ok: true },
      { type: 'media', relay: true },
    ],
  })

  it('records valid events under a hash of the IP and writes them to Analytics Engine', async () => {
    const { deps: d, recorded } = deps()
    const writeDataPoint = vi.fn()
    const res = await handleEvents(
      postEvents(body, { Origin: SITE }),
      { EVENTS: { writeDataPoint } as unknown as AnalyticsEngineDataset, APP_VERSION: 'abc' },
      eventsUrl,
      d,
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: 2 })
    expect(recorded).toHaveLength(1)
    expect(recorded[0].client).toMatch(/^[0-9a-f]{24}$/)
    expect(recorded[0].client).not.toContain('203')
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['join'],
      blobs: ['join', 'ok', '', '', '', 'abc'],
      doubles: [1],
    })
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['media'],
      blobs: ['media', 'relay', '', '', '', 'abc'],
      doubles: [1],
    })
  })

  it('works without the Analytics Engine binding', async () => {
    const res = await handleEvents(postEvents(body), {}, eventsUrl, deps().deps)
    expect(res.status).toBe(202)
  })

  it('refuses other methods, other sites, large bodies and garbage', async () => {
    const d = deps().deps
    expect((await handleEvents(new Request(eventsUrl), {}, eventsUrl, d)).status).toBe(405)
    expect(
      (await handleEvents(postEvents(body, { Origin: 'https://evil.example' }), {}, eventsUrl, d))
        .status,
    ).toBe(403)
    const big = JSON.stringify({
      events: [{ type: 'rebuild', pad: 'x'.repeat(MAX_EVENTS_BODY_BYTES) }],
    })
    expect((await handleEvents(postEvents(big), {}, eventsUrl, d)).status).toBe(413)
    expect((await handleEvents(postEvents('{"events":5}'), {}, eventsUrl, d)).status).toBe(400)
  })

  it('answers 429 when the rate limit took nothing', async () => {
    const { deps: d } = deps({ record: async () => [] })
    expect((await handleEvents(postEvents(body), {}, eventsUrl, d)).status).toBe(429)
  })
})

describe('GET /api/admin/summary', () => {
  const adminUrl = new URL(SITE + ADMIN_SUMMARY_PATH)
  const get = (headers: Record<string, string> = {}) => new Request(adminUrl, { headers })
  const TOKEN = 'test-admin-token-not-a-real-secret'

  it('is closed while ADMIN_TOKEN is not set', async () => {
    const res = await handleAdmin(
      get({ Authorization: 'Bearer anything' }),
      {},
      adminUrl,
      deps().deps,
    )
    expect(res.status).toBe(503)
  })

  it('refuses a missing or wrong token, and a token in the query string', async () => {
    const env = { ADMIN_TOKEN: TOKEN }
    const d = deps().deps
    expect((await handleAdmin(get(), env, adminUrl, d)).status).toBe(401)
    expect(
      (await handleAdmin(get({ Authorization: 'Bearer nope' }), env, adminUrl, d)).status,
    ).toBe(401)
    expect((await handleAdmin(get({ Authorization: TOKEN }), env, adminUrl, d)).status).toBe(401)
    const query = new URL(`${adminUrl}?token=${TOKEN}`)
    expect((await handleAdmin(new Request(query), env, query, d)).status).toBe(401)
  })

  it('answers the summary, the month’s usage and whether Analytics Engine is on', async () => {
    const res = await handleAdmin(
      get({ Authorization: `Bearer ${TOKEN}` }),
      { ADMIN_TOKEN: TOKEN },
      adminUrl,
      deps().deps,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({
      telemetry: { alerts: [], last24h: { joinOk: 0 } },
      usage: { month: '2026-11', state: 'normal' },
      analyticsEngine: false,
    })
  })

  it('still answers when the usage object is unreachable', async () => {
    const { deps: d } = deps({ usage: async () => Promise.reject(new Error('down')) })
    const res = await handleAdmin(
      get({ Authorization: `Bearer ${TOKEN}` }),
      { ADMIN_TOKEN: TOKEN },
      adminUrl,
      d,
    )
    expect(await res.json()).toMatchObject({ usage: null })
  })

  it('compares secrets without short-circuiting on length', async () => {
    expect(await sameSecret(TOKEN, TOKEN)).toBe(true)
    expect(await sameSecret(TOKEN.slice(0, -1), TOKEN)).toBe(false)
    expect(await sameSecret('', TOKEN)).toBe(false)
  })
})

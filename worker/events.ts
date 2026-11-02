import {
  ADMIN_SUMMARY_PATH,
  MAX_EVENTS_BODY_BYTES,
  parseEventBatch,
  type AdminSummary,
  type ClientEvent,
  type TelemetrySummary,
} from '../shared/telemetry.ts'
import type { UsageStatus } from '../shared/usage.ts'

// POST /api/events and GET /api/admin/summary (e11-t03). What may be reported and the privacy
// rules: shared/telemetry.ts. The counting: TelemetryDO / TelemetryLedger.

/** The one TelemetryDO, by name */
export const TELEMETRY_OBJECT = 'telemetry'

export interface TelemetryEnv {
  /** Workers Analytics Engine dataset (wrangler.jsonc `analytics_engine_datasets`); optional */
  EVENTS?: AnalyticsEngineDataset
  /** The owner's /admin password (a Worker secret, DEPLOY.md §8); /admin is closed without it */
  ADMIN_TOKEN?: string
  APP_VERSION?: string
}

export interface TelemetryDeps {
  record: (client: string, events: ClientEvent[]) => Promise<ClientEvent[]>
  summary: () => Promise<TelemetrySummary>
  usage: () => Promise<UsageStatus>
}

const noStore = { 'cache-control': 'no-store' }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...noStore, ...headers } })

/**
 * POST /api/events: `{ events: [...] }` from the browser (shared/telemetry.ts). Same-site only
 * (a page elsewhere must not report for our visitors), at most MAX_EVENTS_BODY_BYTES, and rate
 * limited per client by TelemetryDO; the client is a hash of its IP, never the IP itself. Every
 * accepted event also goes to Analytics Engine when the EVENTS binding exists.
 */
export async function handleEvents(
  request: Request,
  env: TelemetryEnv,
  url: URL,
  deps: TelemetryDeps,
): Promise<Response> {
  if (request.method !== 'POST')
    return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== url.origin) return json({ error: 'forbidden_origin' }, 403)
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_EVENTS_BODY_BYTES) return json({ error: 'too_large' }, 413)
  const body = await request.text()
  if (new TextEncoder().encode(body).length > MAX_EVENTS_BODY_BYTES) {
    return json({ error: 'too_large' }, 413)
  }
  const events = parseEventBatch(body)
  if (!events) return json({ error: 'bad_request' }, 400)
  const client = await clientKey(request.headers.get('cf-connecting-ip') ?? 'unknown')
  const accepted = await deps.record(client, events)
  if (accepted.length === 0) return json({ error: 'rate_limited' }, 429)
  writeAnalytics(env, accepted)
  return json({ accepted: accepted.length }, 202)
}

/**
 * One Analytics Engine data point per event (DEPLOY.md §8 has the SQL): index1 and blob1 the
 * event type; blob2 its detail (join: `ok` or the failure reason; reconnect: the layer; media:
 * `relay` or `direct`; error: `error` or `rejection`); blob3–5 an error's name, message, source;
 * blob6 the app version; double1 = 1.
 */
function writeAnalytics(env: TelemetryEnv, events: readonly ClientEvent[]): void {
  if (!env.EVENTS) return
  for (const event of events) {
    const blobs: string[] = [event.type, detail(event), '', '', '', env.APP_VERSION ?? 'local']
    if (event.type === 'error') {
      blobs[2] = event.name
      blobs[3] = event.message
      blobs[4] = event.source
    }
    try {
      env.EVENTS.writeDataPoint({ indexes: [event.type], blobs, doubles: [1] })
    } catch (error) {
      // Analytics is a nice-to-have: the counters in TelemetryDO already have the event
      console.error('analytics engine write failed', error)
    }
  }
}

function detail(event: ClientEvent): string {
  switch (event.type) {
    case 'join':
      return event.ok ? 'ok' : event.reason
    case 'reconnect':
      return event.layer
    case 'rebuild':
      return ''
    case 'media':
      return event.relay ? 'relay' : 'direct'
    case 'error':
      return event.kind
  }
}

/** A short hash of the client's IP: enough to rate-limit, not to recover the address */
async function clientKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`events:${ip}`))
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Whether `given` is the secret, in constant time: both are hashed first (so the lengths match
 * and nothing about the secret's length leaks), then compared with the runtime's timingSafeEqual
 * or, outside Workers (tests), an XOR over every byte.
 */
export async function sameSecret(given: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ])
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean
  }
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(a, b)
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let difference = 0
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i]
  return difference === 0
}

/**
 * GET /api/admin/summary: the owner's dashboard data. The password is the Worker secret
 * ADMIN_TOKEN, sent as `Authorization: Bearer <token>` (never in the URL, which logs and history
 * keep); 503 while the secret is not set, 401 for anything else.
 */
export async function handleAdmin(
  request: Request,
  env: TelemetryEnv,
  url: URL,
  deps: TelemetryDeps,
): Promise<Response> {
  if (url.pathname !== ADMIN_SUMMARY_PATH) return json({ error: 'not_found' }, 404)
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_not_configured' }, 503)
  const header = request.headers.get('Authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!given || !(await sameSecret(given, env.ADMIN_TOKEN))) {
    return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
  }
  const [telemetry, usage] = await Promise.all([deps.summary(), deps.usage().catch(() => null)])
  const body: AdminSummary = { telemetry, usage, analyticsEngine: env.EVENTS !== undefined }
  return json(body)
}

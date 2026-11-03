import { scrubErrorText, type ClientEvent } from '../shared/telemetry.ts'

// POST /api/csp-report (I1, e11-t06): browsers report what the Content-Security-Policy blocked
// (worker/headers.ts), either as `report-uri` (`{ "csp-report": {...} }`, Firefox and Safari) or
// through the Reporting API (`[{ type: "csp-violation", body: {...} }]`, Chromium). Each one
// becomes a client `error` event named `CSP` (so it shows under 最近的錯誤 on /admin), with the
// directive and only the blocked source's host or keyword (`inline`, `eval`…), never a full URL;
// the same per-client rate limit as /api/events applies.

/** Reports are small; a bigger body is not one */
const MAX_REPORT_BYTES = 16 * 1024
/** At most this many violations of one body are kept */
const MAX_VIOLATIONS = 5

type Violation = { directive: string; blocked: string; document: string }

/** The blocked source as a host or a keyword, without paths or query strings */
export function blockedSource(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return 'unknown'
  if (/^[a-z-]+$/i.test(raw)) return raw.toLowerCase()
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'wss:'
      ? url.host
      : url.protocol.replace(':', '')
  } catch {
    return 'unknown'
  }
}

/** The page's path without its query (a room path keeps the shape, scrubbed later) */
function documentPath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  try {
    return new URL(raw).pathname
  } catch {
    return ''
  }
}

function violation(body: Record<string, unknown>): Violation | null {
  const directive = body['effective-directive'] ?? body.effectiveDirective ?? body['violated-directive']
  if (typeof directive !== 'string') return null
  return {
    directive: directive.split(' ')[0].slice(0, 40),
    blocked: blockedSource(body['blocked-uri'] ?? body.blockedURL).slice(0, 80),
    document: documentPath(body['document-uri'] ?? body.documentURL),
  }
}

/** The violations in a report body, in either format; empty when it is not a report */
export function parseCspReport(text: string): Violation[] {
  if (text.length > MAX_REPORT_BYTES) return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  const bodies: Record<string, unknown>[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && item.type === 'csp-violation' && item.body) {
        bodies.push(item.body as Record<string, unknown>)
      }
    }
  } else if (value && typeof value === 'object' && 'csp-report' in value) {
    const report = (value as Record<string, unknown>)['csp-report']
    if (report && typeof report === 'object') bodies.push(report as Record<string, unknown>)
  }
  return bodies
    .slice(0, MAX_VIOLATIONS)
    .map(violation)
    .filter((v): v is Violation => v !== null)
}

/** The violations as telemetry error events (TelemetryDO scrubs nothing more from these) */
export function cspEvents(violations: readonly Violation[]): ClientEvent[] {
  return violations.map((v) => ({
    type: 'error',
    kind: 'error',
    name: 'CSP',
    message: `${v.directive} blocked ${v.blocked}`,
    source: scrubErrorText(v.document, 80),
  }))
}

/**
 * POST /api/csp-report: 204 whatever it held (a browser does nothing with the answer); the
 * violations go to `record` under the client's telemetry key
 */
export async function handleCspReport(
  request: Request,
  record: (client: string, events: ClientEvent[]) => Promise<unknown>,
  clientKey: (ip: string) => Promise<string>,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  if (Number(request.headers.get('content-length') ?? '0') > MAX_REPORT_BYTES) {
    return new Response(null, { status: 413 })
  }
  const events = cspEvents(parseCspReport(await request.text()))
  if (events.length > 0) {
    const client = await clientKey(request.headers.get('cf-connecting-ip') ?? 'unknown')
    await record(client, events).catch((error: unknown) => console.error('csp report', error))
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

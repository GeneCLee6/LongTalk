import { ADMIN_BLOCKS_PATH, isClientKey, parseBlockRequest } from '../shared/abuse.ts'
import { forgetBlocklist, type GuardDeps } from './abuse.ts'
import { clientKeyOf, type ClientKeyEnv } from './client-key.ts'
import { authorizeAdmin, type TelemetryEnv } from './events.ts'

// /api/admin/blocks (I1, e11-t05): the owner's IP blocklist. POST blocks an address (hashed here;
// the address itself is never stored or logged) or a key from the offenders list, for 1 hour to
// 30 days; DELETE /api/admin/blocks/<key> lifts one. Behind ADMIN_TOKEN like the dashboard.
// The list itself comes with GET /api/admin/summary (`abuse`).

const noStore = { 'cache-control': 'no-store' }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...noStore, ...headers } })

/** Block bodies are tiny; anything bigger is refused before it is read */
const MAX_BODY_BYTES = 1024

export async function handleAdminBlocks(
  request: Request,
  env: Pick<TelemetryEnv, 'ADMIN_TOKEN'> & ClientKeyEnv,
  url: URL,
  guard: GuardDeps,
): Promise<Response> {
  const refused = await authorizeAdmin(request, env)
  if (refused) return refused
  if (url.pathname === ADMIN_BLOCKS_PATH) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
    if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
      return json({ error: 'too_large' }, 413)
    }
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return json({ error: 'bad_request' }, 400)
    }
    const block = parseBlockRequest(raw)
    if (!block) return json({ error: 'bad_request' }, 400)
    const key = block.ip !== undefined ? await clientKeyOf(block.ip, env) : block.key!
    if (!key) return json({ error: 'bad_request' }, 400)
    const entry = await guard.block(key, block.hours, block.note ?? '')
    forgetBlocklist()
    return json(entry, 201)
  }
  const key = url.pathname.slice(ADMIN_BLOCKS_PATH.length + 1)
  if (!url.pathname.startsWith(`${ADMIN_BLOCKS_PATH}/`) || !isClientKey(key)) {
    return json({ error: 'not_found' }, 404)
  }
  if (request.method !== 'DELETE') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'DELETE' })
  }
  const had = await guard.unblock(key)
  forgetBlocklist()
  return had ? json({ ok: true }) : json({ error: 'not_found' }, 404)
}

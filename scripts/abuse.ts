// Abuse test against a deployment (I1, e11-t05, AC-11.5): hammers room creation and a room's
// WebSocket from this machine, within reason (a few hundred small requests, about a minute),
// and checks every limit answers as designed. CI runs it against each pull request's preview
// after the browser tests (preview.yml, job `abuse`); never point it at production, whose
// limits it would spend for this network for up to a day.
//
//   BASE_URL=https://longtalk-pr-<n>.genelee-pro.workers.dev node scripts/abuse.ts
//   (optional) ADMIN_TOKEN=<the preview's /admin password>: also blocks and unblocks this network
//
// Expects the preview's Turnstile test keys (wrangler.jsonc env.preview): a request without a
// token gets 403 turnstile_required; the public dummy token passes.
import { ROOM_CONNECT_RATE, ROOM_CREATE_LIMITS, SOCKET_MESSAGE_RATE } from '../shared/abuse.ts'
import { MAX_FILE_BYTES, filePath, filesPath } from '../shared/files.ts'
import { CloseCode, MAX_CLIENT_MESSAGE_CHARS, roomSocketPath } from '../shared/protocol.ts'

const base = process.env.BASE_URL?.replace(/\/$/, '')
if (!base) {
  console.error('Set BASE_URL to a preview deployment')
  process.exit(1)
}
if (/longtalk\.genelee-pro\.workers\.dev/.test(base)) {
  console.error('Refusing to hammer production: use a preview')
  process.exit(1)
}
const adminToken = process.env.ADMIN_TOKEN || ''
/** Cloudflare's documented dummy token, accepted by the test secret key */
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
const wsBase = base.replace(/^http/, 'ws')

const results: { check: string; ok: boolean; detail: string }[] = []
function record(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${check}: ${detail}`)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function createRoom(token: string | null): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: token ? { 'cf-turnstile-response': token } : {},
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Opens the room's socket and resolves with how it closed (or 'open' after `waitMs`) */
function socket(
  roomId: string,
  onOpen: (ws: WebSocket) => void,
  waitMs = 8_000,
): Promise<{ code: number | 'open' | 'error' }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsBase + roomSocketPath(roomId))
    let settled = false
    const done = (code: number | 'open' | 'error') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // Already closed
      }
      resolve({ code })
    }
    const timer = setTimeout(() => done('open'), waitMs)
    ws.onopen = () => onOpen(ws)
    ws.onclose = (event) => done(event.code)
    ws.onerror = () => setTimeout(() => done('error'), 200)
  })
}

const join = (ws: WebSocket, name: string) =>
  ws.send(JSON.stringify({ t: 'join', name, token: null, client: crypto.randomUUID() }))

/**
 * Files in chat (I5, AC-5.4, AC-11.5) through the real R2 binding: who may, what may, the answer's
 * headers. A tiny file, deleted with the room or the next sweep.
 */
async function uploads(roomId: string) {
  const member = new WebSocket(wsBase + roomSocketPath(roomId))
  const token = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 8_000)
    member.onopen = () => join(member, 'Uploader')
    member.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { t?: string; token?: string }
      if (message.t === 'welcome') {
        clearTimeout(timer)
        resolve(message.token ?? null)
      }
    }
  })
  if (!token) {
    record('uploads: a member to test with', false, 'no welcome')
    member.close()
    return
  }
  const auth = { authorization: `Bearer ${token}` }
  const grant = (body: object, headers: Record<string, string> = auth) =>
    fetch(`${base}${filesPath(roomId)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const file = { name: 'abuse.txt', size: 5, type: 'text/plain', thumb: false }
  record('uploads: outsiders', (await grant(file, {})).status === 401, 'POST without a token')
  const blocked = await grant({ ...file, name: 'a.exe' })
  record('uploads: blocked type', blocked.status === 415, `a.exe -> ${blocked.status}`)
  const large = await grant({ ...file, size: MAX_FILE_BYTES + 1 })
  record('uploads: too large', large.status === 413, `25 MB + 1 -> ${large.status}`)
  const granted = await grant(file)
  if (granted.status === 503) {
    record('uploads: R2 binding', false, 'answered 503: is the bucket bound?')
    member.close()
    return
  }
  const { id } = (await granted.json()) as { id: string }
  // A chunked body that runs past its grant. Cloudflare's edge may buffer it and fill in the real
  // Content-Length (then the size does not match the grant: 400) or pass it on without one (411).
  // Either way nothing is stored; the Worker's own 411 and FixedLengthStream are in the unit tests
  const chunked = (await (await grant(file)).json()) as { id: string }
  const unknownLength = await fetch(`${base}${filePath(roomId, chunked.id)}`, {
    method: 'PUT',
    headers: auth,
    body: new Blob(['more than five bytes']).stream(),
    duplex: 'half',
  } as RequestInit)
  record(
    'uploads: a chunked body past its grant',
    unknownLength.status === 411 || unknownLength.status === 400,
    `-> ${unknownLength.status}`,
  )
  const put = await fetch(`${base}${filePath(roomId, id)}`, {
    method: 'PUT',
    headers: auth,
    body: 'hello',
  })
  record('uploads: stored in R2', put.status === 201, `PUT -> ${put.status}`)
  const outsider = await fetch(`${base}${filePath(roomId, id)}`)
  record('uploads: download needs a member', outsider.status === 401, `-> ${outsider.status}`)
  const got = await fetch(`${base}${filePath(roomId, id)}`, { headers: auth })
  const text = await got.text()
  const headers = got.headers
  record(
    'uploads: download headers',
    got.status === 200 &&
      text === 'hello' &&
      headers.get('content-type') === 'application/octet-stream' &&
      (headers.get('content-disposition') ?? '').startsWith('attachment') &&
      headers.get('x-content-type-options') === 'nosniff' &&
      (headers.get('content-security-policy') ?? '').includes('sandbox'),
    `${got.status} ${headers.get('content-type')} ${headers.get('content-disposition')}`,
  )
  const page = await (await grant({ ...file, name: 'page.txt', size: 13 })).json() as { id: string }
  const sniffed = await fetch(`${base}${filePath(roomId, page.id)}`, {
    method: 'PUT',
    headers: auth,
    body: '<html></html>',
  })
  record('uploads: a page dressed as text', sniffed.status === 415, `-> ${sniffed.status}`)
  // The largest file there is, end to end: within the free plan's CPU and request limits
  const full = (await (
    await grant({ ...file, name: 'full.zip', size: MAX_FILE_BYTES, type: 'application/zip' })
  ).json()) as { id: string }
  const started = Date.now()
  const stored = await fetch(`${base}${filePath(roomId, full.id)}`, {
    method: 'PUT',
    headers: auth,
    body: new Blob([new Uint8Array(MAX_FILE_BYTES).fill(7)]),
  })
  const fetched = await fetch(`${base}${filePath(roomId, full.id)}`, { headers: auth })
  const size = stored.ok && fetched.ok ? (await fetched.arrayBuffer()).byteLength : -1
  record(
    'uploads: a full 25 MB file',
    stored.status === 201 && size === MAX_FILE_BYTES,
    `PUT ${stored.status}, GET ${fetched.status}, ${size} bytes, ${Date.now() - started} ms`,
  )
  member.close()
}

async function main() {
  // 1. Turnstile: no token, a token that passes
  const noToken = await createRoom(null)
  record(
    'turnstile required',
    noToken.status === 403 && (noToken.body as { error?: string })?.error === 'turnstile_required',
    `POST without a token -> ${noToken.status} ${JSON.stringify(noToken.body)}`,
  )

  // 2. The creation limit: the first window's count go through, the next one is refused
  const [short] = ROOM_CREATE_LIMITS
  const rooms: string[] = []
  let refused: { status: number; body: unknown } | null = null
  for (let i = 0; i < short.count + 3 && !refused; i++) {
    const res = await createRoom(DUMMY_TOKEN)
    if (res.status === 201) rooms.push((res.body as { id: string }).id)
    else refused = res
  }
  const retryAfter = (refused?.body as { retryAfter?: number } | undefined)?.retryAfter
  record(
    'room creation limit',
    refused?.status === 429 && typeof retryAfter === 'number' && rooms.length <= short.count,
    `${rooms.length} rooms created, then ${refused?.status} ${JSON.stringify(refused?.body)}`,
  )
  const roomId = rooms[0]
  if (!roomId) {
    record('a room to test with', false, 'no room was created')
    return
  }

  // Files first: the floods below use up what this network may do in a room
  await uploads(rooms[2] ?? roomId)

  // 3. A frame flood on one socket closes it with rateLimited
  const flood = await socket(roomId, (ws) => {
    join(ws, 'Flood')
    // Not 'ping': the runtime answers those itself without waking the room
    for (let i = 0; i < SOCKET_MESSAGE_RATE.count + 20; i++) ws.send('{"t":"resync"}')
  })
  record(
    'socket message flood',
    flood.code === CloseCode.rateLimited,
    `${SOCKET_MESSAGE_RATE.count + 21} frames at once -> close ${flood.code}`,
  )

  // 4. An oversized frame closes the socket with 1009
  const big = await socket(roomId, (ws) => {
    join(ws, 'Big')
    ws.send(JSON.stringify({ t: 'rename', name: 'x'.repeat(MAX_CLIENT_MESSAGE_CHARS + 10) }))
  })
  record('oversized frame', big.code === 1009, `one ${MAX_CLIENT_MESSAGE_CHARS + 30}-char frame -> close ${big.code}`)

  // 5. Upgrades into one room from one network: paced under the per-isolate limit, so the room's
  //    own limit answers (rateLimited); a 429 from the isolate counts too (the upgrade fails)
  const connectRoom = rooms[1] ?? roomId
  let limited: number | 'open' | 'error' | null = null
  let opened = 0
  for (let i = 0; i < ROOM_CONNECT_RATE.count + 5 && limited === null; i++) {
    const { code } = await socket(connectRoom, (ws) => ws.close(1000), 3_000)
    if (code === CloseCode.rateLimited || code === 'error' || code === 1006) limited = code
    else opened++
    await sleep(200)
  }
  record(
    'connection rate per network',
    limited !== null && opened >= ROOM_CONNECT_RATE.count - 10,
    `${opened} upgrades went through, then ${limited}`,
  )

  // 6. The per-isolate first line on lookups (best effort: requests may land on other isolates)
  const lookups = await Promise.all(
    Array.from({ length: 120 }, () =>
      fetch(`${base}/api/rooms/${roomId}`).then((res) => res.status),
    ),
  )
  const tooMany = lookups.filter((status) => status === 429).length
  record(
    'lookup burst (per isolate, best effort)',
    lookups.every((status) => status === 200 || status === 429),
    `120 at once -> ${lookups.length - tooMany} answered, ${tooMany} × 429`,
  )

  // 7. Security headers on the page and the API
  const page = await fetch(`${base}/r/${roomId}`)
  const csp = page.headers.get('content-security-policy') ?? ''
  record(
    'security headers',
    csp.includes("frame-ancestors 'none'") &&
      !!page.headers.get('strict-transport-security') &&
      (page.headers.get('permissions-policy') ?? '').includes('camera=(self)') &&
      page.headers.get('cross-origin-opener-policy') === 'same-origin',
    `CSP ${csp.length} chars, HSTS ${page.headers.get('strict-transport-security')}`,
  )

  // 8. The blocklist, with the preview's /admin password: block this network (it is the latest
  //    offender after the floods), see 403 blocked, unblock
  if (!adminToken) {
    console.log('skip blocklist: no ADMIN_TOKEN (PREVIEW_ADMIN_TOKEN in GitHub)')
    return
  }
  const auth = { Authorization: `Bearer ${adminToken}` }
  const summary = (await (await fetch(`${base}/api/admin/summary`, { headers: auth })).json()) as {
    abuse?: { offenders: { key: string; counts: Record<string, number> }[] }
  }
  const me = summary.abuse?.offenders.find((o) => (o.counts.flood ?? 0) > 0)
  if (!me) {
    record('blocklist', false, 'this network is not among the offenders')
    return
  }
  await fetch(`${base}/api/admin/blocks`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ key: me.key, hours: 1, note: 'abuse test' }),
  })
  // Other isolates hear of it within BLOCKLIST_CACHE_MS (30 s)
  let blocked = 0
  for (let i = 0; i < 20 && blocked === 0; i++) {
    const res = await fetch(`${base}/api/rooms/${roomId}`)
    if (res.status === 403) blocked = i + 1
    else await sleep(2_000)
  }
  const del = await fetch(`${base}/api/admin/blocks/${me.key}`, { method: 'DELETE', headers: auth })
  record('blocklist', blocked > 0 && del.ok, `403 blocked after ${blocked} tries; unblock ${del.status}`)
}

main()
  .catch((error: unknown) => record('run', false, String(error)))
  .finally(() => {
    const failed = results.filter((r) => !r.ok)
    console.log(`\nabuse test: ${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length > 0 ? 1 : 0)
  })

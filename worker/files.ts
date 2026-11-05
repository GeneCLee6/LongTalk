import { ISOLATE_FILES_RATE } from '../shared/abuse.ts'
import {
  MAX_THUMB_BYTES,
  SAFE_IMAGE_TYPES,
  SNIFF_BYTES,
  checkUpload,
  classifyUpload,
  contentDisposition,
  isFileId,
  parseUploadRequest,
  sniffImage,
  thumbKey,
  type ChatFile,
  type UploadGrant,
  type UploadRefusal,
} from '../shared/files.ts'
import { isSessionToken } from '../shared/protocol.ts'
import { FILE_CSP } from '../shared/security-headers.ts'
import { isRoomKey } from '../shared/slug.ts'
import { isBlocked, takeIsolateRate, type GuardDeps } from './abuse.ts'
import { requestClientKey, type ClientKeyEnv } from './client-key.ts'
import type { ReserveDecision } from './file-ledger.ts'
import type { FileAccess, GrantDecision, GrantRequest, UploadClaim } from './room-files.ts'
import { runSweep } from './scheduled.ts'

// Files shared in chat (I5, e5-t05). The browser sends the bytes here and the Worker streams them
// to the R2 binding: no API credentials, no CORS rule, `connect-src 'self'` as it was (the epic
// has the comparison with presigned URLs). RoomDO decides who may (CLAUDE.md rule 1); FileLedgerDO
// holds the global cap; GuardDO counts per network.
//
//   POST   /api/files/<room>            { name, size, type, thumb } → 201 { id, expiresAt }
//   PUT    /api/files/<room>/<id>/thumb the thumbnail's bytes, before the file's (optional)
//   PUT    /api/files/<room>/<id>       the bytes → 201; the room posts the chat message
//   DELETE /api/files/<room>/<id>       give up on an upload not finished
//   GET    /api/files/<room>/<id>[/thumb]
//
// Every call carries the member's session token (`Authorization: Bearer …`), like the SFU proxy. A
// link alone opens nothing: an uploaded page can never load in a tab as this origin.

export interface FilesEnv extends ClientKeyEnv {
  /** The upload bucket; without it the API answers 503 `unavailable` */
  FILES_BUCKET?: R2Bucket
  /** The D1 backup bucket (production only; worker/backup.ts) */
  BACKUPS_BUCKET?: R2Bucket
}

/** What the routes ask of the room (RoomDO's RPC) */
export interface FileRoom {
  grantUpload(token: string, request: GrantRequest): Promise<GrantDecision>
  claimUpload(
    token: string,
    id: string,
    part: 'file' | 'thumb',
    bytes: number,
  ): Promise<UploadClaim>
  thumbStored(token: string, id: string): Promise<boolean>
  finishUpload(
    token: string,
    id: string,
    stored: { kind: ChatFile['kind']; mime: string },
  ): Promise<ChatFile | null>
  abortUpload(token: string, id: string): Promise<boolean>
  fileAccess(token: string, id: string): Promise<FileAccess>
}

/** What the routes ask of FileLedgerDO */
export interface FileLedgerRpc {
  reserve(id: string, bytes: number): Promise<ReserveDecision>
  commit(id: string, bytes: number, objects: number): Promise<void>
  release(id: string): Promise<void>
  reconcile(
    live: { bytes: number; objects: number },
    deleted: { objects: number; bytes: number },
  ): Promise<void>
}

type ByteStreams = {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

export interface FilesDeps {
  guard: GuardDeps
  room(roomId: string): FileRoom
  ledger: FileLedgerRpc
  waitUntil(promise: Promise<unknown>): void
  /** The runtime's FixedLengthStream; tests pass one that behaves the same */
  fixedLength?(bytes: number): ByteStreams
  now?(): number
}

const PATH = /^\/api\/files\/([^/]+)(?:\/([^/]+)(\/thumb)?)?$/

const noStore = { 'cache-control': 'no-store' }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...noStore, ...headers } })
}

function refuse(
  error: UploadRefusal,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json({ error }, status, headers)
}

function bearer(request: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
  return match && isSessionToken(match[1]) ? match[1] : null
}

export async function handleFiles(
  request: Request,
  env: FilesEnv,
  url: URL,
  deps: FilesDeps,
): Promise<Response> {
  const match = PATH.exec(url.pathname)
  if (!match || !isRoomKey(match[1]) || (match[2] && !isFileId(match[2]))) {
    return json({ error: 'not_found' }, 404)
  }
  const [, roomId, id, thumb] = match
  const client = await requestClientKey(request, env)
  if (client && (await isBlocked(client, deps.guard))) return refuse('blocked', 403)
  if (client && !takeIsolateRate(client, Date.now(), ISOLATE_FILES_RATE)) {
    return refuse('rate_limited', 429, { 'retry-after': '10' })
  }
  // Tokens are not ambient (no cookie), but no other site has any business here either
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== url.origin) return json({ error: 'forbidden_origin' }, 403)
  const token = bearer(request)
  if (!token) return refuse('unauthorized', 401)
  if (!env.FILES_BUCKET) return refuse('unavailable', 503)
  const bucket = env.FILES_BUCKET
  const room = deps.room(roomId)

  if (!id) {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    return grant(request, env, token, room, client, deps)
  }
  if (request.method === 'GET') return download(bucket, room, token, id, thumb !== undefined)
  if (request.method === 'PUT') {
    return thumb
      ? uploadThumb(request, bucket, room, token, id)
      : uploadFile(request, bucket, room, token, id, deps)
  }
  if (request.method === 'DELETE' && !thumb) {
    const aborted = await room.abortUpload(token, id)
    if (aborted) await deps.ledger.release(id).catch(() => {})
    return aborted ? json({ ok: true }) : json({ error: 'not_found' }, 404)
  }
  return methodNotAllowed(thumb ? 'GET, PUT' : 'GET, PUT, DELETE')
}

/**
 * POST: what is announced is checked, then the room (who, and the member's and room's limits),
 * then this network's limit, then the global cap. Members are asked first so nobody outside a room
 * can spend a network's allowance.
 */
async function grant(
  request: Request,
  env: FilesEnv,
  token: string,
  room: FileRoom,
  client: string | null,
  deps: FilesDeps,
): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? '0') > 4096) {
    return refuse('bad_request', 400)
  }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return refuse('bad_request', 400)
  }
  const parsed = parseUploadRequest(raw)
  if (!parsed) return refuse('bad_request', 400)
  const checked = checkUpload(parsed)
  if (!checked.ok) {
    const status =
      checked.code === 'too_large' ? 413 : checked.code === 'blocked_type' ? 415 : 400
    return refuse(checked.code, status)
  }
  const decision = await room.grantUpload(token, { ...checked.file, thumb: parsed.thumb })
  if (!decision.ok) {
    switch (decision.reason) {
      case 'unauthorized':
        return refuse('unauthorized', 401)
      case 'forbidden':
        return refuse('forbidden', 403)
      case 'member_quota':
        return refuse('member_quota', 429)
      case 'room_quota':
        return refuse('room_quota', 429)
    }
  }
  const { id, expiresAt } = decision
  try {
    if (client) {
      const limited = await deps.guard.limit('upload', client)
      if (!limited.ok) {
        await room.abortUpload(token, id)
        const retryAfter = Math.max(1, Math.ceil(limited.retryAfterMs / 1000))
        return json({ error: 'rate_limited', retryAfter }, 429, {
          'retry-after': String(retryAfter),
        })
      }
    }
    const reserved = await deps.ledger.reserve(
      id,
      checked.file.size + (parsed.thumb ? MAX_THUMB_BYTES : 0),
    )
    if (!reserved.ok) {
      await room.abortUpload(token, id)
      return refuse('storage_full', 507)
    }
    if (reserved.sweepDue) {
      deps.waitUntil(
        runSweep(env, deps.ledger, deps.now?.() ?? Date.now()).catch((error: unknown) =>
          console.error('upload sweep failed', error),
        ),
      )
    }
  } catch (error) {
    // The cap cannot be checked: it protects the owner's bill, so no upload goes ahead without it
    console.error('upload limits unavailable', error)
    await room.abortUpload(token, id).catch(() => {})
    return refuse('unavailable', 503)
  }
  const body: UploadGrant = { id, expiresAt }
  return json(body, 201)
}

/** The size the request announced, when it announced a usable one */
function announcedLength(request: Request): number | null {
  const raw = request.headers.get('content-length')
  if (raw === null || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

/** Reads until at least `bytes` came (or the body ended): all of it, however much that is */
async function readHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  while (length < bytes) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.byteLength
  }
  const head = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    head.set(chunk, at)
    at += chunk.byteLength
  }
  return head
}

function claimRefused(reason: Extract<UploadClaim, { ok: false }>['reason']): Response {
  switch (reason) {
    case 'unauthorized':
      return refuse('unauthorized', 401)
    case 'forbidden':
      return refuse('forbidden', 403)
    case 'not_found':
      return json({ error: 'not_found' }, 404)
    case 'wrong_size':
      return refuse('incomplete', 400)
  }
}

/**
 * PUT the file. Content-Length is required (R2 needs a known length, and every browser sends it
 * for a File) and must be what the grant says. The first bytes decide what it is before anything
 * reaches R2 (classifyUpload). The rest is a native pipe through a FixedLengthStream: no JavaScript
 * per chunk, which matters on the free plan's CPU limit, and the stream itself fails the moment one
 * byte too many comes, so the limit holds while streaming and R2's put, which is all or nothing,
 * stores nothing.
 */
async function uploadFile(
  request: Request,
  bucket: R2Bucket,
  room: FileRoom,
  token: string,
  id: string,
  deps: FilesDeps,
): Promise<Response> {
  const length = announcedLength(request)
  if (length === null || !request.body) return json({ error: 'length_required' }, 411)
  const claim = await room.claimUpload(token, id, 'file', length)
  if (!claim.ok) return claimRefused(claim.reason)
  const fail = async (response: Response) => {
    await Promise.allSettled([room.abortUpload(token, id), deps.ledger.release(id)])
    return response
  }
  const body = request.body
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  let verdict: ReturnType<typeof classifyUpload>
  let head: Uint8Array
  try {
    head = await readHead(reader, SNIFF_BYTES)
    verdict = classifyUpload(claim, head)
  } catch {
    return fail(refuse('incomplete', 400))
  }
  if (!verdict.ok) {
    await reader.cancel().catch(() => {})
    return fail(refuse(verdict.code, 415))
  }
  const fixed = fixedLengthStream(deps, length)
  const writing = (async () => {
    const writer = fixed.writable.getWriter()
    await writer.write(head)
    writer.releaseLock()
    reader.releaseLock()
    await body.pipeTo(fixed.writable)
  })()
  const contentType = verdict.kind === 'image' ? verdict.mime : 'application/octet-stream'
  try {
    await Promise.all([
      bucket.put(claim.key, fixed.readable, { httpMetadata: { contentType } }),
      writing,
    ])
  } catch (error) {
    // Cut off, or more bytes than announced. R2 stored nothing
    console.error('upload failed', String(error))
    writing.catch(() => {})
    return fail(refuse('incomplete', 400))
  }
  const file = await room.finishUpload(token, id, { kind: verdict.kind, mime: verdict.mime })
  if (!file) {
    // Removed from the room, or it closed, while the bytes were on their way
    await bucket.delete([claim.key, thumbKey(claim.key)]).catch(() => {})
    await deps.ledger.release(id).catch(() => {})
    return refuse('forbidden', 403)
  }
  await deps.ledger.commit(id, length, file.thumb ? 2 : 1).catch((error: unknown) => {
    // The hourly sweep counts what is really there
    console.error('file ledger commit failed', error)
  })
  return json(file, 201)
}

/**
 * PUT the thumbnail: small enough to read whole. It comes from the browser, so it is as untrusted
 * as anything: it must really be a safe image, whatever it says it is.
 */
async function uploadThumb(
  request: Request,
  bucket: R2Bucket,
  room: FileRoom,
  token: string,
  id: string,
): Promise<Response> {
  const length = announcedLength(request)
  if (length === null || !request.body) return json({ error: 'length_required' }, 411)
  if (length > MAX_THUMB_BYTES) return refuse('too_large', 413)
  const claim = await room.claimUpload(token, id, 'thumb', length)
  if (!claim.ok) return claimRefused(claim.reason)
  // Read up to the limit, whatever was announced
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  let bytes: Uint8Array
  try {
    bytes = await readHead(reader, MAX_THUMB_BYTES + 1)
  } catch {
    return refuse('incomplete', 400)
  }
  if (bytes.byteLength > MAX_THUMB_BYTES) {
    await reader.cancel().catch(() => {})
    return refuse('too_large', 413)
  }
  const mime = sniffImage(bytes)
  if (!mime) return refuse('not_an_image', 415)
  await bucket.put(claim.key, bytes, { httpMetadata: { contentType: mime } })
  await room.thumbStored(token, id)
  return json({ ok: true }, 201)
}

/**
 * GET: only for someone in the room, only a file of this room. The answer can never run as this
 * origin: nosniff; a sandboxing CSP; `application/octet-stream` with `attachment` for anything but
 * an image whose bytes were checked at upload. Not kept by caches: the token decides, not the URL.
 */
async function download(
  bucket: R2Bucket,
  room: FileRoom,
  token: string,
  id: string,
  thumb: boolean,
): Promise<Response> {
  const access = await room.fileAccess(token, id)
  if (!access.ok) {
    switch (access.reason) {
      case 'unauthorized':
        return refuse('unauthorized', 401)
      case 'forbidden':
        return refuse('forbidden', 403)
      case 'expired':
        return json({ error: 'expired' }, 410)
      case 'not_found':
        return json({ error: 'not_found' }, 404)
    }
  }
  if (thumb && !access.thumb) return json({ error: 'not_found' }, 404)
  const object = await bucket.get(thumb ? thumbKey(access.key) : access.key)
  if (!object) return json({ error: 'expired' }, 410)
  const type = thumb ? object.httpMetadata?.contentType : access.mime
  const safeImage = (thumb || access.kind === 'image') && SAFE_IMAGE_TYPES.has(type ?? '')
  return new Response(object.body, {
    headers: {
      'content-type': safeImage ? type! : 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': contentDisposition(access.name, safeImage),
      'x-content-type-options': 'nosniff',
      'content-security-policy': FILE_CSP,
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, no-store',
    },
  })
}

function fixedLengthStream(deps: FilesDeps, bytes: number): ByteStreams {
  if (deps.fixedLength) return deps.fixedLength(bytes)
  return new FixedLengthStream(bytes) as unknown as ByteStreams
}

function methodNotAllowed(allow: string): Response {
  return json({ error: 'method_not_allowed' }, 405, { allow })
}

import { ACCOUNT_API } from '../shared/account.ts'
import type { HealthResponse } from '../shared/health.ts'
import { ADMIN_BLOCKS_PATH } from '../shared/abuse.ts'
import { EVENTS_PATH } from '../shared/telemetry.ts'
import type { UsageState } from '../shared/usage.ts'
import type { GuardDeps } from './abuse.ts'
import { handleAdminBlocks } from './admin-blocks.ts'
import type { ClientKeyEnv } from './client-key.ts'
import { handleCspReport } from './csp-report.ts'
import {
  clientKey,
  handleAdmin,
  handleEvents,
  TELEMETRY_OBJECT,
  type TelemetryEnv,
} from './events.ts'
import type { GuardDO } from './guard-do.ts'
import { GUARD_OBJECT } from './guard.ts'
import { CSP_REPORT_PATH, withApiHeaders } from './headers.ts'
import type { RoomDO } from './room.ts'
import { handleAccount } from './accounts.ts'
import { FILES_API } from '../shared/files.ts'
import { FILE_LEDGER_OBJECT } from './file-ledger.ts'
import type { FileLedgerDO } from './file-ledger-do.ts'
import { handleFiles, type FilesEnv } from './files.ts'
import { handleMeetingView } from './meetings.ts'
import { MEETINGS_API } from '../shared/meeting.ts'
import { handleRooms } from './rooms.ts'
import { handleSfu, type SfuEnv } from './sfu.ts'
import { handleTurn, type TurnEnv } from './turn.ts'
import type { TelemetryDO } from './telemetry-do.ts'
import { turnstileSiteKey, type TurnstileEnv } from './turnstile.ts'
import type { UsageDO } from './usage-do.ts'
import { USAGE_OBJECT, type UsageEnv } from './usage.ts'

export interface Env
  extends SfuEnv, TurnEnv, UsageEnv, TelemetryEnv, TurnstileEnv, ClientKeyEnv, FilesEnv {
  ASSETS: Fetcher
  ROOM: DurableObjectNamespace<RoomDO>
  /** One object for the whole deployment: the month's Realtime egress (e11-t13) */
  USAGE: DurableObjectNamespace<UsageDO>
  /** One object for the whole deployment: the telemetry counters behind /admin (e11-t03) */
  TELEMETRY: DurableObjectNamespace<TelemetryDO>
  /** One object for the whole deployment: room-creation limits, IP blocklist (e11-t05) */
  GUARD: DurableObjectNamespace<GuardDO>
  /** One object for the whole deployment: what the upload bucket holds, its cap (I5, e11-t08) */
  FILE_LEDGER: DurableObjectNamespace<FileLedgerDO>
  /**
   * Accounts, passkeys, sessions, persistent rooms (I2) and scheduled meetings (I3), migrations/.
   * Optional so a deployment without it still serves rooms; /api/account then answers 503
   */
  DB?: D1Database
  // Set at deploy time (wrangler deploy --var APP_VERSION:<commit>)
  APP_VERSION?: string
}
const noStore = { 'cache-control': 'no-store' }

/** The SFU proxy reads the month's state at most this often per isolate */
const USAGE_CACHE_MS = 30_000
let usageCache: { at: number; state: UsageState } | null = null

function usageStub(env: Env) {
  return env.USAGE.get(env.USAGE.idFromName(USAGE_OBJECT))
}

/**
 * The month's usage state for the SFU proxy, cached briefly. When UsageDO cannot be reached the
 * call goes ahead (a transient failure must not cut video); the next flush catches up.
 */
async function cachedUsageState(env: Env, now = Date.now()): Promise<UsageState> {
  if (usageCache && now - usageCache.at < USAGE_CACHE_MS) return usageCache.state
  try {
    const { state } = await usageStub(env).status()
    usageCache = { at: now, state }
    return state
  } catch (error) {
    console.error('usage status failed', error)
    return usageCache?.state ?? 'normal'
  }
}

/** For tests: forget the cached usage state */
export function resetUsageCache(): void {
  usageCache = null
}

/** GuardDO's RPC as the Worker uses it (worker/abuse.ts) */
export function guardDeps(env: Pick<Env, 'GUARD'>): GuardDeps {
  const stub = () => env.GUARD.get(env.GUARD.idFromName(GUARD_OBJECT))
  return {
    create: (key) => stub().create(key),
    limit: (kind, key) => stub().limit(kind, key),
    note: (key, kind) => stub().note(key, kind),
    blocked: () => stub().blocked(),
    block: (key, hours, note) => stub().block(key, hours, note),
    unblock: (key) => stub().unblock(key),
    summary: () => stub().summary(),
  }
}

/** The file ledger's RPC as the Worker uses it (worker/files.ts) */
export function fileLedger(env: Pick<Env, 'FILE_LEDGER'>) {
  return env.FILE_LEDGER.get(env.FILE_LEDGER.idFromName(FILE_LEDGER_OBJECT))
}

type WaitUntil = Pick<ExecutionContext, 'waitUntil'>

// The Worker answers /api/* and hands everything else to the static assets (the React app).
// /r/:roomId is a client route: assets answer it with index.html (single-page-application);
// the room's WebSocket is /api/rooms/<id>/ws (worker/rooms.ts). Every answer of its own carries
// the API security headers (worker/headers.ts); the pages get theirs from public/_headers.
export async function handleRequest(
  request: Request,
  env: Env,
  ctx?: WaitUntil,
): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
  return withApiHeaders(await handleApi(request, env, url, ctx))
}

async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: WaitUntil | undefined,
): Promise<Response> {
  if (url.pathname === '/api/health') {
    const body: HealthResponse = { ok: true, version: env.APP_VERSION ?? 'local' }
    return Response.json(body, { headers: noStore })
  }
  if (url.pathname === '/api/rooms' || url.pathname.startsWith('/api/rooms/')) {
    return handleRooms(request, env, url, {
      guard: guardDeps(env),
      waitUntil: (promise) => ctx?.waitUntil(promise),
    })
  }
  if (url.pathname === ACCOUNT_API || url.pathname.startsWith(`${ACCOUNT_API}/`)) {
    return handleAccount(request, env, url, {
      guard: guardDeps(env),
      room: (slug) => env.ROOM.get(env.ROOM.idFromName(slug)),
    })
  }
  if (url.pathname.startsWith(`${MEETINGS_API}/`)) {
    return handleMeetingView(request, env, url, { guard: guardDeps(env) })
  }
  if (url.pathname.startsWith(`${FILES_API}/`)) {
    return handleFiles(request, env, url, {
      guard: guardDeps(env),
      room: (roomId) => env.ROOM.get(env.ROOM.idFromName(roomId)),
      ledger: fileLedger(env),
      waitUntil: (promise) => ctx?.waitUntil(promise),
    })
  }
  if (url.pathname.startsWith('/api/sfu/')) {
    return handleSfu(request, env, {
      room: (roomId) => env.ROOM.get(env.ROOM.idFromName(roomId)),
      usage: () => cachedUsageState(env),
    })
  }
  if (url.pathname.startsWith('/api/turn/')) {
    return handleTurn(request, env, { room: (roomId) => env.ROOM.get(env.ROOM.idFromName(roomId)) })
  }
  if (url.pathname === '/api/usage') {
    if (request.method !== 'GET') {
      return Response.json(
        { error: 'method_not_allowed' },
        { status: 405, headers: { allow: 'GET' } },
      )
    }
    return Response.json(await usageStub(env).status(), { headers: noStore })
  }
  const telemetry = () => env.TELEMETRY.get(env.TELEMETRY.idFromName(TELEMETRY_OBJECT))
  const record = (client: string, events: Parameters<TelemetryDO['record']>[1]) =>
    telemetry().record(client, events)
  if (url.pathname === CSP_REPORT_PATH) return handleCspReport(request, record, clientKey)
  if (url.pathname === ADMIN_BLOCKS_PATH || url.pathname.startsWith(`${ADMIN_BLOCKS_PATH}/`)) {
    return handleAdminBlocks(request, env, url, guardDeps(env))
  }
  if (url.pathname === EVENTS_PATH || url.pathname.startsWith('/api/admin/')) {
    const guard = guardDeps(env)
    const deps = {
      record,
      summary: () => telemetry().summary(),
      usage: () => usageStub(env).status(),
      abuse: async () => ({
        ...(await guard.summary()),
        turnstile: turnstileSiteKey(env) !== null,
        pepper: Boolean(env.IP_HASH_PEPPER),
      }),
      files: async () => ({
        ...(await fileLedger(env).status()),
        backups: env.BACKUPS_BUCKET !== undefined,
      }),
    }
    return url.pathname === EVENTS_PATH
      ? handleEvents(request, env, url, deps)
      : handleAdmin(request, env, url, deps)
  }
  return Response.json({ error: 'not_found' }, { status: 404 })
}

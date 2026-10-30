// The messages between a browser and its room's Durable Object (RoomDO), over one WebSocket per
// member: GET /api/rooms/<roomId>/ws?v=<PROTOCOL_VERSION>. Shared by the Worker and the browser.
//
// 1. The server answers the upgrade with `welcome`: the member's id and the whole room (`state`).
// 2. Every change after that is a `patch` (shared/patch.ts) numbered `rev`, sent to everyone.
//    A browser that sees a gap in `rev` sends `resync` and gets a `snapshot`.
// 3. Heartbeat: the browser sends the text frame `ping` every HEARTBEAT_INTERVAL_MS and gets
//    `pong` (answered without waking the object); a member silent for STALE_AFTER_MS is dropped.
//
// View types are `type` aliases, not interfaces, so they stay assignable to JsonValue.
import type { JsonValue, PatchOp } from './patch.ts'

/** Bumped on any change a browser of the previous version could not understand */
export const PROTOCOL_VERSION = 1

export const HEARTBEAT_PING = 'ping'
export const HEARTBEAT_PONG = 'pong'
export const HEARTBEAT_INTERVAL_MS = 15_000
/** Three missed heartbeats */
export const STALE_AFTER_MS = 45_000
/** How often the room checks for stale members while anyone is connected */
export const SWEEP_INTERVAL_MS = 15_000

/** Hard cap on members connected to one room (M3's target is 50, F36) */
export const MAX_MEMBERS = 50
/** Client messages larger than this are refused without parsing */
export const MAX_CLIENT_MESSAGE_CHARS = 4_096

/** WebSocket close codes the server uses; the browser must not retry on the 44xx ones */
export const CloseCode = {
  /** The browser speaks another protocol version: reload the page */
  versionMismatch: 4400,
  /** No room with this id (never created, or closed) */
  roomNotFound: 4404,
  /** MAX_MEMBERS already connected */
  roomFull: 4409,
  /** No heartbeat for STALE_AFTER_MS */
  stale: 4408,
} as const

/** The room as POST /api/rooms creates it */
export type RoomInfo = {
  id: string
  createdAt: number
}

/** One connected person. A4 (e1-t03) adds the name, role and session; e2-t03 adds the tracks. */
export type Member = {
  id: string
  joinedAt: number
}

/** What every member sees of the room: the state `snapshot` sends and `patch` keeps up to date */
export type RoomView = {
  room: RoomInfo
  members: Record<string, Member>
}

// ── Server → browser ─────────────────────────────────────────────────────────────────────────

export type WelcomeMessage = {
  t: 'welcome'
  v: typeof PROTOCOL_VERSION
  /** This connection's member id */
  you: string
  rev: number
  state: RoomView
}

export type SnapshotMessage = { t: 'snapshot'; rev: number; state: RoomView }

/** The changes from rev − 1 to `rev` */
export type PatchMessage = { t: 'patch'; rev: number; ops: PatchOp[] }

export type ErrorMessage = { t: 'error'; code: 'bad_message' }

export type ServerMessage = WelcomeMessage | SnapshotMessage | PatchMessage | ErrorMessage

// ── Browser → server ─────────────────────────────────────────────────────────────────────────

export type ResyncMessage = { t: 'resync' }

export type ClientMessage = ResyncMessage

// ── POST /api/rooms ──────────────────────────────────────────────────────────────────────────

export type CreateRoomResponse = { id: string }

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

function parseObject(raw: string, maxChars: number): Record<string, unknown> | null {
  if (raw.length > maxChars) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A browser's message, or null when it is not one this version understands */
export function parseClientMessage(raw: string): ClientMessage | null {
  const value = parseObject(raw, MAX_CLIENT_MESSAGE_CHARS)
  if (value?.t === 'resync') return { t: 'resync' }
  return null
}

const isRev = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

function isRoomView(value: unknown): value is RoomView {
  if (typeof value !== 'object' || value === null) return false
  const view = value as Record<string, unknown>
  return (
    typeof view.room === 'object' &&
    view.room !== null &&
    typeof view.members === 'object' &&
    view.members !== null
  )
}

/**
 * The server's message, or null when it is not one this version understands. Checks the shape
 * the browser relies on, not every field: the server is trusted, the check guards against
 * version skew and proxies, not attackers.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  const value = parseObject(raw, Number.POSITIVE_INFINITY)
  if (!value) return null
  switch (value.t) {
    case 'welcome':
      return value.v === PROTOCOL_VERSION &&
        typeof value.you === 'string' &&
        isRev(value.rev) &&
        isRoomView(value.state)
        ? (value as WelcomeMessage)
        : null
    case 'snapshot':
      return isRev(value.rev) && isRoomView(value.state) ? (value as SnapshotMessage) : null
    case 'patch':
      return isRev(value.rev) && Array.isArray(value.ops) ? (value as PatchMessage) : null
    case 'error':
      return value as ErrorMessage
    default:
      return null
  }
}

/** The WebSocket path for a room (relative to the site's origin) */
export function roomSocketPath(roomId: string): string {
  return `/api/rooms/${roomId}/ws?v=${PROTOCOL_VERSION}`
}

/** Typed helper so a view can be diffed and patched (shared/patch.ts) */
export const viewAsJson = (view: RoomView): JsonValue => view

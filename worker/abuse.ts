import {
  ISOLATE_ROOM_RATE,
  takeFromWindows,
  type AbuseSummary,
  type BlockEntry,
  type OffenceKind,
} from '../shared/abuse.ts'
import type { CreateDecision } from './guard.ts'

// The Worker's side of the abuse protection (I1, e11-t05): the blocklist as this isolate last
// heard it, and a per-isolate first line for /api/rooms/*. The worldwide counting is GuardDO's.

/** What the Worker asks of GuardDO (RPC; a fake in tests) */
export interface GuardDeps {
  create(key: string): Promise<CreateDecision>
  note(key: string, kind: OffenceKind): Promise<void>
  blocked(): Promise<string[]>
  block(key: string, hours: number, note: string): Promise<BlockEntry>
  unblock(key: string): Promise<boolean>
  summary(): Promise<Pick<AbuseSummary, 'blocks' | 'offenders'>>
}

/** A Worker isolate reads the blocklist from GuardDO at most this often */
export const BLOCKLIST_CACHE_MS = 30_000

let blocklist: { at: number; keys: Set<string> } | null = null

/**
 * Whether `key` is blocked, from the cached list (a block reaches every isolate within
 * BLOCKLIST_CACHE_MS). When GuardDO cannot be reached the last list stands, or nobody is
 * blocked: a hiccup must not lock everyone out.
 */
export async function isBlocked(key: string, guard: GuardDeps, now = Date.now()): Promise<boolean> {
  if (!blocklist || now - blocklist.at >= BLOCKLIST_CACHE_MS) {
    try {
      blocklist = { at: now, keys: new Set(await guard.blocked()) }
    } catch (error) {
      console.error('guard blocklist failed', error)
      blocklist = { at: now, keys: blocklist?.keys ?? new Set() }
    }
  }
  return blocklist.keys.has(key)
}

/** After /admin changes the list: this isolate reads it again at once */
export function forgetBlocklist(): void {
  blocklist = null
}

const recent = new Map<string, number[]>()

/**
 * The per-isolate limit on /api/rooms/* (ISOLATE_ROOM_RATE): true when `key` may go on. In
 * memory and per isolate, so only a first line against a flood; RoomDO and GuardDO hold the
 * real limits.
 */
export function takeIsolateRate(key: string, now = Date.now()): boolean {
  const result = takeFromWindows(recent.get(key) ?? [], [ISOLATE_ROOM_RATE], now)
  recent.set(key, result.times)
  if (recent.size > 10_000) recent.clear()
  return result.ok
}

/** For tests: forget the cached blocklist and the isolate's counts */
export function resetAbuseState(): void {
  blocklist = null
  recent.clear()
}

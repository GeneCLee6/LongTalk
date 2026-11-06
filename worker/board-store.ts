import { BOARD_LIMITS, MAX_BOARD_FILE_BYTES } from '../shared/annotation-limits.ts'
import { BOARD_SPACE, PAST_AUTHOR, parseStroke, strokeCost, type Stroke } from '../shared/annotation.ts'
import { BOARD_PREFIX } from '../shared/files.ts'
import type { ReserveDecision } from './file-ledger.ts'

// A persistent room's whiteboard between meetings (J4, e7-t08): one JSON object in the uploads
// bucket, at BOARD_PREFIX (so the hourly sweep's 24-hour rule, which only reads UPLOAD_PREFIX, never
// sees it; worker/sweep.ts counts it and deletes it only when its room no longer exists). Everything
// in the bucket counts towards GLOBAL_FILE_CAP_BYTES, this too, through FileLedgerDO.
//
// In a meeting RoomHost holds the strokes (worker/room-annotations.ts, RoomDO's storage); this is
// only what outlives the meeting. `by` is not kept: a member id means nothing after the meeting
// that made it, and is one thing less to keep about anyone.

/** What the store needs of FileLedgerDO */
export interface BoardLedger {
  reserve(id: string, bytes: number): Promise<ReserveDecision>
  commit(id: string, bytes: number, objects: number): Promise<void>
  release(id: string): Promise<void>
  forget(ids: string[], bytes: number, objects: number): Promise<void>
}

type SavedBoard = { v: 1; savedAt: number; strokes: unknown[] }

export const boardKey = (record: { slug: string; createdAt: number }): string =>
  `${BOARD_PREFIX}${record.slug}/${record.createdAt}.json`

/** A board object's room, for the sweep; null for a key that is not one */
export function parseBoardKey(key: string): { slug: string; createdAt: number } | null {
  if (!key.startsWith(BOARD_PREFIX)) return null
  const match = /^([^/]+)\/(\d+)\.json$/.exec(key.slice(BOARD_PREFIX.length))
  return match ? { slug: match[1], createdAt: Number(match[2]) } : null
}

export function encodeBoard(strokes: readonly Stroke[], now: number): string {
  const saved: SavedBoard = {
    v: 1,
    savedAt: now,
    strokes: strokes.map((stroke) => ({ ...stroke, by: PAST_AUTHOR })),
  }
  return JSON.stringify(saved)
}

/**
 * The strokes of a stored board, re-validated as anything from the wire is, and no more than the
 * board's limits: nothing written by an older version can put a room past them. Oldest first, so
 * should there be too many, the oldest are what stays, as a board that refuses new strokes would
 */
export function decodeBoard(raw: string): Stroke[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = (parsed as Partial<SavedBoard> | null)?.strokes
  if (!Array.isArray(list)) return []
  const strokes: Stroke[] = []
  let cost = 0
  for (const item of list) {
    const stroke = parseStroke(item, BOARD_SPACE)
    if (!stroke) continue
    cost += strokeCost(stroke)
    if (strokes.length >= BOARD_LIMITS.strokes || cost > BOARD_LIMITS.cost) break
    strokes.push({ ...stroke, by: PAST_AUTHOR })
  }
  return strokes
}

const ATTEMPTS = 3
const RETRY_MS = 1_000

const systemSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Reads and writes boards one at a time, so a meeting's last save is done before the next meeting
 * reads, and a deletion comes after whatever save was under way.
 */
export class BoardStore {
  private readonly bucket: Pick<R2Bucket, 'get' | 'put' | 'head' | 'delete'>
  private readonly ledger: BoardLedger
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    bucket: Pick<R2Bucket, 'get' | 'put' | 'head' | 'delete'>,
    ledger: BoardLedger,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = systemSleep,
  ) {
    this.bucket = bucket
    this.ledger = ledger
    this.now = now
    this.sleep = sleep
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.catch(() => undefined)
    return run
  }

  /** R2 has its moments: a few tries a second apart, the last failure thrown */
  private async retried<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work()
      } catch (error) {
        if (attempt >= ATTEMPTS) throw error
        await this.sleep(RETRY_MS)
      }
    }
  }

  private async read(key: string): Promise<Stroke[] | null> {
    const object = await this.retried(() => this.bucket.get(key))
    return object ? decodeBoard(await object.text()) : null
  }

  /** The saved strokes, null when there are none. Throws when R2 cannot say: not the same thing */
  load(key: string): Promise<Stroke[] | null> {
    return this.queue(() => this.read(key))
  }

  private async write(key: string, strokes: readonly Stroke[]): Promise<boolean> {
    if (strokes.length === 0) {
      await this.erase(key)
      return true
    }
    const bytes = new TextEncoder().encode(encodeBoard(strokes, this.now()))
    if (bytes.byteLength > MAX_BOARD_FILE_BYTES) {
      console.error('a whiteboard is larger than a stored board may be', bytes.byteLength)
      return false
    }
    const before = await this.retried(() => this.bucket.head(key))
    const change = bytes.byteLength - (before?.size ?? 0)
    const grant = `board:${key}`
    if (change > 0 && !(await this.ledger.reserve(grant, change)).ok) {
      console.error('the bucket is full: a whiteboard was not saved')
      return false
    }
    try {
      await this.retried(() =>
        this.bucket.put(key, bytes, { httpMetadata: { contentType: 'application/json' } }),
      )
    } catch (error) {
      if (change > 0) await this.ledger.release(grant)
      throw error
    }
    await this.ledger.commit(grant, change, before ? 0 : 1)
    return true
  }

  /** Replaces what is saved (nothing left: deletes it). False when it could not be stored */
  save(key: string, strokes: readonly Stroke[]): Promise<boolean> {
    return this.queue(async () => {
      try {
        return await this.write(key, strokes)
      } catch (error) {
        console.error('saving a whiteboard failed', error)
        return false
      }
    })
  }

  /**
   * The meeting ended without ever having read what was saved (R2 was failing when it began): the
   * saved strokes stay underneath what this meeting drew, rather than being overwritten by it
   */
  merge(key: string, strokes: readonly Stroke[]): Promise<boolean> {
    return this.queue(async () => {
      try {
        const saved = (await this.read(key)) ?? []
        const known = new Set(saved.map((stroke) => stroke.id))
        const both = [...saved, ...strokes.filter((stroke) => !known.has(stroke.id))]
        // Both past the board's limits together is a board that could not exist: keep the limits
        return await this.write(key, decodeBoard(encodeBoard(both, this.now())))
      } catch (error) {
        console.error('saving a whiteboard failed', error)
        return false
      }
    })
  }

  private async erase(key: string): Promise<void> {
    const before = await this.retried(() => this.bucket.head(key))
    if (!before) return
    await this.retried(() => this.bucket.delete(key))
    await this.ledger.forget([], before.size, 1)
  }

  /**
   * Gone with its room or its owner's account. A failure is logged, not thrown: the room's row goes
   * regardless, and the sweep deletes a board whose room no longer exists (worker/sweep.ts)
   */
  remove(key: string): Promise<void> {
    return this.queue(async () => {
      try {
        await this.erase(key)
      } catch (error) {
        console.error('deleting a whiteboard failed', error)
      }
    })
  }

  /** Whatever was started has finished */
  async idle(): Promise<void> {
    await this.tail
  }
}

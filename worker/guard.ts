import {
  LIMITS,
  MAX_BLOCKS,
  MAX_OFFENDERS,
  takeFromWindows,
  type LimitKind,
  type AbuseSummary,
  type BlockEntry,
  type OffenceKind,
  type Offender,
} from '../shared/abuse.ts'

// GuardDO's state without the runtime (I1, e11-t05): rooms created per client (the worldwide
// creation limit), the IP blocklist (client keys with an expiry) and the recent offenders /admin
// lists. Every key is a client key (client-key.ts), never an address.

/** The one GuardDO, by name */
export const GUARD_OBJECT = 'guard'

/** The part of Durable Object storage GuardStore needs (a Map-backed fake in tests) */
export interface GuardStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

const BLOCKS_KEY = 'blocks'
const OFFENDERS_KEY = 'offenders'
/** One client's recent room creations (`create:` and its key), accounts, sign-ins (I2) */
const limitKey = (kind: LimitKind, key: string) => `${kind}:${key}`

/** Whether a create may go ahead */
export type CreateDecision = { ok: true } | { ok: false; retryAfterMs: number }

/**
 * Writes through, like TelemetryStore: everything that changed is stored before the answer (the
 * object may leave memory seconds after its last request). Creation times are read from storage
 * per client when first needed and then kept in memory.
 */
export class GuardStore {
  private readonly storage: GuardStorage
  private blocks: Map<string, BlockEntry>
  private offenders: Map<string, Offender>
  private readonly creations = new Map<string, number[]>()

  private constructor(storage: GuardStorage, blocks: BlockEntry[], offenders: Offender[]) {
    this.storage = storage
    this.blocks = new Map(blocks.map((entry) => [entry.key, entry]))
    this.offenders = new Map(offenders.map((entry) => [entry.key, entry]))
  }

  static async load(storage: GuardStorage): Promise<GuardStore> {
    const [blocks, offenders] = await Promise.all([
      storage.get<BlockEntry[]>(BLOCKS_KEY),
      storage.get<Offender[]>(OFFENDERS_KEY),
    ])
    return new GuardStore(storage, blocks ?? [], offenders ?? [])
  }

  /** Counts one room creation by `key`, or refuses it (ROOM_CREATE_LIMITS) */
  async create(key: string, now: number): Promise<CreateDecision> {
    return this.limit('create', key, now)
  }

  /**
   * Counts one `kind` (LIMITS: rooms, accounts, sign-ins) by `key`, or refuses it and notes the
   * offence
   */
  async limit(kind: LimitKind, key: string, now: number): Promise<CreateDecision> {
    const stored = limitKey(kind, key)
    let times = this.creations.get(stored)
    if (!times) times = (await this.storage.get<number[]>(stored)) ?? []
    const result = takeFromWindows(times, LIMITS[kind], now)
    this.creations.set(stored, result.times)
    if (!result.ok) {
      const offence: OffenceKind =
        kind === 'create' ? 'createLimit' : kind === 'upload' ? 'uploadLimit' : 'accountLimit'
      await this.note(key, offence, now)
      return { ok: false, retryAfterMs: result.retryAfterMs }
    }
    await this.storage.put(stored, result.times)
    // A long-lived object would otherwise keep every client it ever saw
    if (this.creations.size > 5000) this.creations.clear()
    return { ok: true }
  }

  /** Something `key` did that hit a limit (shown on /admin so the owner can block it) */
  async note(key: string, kind: OffenceKind, now: number): Promise<void> {
    const offender = this.offenders.get(key) ?? { key, last: now, counts: {} }
    offender.counts[kind] = (offender.counts[kind] ?? 0) + 1
    offender.last = now
    this.offenders.delete(key)
    this.offenders.set(key, offender)
    while (this.offenders.size > MAX_OFFENDERS) {
      this.offenders.delete(this.offenders.keys().next().value!)
    }
    await this.storage.put(OFFENDERS_KEY, [...this.offenders.values()])
  }

  /** The keys blocked at `now` (the Worker caches this list for a short while) */
  blocked(now: number): string[] {
    return [...this.blocks.values()].filter((entry) => entry.until > now).map((e) => e.key)
  }

  async block(key: string, hours: number, note: string, now: number): Promise<BlockEntry> {
    const entry: BlockEntry = { key, at: now, until: now + hours * 3_600_000, note }
    this.prune(now)
    this.blocks.set(key, entry)
    while (this.blocks.size > MAX_BLOCKS) {
      const soonest = [...this.blocks.values()].sort((a, b) => a.until - b.until)[0]
      this.blocks.delete(soonest.key)
    }
    await this.storage.put(BLOCKS_KEY, [...this.blocks.values()])
    return entry
  }

  /** False when `key` was not blocked */
  async unblock(key: string, now: number): Promise<boolean> {
    const had = this.blocks.delete(key)
    this.prune(now)
    await this.storage.put(BLOCKS_KEY, [...this.blocks.values()])
    return had
  }

  summary(now: number): Pick<AbuseSummary, 'blocks' | 'offenders'> {
    return {
      blocks: [...this.blocks.values()]
        .filter((entry) => entry.until > now)
        .sort((a, b) => b.at - a.at),
      offenders: [...this.offenders.values()].sort((a, b) => b.last - a.last),
    }
  }

  /** Expired blocks are dropped on the next write */
  private prune(now: number): void {
    for (const [key, entry] of this.blocks) if (entry.until <= now) this.blocks.delete(key)
  }
}

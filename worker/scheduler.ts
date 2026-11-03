/** Due times by key, as stored (epoch ms) */
export type Schedule = Record<string, number>

/**
 * Every timed job of one Durable Object behind its single alarm (e1-t04): each job has a key and
 * a due time; the object keeps its alarm at the earliest one (`next`) and, when it fires, runs
 * whatever is due (`take`). A job is set again by whoever owns it; setting a key that is already
 * scheduled moves it. Pure: no clock of its own, so tests drive it with a fake one.
 *
 * Keys in RoomHost: `sweep` (heartbeats, reconnect grace, usage flush), `close` (empty room),
 * `handoff` (host reconnecting too long), `bans` (the next ban of a removed browser runs out, F1;
 * a denied one, F2), `waiting` (the next one in the waiting room to wait too long, F2).
 */
export class Scheduler {
  private readonly due = new Map<string, number>()

  constructor(saved: Schedule | null = null) {
    for (const [key, at] of Object.entries(saved ?? {})) {
      if (Number.isFinite(at)) this.due.set(key, at)
    }
  }

  set(key: string, at: number): void {
    this.due.set(key, at)
  }

  /** Sets `key` only when it is not scheduled already */
  ensure(key: string, at: number): void {
    if (!this.due.has(key)) this.due.set(key, at)
  }

  clear(key: string): void {
    this.due.delete(key)
  }

  get(key: string): number | null {
    return this.due.get(key) ?? null
  }

  /** The earliest due time, for the alarm; null when nothing is scheduled */
  next(): number | null {
    let earliest: number | null = null
    for (const at of this.due.values()) if (earliest === null || at < earliest) earliest = at
    return earliest
  }

  /** Removes and returns the keys due at `now`, earliest first */
  take(now: number): string[] {
    const due = [...this.due].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1])
    for (const [key] of due) this.due.delete(key)
    return due.map(([key]) => key)
  }

  clearAll(): void {
    this.due.clear()
  }

  toJSON(): Schedule {
    return Object.fromEntries(this.due)
  }
}

import { DurableObject } from 'cloudflare:workers'
import type { UsageStatus } from '../shared/usage.ts'
import type { Env } from './app.ts'
import type { UsageDelta } from './room-host.ts'
import { thresholdsFromEnv, UsageLedger, type UsageRecord } from './usage.ts'

const RECORD_KEY = 'usage'

/**
 * The month's Realtime egress count (e11-t13): one object for the whole deployment (`USAGE_OBJECT`
 * in usage.ts). Rooms flush into it from their sweep alarm (`record`); the SFU proxy and
 * GET /api/usage read it (`status`). What it counts and why: shared/usage.ts; the arithmetic: UsageLedger (usage.ts).
 */
export class UsageDO extends DurableObject<Env> {
  private ledger: UsageLedger | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<UsageRecord>(RECORD_KEY)
      this.ledger = new UsageLedger(stored ?? null, Date.now())
    })
  }

  /** RPC from RoomDO's sweep: adds the room's flush and answers the month's status */
  async record(delta: UsageDelta): Promise<UsageStatus> {
    const ledger = this.ledger!
    const now = Date.now()
    if (ledger.add(delta, now)) await this.ctx.storage.put(RECORD_KEY, ledger.record)
    return ledger.status(now, thresholdsFromEnv(this.env))
  }

  /** RPC from the SFU proxy and GET /api/usage */
  async status(): Promise<UsageStatus> {
    return this.ledger!.status(Date.now(), thresholdsFromEnv(this.env))
  }
}

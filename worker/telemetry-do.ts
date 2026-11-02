import { DurableObject } from 'cloudflare:workers'
import type { ClientEvent, TelemetrySummary } from '../shared/telemetry.ts'
import type { Env } from './app.ts'
import { EventRateLimit, TelemetryLedger, type TelemetryRecord } from './telemetry.ts'

const RECORD_KEY = 'telemetry'
/** Counters reach storage at most this long after they change (one write per burst, not per event) */
const SAVE_DELAY_MS = 30_000

/**
 * The deployment's telemetry counters (e11-t03): one object for everyone (`TELEMETRY_OBJECT`).
 * POST /api/events hands it each batch (`record`, which applies the per-client rate limit and
 * answers what it accepted); /admin reads `summary`. The arithmetic is TelemetryLedger
 * (telemetry.ts). Saves from its alarm, SAVE_DELAY_MS after the first change, so a busy minute
 * costs one storage write.
 */
export class TelemetryDO extends DurableObject<Env> {
  private ledger: TelemetryLedger | null = null
  private readonly limit = new EventRateLimit()
  private dirty = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<TelemetryRecord>(RECORD_KEY)
      this.ledger = new TelemetryLedger(stored ?? null)
    })
  }

  /** RPC from POST /api/events: counts what `client` may send now and answers it */
  async record(client: string, events: ClientEvent[]): Promise<ClientEvent[]> {
    const now = Date.now()
    const accepted = this.limit.take(client, events, now)
    if (accepted.length === 0) return accepted
    this.ledger!.add(accepted, now)
    if (!this.dirty) {
      this.dirty = true
      await this.ctx.storage.setAlarm(now + SAVE_DELAY_MS)
    }
    return accepted
  }

  /** RPC from GET /api/admin/summary */
  async summary(): Promise<TelemetrySummary> {
    return this.ledger!.summary(Date.now())
  }

  async alarm() {
    this.dirty = false
    await this.ctx.storage.put(RECORD_KEY, this.ledger!.record)
  }
}

import { DurableObject } from 'cloudflare:workers'
import type { ClientEvent, TelemetrySummary } from '../shared/telemetry.ts'
import type { Env } from './app.ts'
import { TelemetryStore } from './telemetry.ts'

/**
 * The deployment's telemetry counters (e11-t03): one object for everyone (`TELEMETRY_OBJECT`).
 * POST /api/events hands it each batch (`record`, which applies the per-client rate limit, stores
 * the counters and answers what it accepted); /admin reads `summary`. The arithmetic is
 * TelemetryLedger, the storage rule TelemetryStore (telemetry.ts): every batch is written before
 * the answer, because this object may leave memory seconds after the last request.
 */
export class TelemetryDO extends DurableObject<Env> {
  private store: TelemetryStore | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.store = await TelemetryStore.load(ctx.storage)
    })
  }

  /** RPC from POST /api/events: counts what `client` may send now and answers it */
  async record(client: string, events: ClientEvent[]): Promise<ClientEvent[]> {
    return this.store!.record(client, events, Date.now())
  }

  /** RPC from GET /api/admin/summary */
  async summary(): Promise<TelemetrySummary> {
    return this.store!.summary(Date.now())
  }

  /**
   * Objects deployed before the write-through fix may still have their old save alarm pending;
   * there is nothing left to save (and the stored record is newer than anything it knew)
   */
  async alarm() {}
}

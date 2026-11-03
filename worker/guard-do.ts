import { DurableObject } from 'cloudflare:workers'
import type { AbuseSummary, BlockEntry, OffenceKind } from '../shared/abuse.ts'
import type { Env } from './app.ts'
import { GuardStore, type CreateDecision } from './guard.ts'

/**
 * The abuse guard (I1, e11-t05): one object for the whole deployment (`GUARD_OBJECT`). POST
 * /api/rooms asks it before each room (`create`, the worldwide creation limit); the Worker reads
 * the blocklist from it every half minute at most (`blocked`); rooms and the Worker tell it who
 * hit a limit (`note`); /admin lists and edits the blocklist. The rules: GuardStore (guard.ts).
 */
export class GuardDO extends DurableObject<Env> {
  private store: GuardStore | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.store = await GuardStore.load(ctx.storage)
    })
  }

  async create(key: string): Promise<CreateDecision> {
    return this.store!.create(key, Date.now())
  }

  async note(key: string, kind: OffenceKind): Promise<void> {
    await this.store!.note(key, kind, Date.now())
  }

  async blocked(): Promise<string[]> {
    return this.store!.blocked(Date.now())
  }

  async block(key: string, hours: number, note: string): Promise<BlockEntry> {
    return this.store!.block(key, hours, note, Date.now())
  }

  async unblock(key: string): Promise<boolean> {
    return this.store!.unblock(key, Date.now())
  }

  async summary(): Promise<Pick<AbuseSummary, 'blocks' | 'offenders'>> {
    return this.store!.summary(Date.now())
  }
}

import { DurableObject } from 'cloudflare:workers'
import type { FilesStatus } from '../shared/files.ts'
import type { Env } from './app.ts'
import { FileLedger, type LedgerRecord, type ReserveDecision } from './file-ledger.ts'

const RECORD_KEY = 'ledger'

/**
 * What the upload bucket holds (I5, e11-t08): one object for the whole deployment
 * (`FILE_LEDGER_OBJECT`). The Worker reserves before an upload and commits after it; the sweep
 * replaces the count with what the bucket lists. Writes through, like GuardDO: the object may
 * leave memory seconds after its last request. The rules: FileLedger (file-ledger.ts).
 */
export class FileLedgerDO extends DurableObject<Env> {
  private ledger: FileLedger | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.ledger = new FileLedger((await ctx.storage.get<LedgerRecord>(RECORD_KEY)) ?? null)
    })
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put(RECORD_KEY, this.ledger!.record)
  }

  async reserve(id: string, bytes: number): Promise<ReserveDecision> {
    const decision = this.ledger!.reserve(id, bytes, Date.now())
    if (decision.ok) await this.save()
    return decision
  }

  async commit(id: string, bytes: number, objects: number): Promise<void> {
    this.ledger!.commit(id, bytes, objects)
    await this.save()
  }

  async release(id: string): Promise<void> {
    this.ledger!.release(id)
    await this.save()
  }

  async forget(ids: string[], bytes: number, objects: number): Promise<void> {
    this.ledger!.forget(ids, bytes, objects)
    await this.save()
  }

  async reconcile(
    live: { bytes: number; objects: number },
    deleted: { objects: number; bytes: number },
  ): Promise<void> {
    this.ledger!.reconcile(live, deleted, Date.now())
    await this.save()
  }

  async backupDone(backup: NonNullable<FilesStatus['backup']>): Promise<void> {
    this.ledger!.backupDone(backup)
    await this.save()
  }

  async status(): Promise<Omit<FilesStatus, 'backups'>> {
    return this.ledger!.status(Date.now())
  }
}

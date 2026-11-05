import { BACKUP_HOUR_UTC, BACKUP_STALE_MS, type FilesStatus } from '../shared/files.ts'
import { writeBackup } from './backup.ts'
import { sweepUploads } from './sweep.ts'
import { FILE_LEDGER_OBJECT } from './file-ledger.ts'
import type { Env } from './app.ts'

// The hourly Cron Trigger (I5, e11-t08; wrangler.jsonc, production only). Each hour: expired
// uploads leave R2 and the count is put right. Once a day: D1 goes to the backup bucket. The sweep
// is also what an upload starts when none ran for a while (worker/files.ts), so a preview without
// a cron, or a cron that stopped, still deletes what expired.

/** What the runs need of FileLedgerDO */
export interface LedgerDeps {
  reconcile(
    live: { bytes: number; objects: number },
    deleted: { objects: number; bytes: number },
  ): Promise<void>
  backupDone(backup: NonNullable<FilesStatus['backup']>): Promise<void>
  status(): Promise<Pick<FilesStatus, 'backup'>>
}

/** The sweep and the count, once. Nothing to do without the bucket */
export async function runSweep(
  env: Pick<Env, 'FILES_BUCKET'>,
  ledger: Pick<LedgerDeps, 'reconcile'>,
  now: number,
): Promise<void> {
  if (!env.FILES_BUCKET) return
  const { live, deleted } = await sweepUploads(env.FILES_BUCKET, now)
  await ledger.reconcile(live, deleted)
}

/**
 * Whether this run backs up: in the backup hour, or whenever the last one is older than
 * BACKUP_STALE_MS, so a failed run is made up for within the hour instead of a day later
 */
export function backupDue(now: number, last: number | null): boolean {
  if (new Date(now).getUTCHours() === BACKUP_HOUR_UTC) return true
  return last === null || now - last >= BACKUP_STALE_MS
}

/** One cron run. A failing part does not stop the other; the run still fails, so the log says so */
export async function runScheduled(
  env: Pick<Env, 'FILES_BUCKET' | 'BACKUPS_BUCKET' | 'DB'>,
  ledger: LedgerDeps,
  now: number,
): Promise<void> {
  const failures: unknown[] = []
  try {
    await runSweep(env, ledger, now)
  } catch (error) {
    console.error('upload sweep failed', error)
    failures.push(error)
  }
  if (env.BACKUPS_BUCKET && env.DB) {
    try {
      const { backup } = await ledger.status()
      if (backupDue(now, backup?.at ?? null)) {
        await ledger.backupDone(await writeBackup(env.DB, env.BACKUPS_BUCKET, now))
      }
    } catch (error) {
      console.error('D1 backup failed', error)
      failures.push(error)
    }
  }
  if (failures.length > 0) throw failures[0]
}

/** The Worker's `scheduled` handler */
export function handleScheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
  const ledger = env.FILE_LEDGER.get(env.FILE_LEDGER.idFromName(FILE_LEDGER_OBJECT))
  ctx.waitUntil(runScheduled(env, ledger, event.scheduledTime))
}

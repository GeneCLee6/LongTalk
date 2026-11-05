import {
  GLOBAL_FILE_CAP_BYTES,
  LAZY_SWEEP_AFTER_MS,
  UPLOAD_FINISH_MS,
  UPLOAD_START_MS,
  type FilesStatus,
} from '../shared/files.ts'

// What the upload bucket holds (I5, e11-t08) without the runtime: a running count, what uploads
// under way have been promised, and the global cap (shared/files.ts). The hourly sweep lists the
// bucket and replaces the count with what is really there, so a crash between an upload and its
// count, or a deletion that failed, is put right within the hour.

/** The one FileLedgerDO, by name */
export const FILE_LEDGER_OBJECT = 'files'

/** A reservation lapses if its upload neither finished nor gave up by then */
const RESERVATION_MS = UPLOAD_START_MS + UPLOAD_FINISH_MS

export type LedgerRecord = {
  bytes: number
  objects: number
  reservations: Record<string, { bytes: number; until: number }>
  sweep: FilesStatus['sweep']
  backup: FilesStatus['backup']
  /** When an upload last asked for a sweep, so only one does */
  sweepAskedAt: number | null
}

export const emptyLedger = (): LedgerRecord => ({
  bytes: 0,
  objects: 0,
  reservations: {},
  sweep: null,
  backup: null,
  sweepAskedAt: null,
})

export type ReserveDecision =
  | {
      ok: true
      /** No sweep for a while (a preview, or the cron stopped): the caller should start one */
      sweepDue: boolean
    }
  | { ok: false }

export class FileLedger {
  record: LedgerRecord
  private readonly capBytes: number

  constructor(stored: LedgerRecord | null, capBytes = GLOBAL_FILE_CAP_BYTES) {
    this.record = stored ?? emptyLedger()
    this.capBytes = capBytes
  }

  private reserved(now: number): number {
    let total = 0
    for (const [id, reservation] of Object.entries(this.record.reservations)) {
      if (reservation.until <= now) delete this.record.reservations[id]
      else total += reservation.bytes
    }
    return total
  }

  /** Promises `bytes` to an upload, or refuses: the cap counts what is stored and what is coming */
  reserve(id: string, bytes: number, now: number): ReserveDecision {
    if (this.record.bytes + this.reserved(now) + bytes > this.capBytes) return { ok: false }
    this.record.reservations[id] = { bytes, until: now + RESERVATION_MS }
    const last = Math.max(this.record.sweep?.at ?? 0, this.record.sweepAskedAt ?? 0)
    const sweepDue = now - last >= LAZY_SWEEP_AFTER_MS
    if (sweepDue) this.record.sweepAskedAt = now
    return { ok: true, sweepDue }
  }

  /** The upload reached R2: `bytes` in `objects` objects move from promised to stored */
  commit(id: string, bytes: number, objects: number): void {
    delete this.record.reservations[id]
    this.record.bytes += bytes
    this.record.objects += objects
  }

  /** The upload failed or was cancelled */
  release(id: string): void {
    delete this.record.reservations[id]
  }

  /** A closed room deleted its files */
  forget(ids: readonly string[], bytes: number, objects: number): void {
    for (const id of ids) delete this.record.reservations[id]
    this.record.bytes = Math.max(0, this.record.bytes - bytes)
    this.record.objects = Math.max(0, this.record.objects - objects)
  }

  /** The sweep listed the bucket: what is really there, and what it deleted */
  reconcile(
    live: { bytes: number; objects: number },
    deleted: { objects: number; bytes: number },
    now: number,
  ): void {
    this.record.bytes = live.bytes
    this.record.objects = live.objects
    this.record.sweep = { at: now, deletedObjects: deleted.objects, deletedBytes: deleted.bytes }
  }

  backupDone(backup: NonNullable<FilesStatus['backup']>): void {
    this.record.backup = backup
  }

  status(now: number): Omit<FilesStatus, 'backups'> {
    return {
      bytes: this.record.bytes,
      objects: this.record.objects,
      reservedBytes: this.reserved(now),
      capBytes: this.capBytes,
      sweep: this.record.sweep,
      backup: this.record.backup,
    }
  }
}

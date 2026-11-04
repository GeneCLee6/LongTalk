// Where a local recording goes while it is made (I4, e8-t01): every few seconds MediaRecorder
// hands over a chunk, which is written to IndexedDB at once and let go, so an hour of video never
// sits in memory and a crash or a reload loses only the last few seconds. When the recording
// stops, the file is put together from the stored chunks (a Blob of IndexedDB-backed Blobs: the
// browser streams it from disk) and downloaded. A recording left behind (the tab closed or
// crashed) is offered on the next visit: 「下載上次未完成的錄影」.
//
// The logic works on a small backend (`SegmentBackend`): IndexedDB in the browser, a Map in tests.
import { markPending } from './pending.ts'
import { fixDuration } from './webmDuration.ts'

export { PENDING_KEY, recordingPending } from './pending.ts'

/** What is kept about one recording */
export interface RecordingMeta {
  id: string
  roomId: string
  roomName: string
  /** When it started (epoch ms) */
  startedAt: number
  /** The last chunk written: a recording whose tab is gone stops getting newer */
  updatedAt: number
  mimeType: string
  fileName: string
  /** Chunks written, and their bytes */
  chunks: number
  bytes: number
  /** It stopped and its file was handed to the browser's download: kept a little, then deleted */
  downloaded: boolean
}

export interface StoredChunk {
  recordingId: string
  seq: number
  blob: Blob
}

/** The storage under the store */
export interface SegmentBackend {
  putMeta(meta: RecordingMeta): Promise<void>
  getMeta(id: string): Promise<RecordingMeta | null>
  allMeta(): Promise<RecordingMeta[]>
  putChunk(chunk: StoredChunk): Promise<void>
  /** Every chunk of the recording, in `seq` order */
  chunks(recordingId: string): Promise<Blob[]>
  /** The recording and all its chunks */
  remove(id: string): Promise<void>
}

/**
 * A recording still being made in some tab writes a chunk every RECORDER_TIMESLICE_MS; one that
 * has not for this long was left behind (its tab closed or crashed)
 */
export const LEFT_BEHIND_MS = 60_000

/** How long a downloaded recording's chunks stay (the browser may still be reading the file) */
export const DOWNLOADED_KEEP_MS = 5 * 60_000

export class RecordingStore {
  private readonly backend: SegmentBackend
  private readonly now: () => number

  constructor(backend: SegmentBackend, now: () => number = Date.now) {
    this.backend = backend
    this.now = now
  }

  /** Starts a recording's record (no chunks yet) */
  async create(
    meta: Omit<RecordingMeta, 'updatedAt' | 'chunks' | 'bytes' | 'downloaded'>,
  ): Promise<RecordingMeta> {
    const full: RecordingMeta = {
      ...meta,
      updatedAt: this.now(),
      chunks: 0,
      bytes: 0,
      downloaded: false,
    }
    await this.backend.putMeta(full)
    markPending(true)
    return full
  }

  /** Writes the next chunk; the caller keeps no reference to it afterwards */
  async append(meta: RecordingMeta, blob: Blob): Promise<RecordingMeta> {
    await this.backend.putChunk({ recordingId: meta.id, seq: meta.chunks, blob })
    const next: RecordingMeta = {
      ...meta,
      chunks: meta.chunks + 1,
      bytes: meta.bytes + blob.size,
      updatedAt: this.now(),
    }
    await this.backend.putMeta(next)
    return next
  }

  /**
   * The whole file, from the stored chunks; a WebM is given its length (`durationMs`), which
   * MediaRecorder leaves out (webmDuration.ts)
   */
  async file(meta: RecordingMeta, type: string, durationMs = 0): Promise<Blob> {
    const chunks = await fixDuration(await this.backend.chunks(meta.id), meta.mimeType, durationMs)
    return new Blob(chunks, { type })
  }

  /** The file went to the download: its chunks go after DOWNLOADED_KEEP_MS (cleanUp) */
  async markDownloaded(meta: RecordingMeta): Promise<void> {
    await this.backend.putMeta({ ...meta, downloaded: true, updatedAt: this.now() })
  }

  async remove(id: string): Promise<void> {
    await this.backend.remove(id)
    await this.refreshPending()
  }

  /**
   * Recordings left behind: not downloaded, with something in them, and not being made by any
   * tab now. `held` is the recordings whose tab holds their lock (heldRecordings, the Web Locks
   * API); where that is unknown (null), one with no chunk for LEFT_BEHIND_MS. Newest first.
   */
  async leftovers(held: readonly string[] | null): Promise<RecordingMeta[]> {
    const now = this.now()
    return (await this.backend.allMeta())
      .filter(
        (meta) =>
          !meta.downloaded &&
          meta.chunks > 0 &&
          (held === null ? now - meta.updatedAt >= LEFT_BEHIND_MS : !held.includes(meta.id)),
      )
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * Deletes what is no longer needed: downloaded recordings after DOWNLOADED_KEEP_MS, and empty
   * ones left behind. Clears the pending flag when nothing is left.
   */
  async cleanUp(): Promise<void> {
    const now = this.now()
    for (const meta of await this.backend.allMeta()) {
      const stale = now - meta.updatedAt
      if (
        (meta.downloaded && stale >= DOWNLOADED_KEEP_MS) ||
        (meta.chunks === 0 && stale >= LEFT_BEHIND_MS)
      ) {
        await this.backend.remove(meta.id)
      }
    }
    await this.refreshPending()
  }

  private async refreshPending(): Promise<void> {
    markPending((await this.backend.allMeta()).length > 0)
  }
}

/** The Web Lock a tab holds while it makes a recording (so another tab knows it is not left behind) */
const lockName = (id: string) => `longtalk.recording.${id}`

interface LockManagerLike {
  request(name: string, callback: () => Promise<void>): Promise<unknown>
  query(): Promise<{ held?: { name?: string }[] }>
}

const locks = (): LockManagerLike | null =>
  (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks ?? null

/** Holds the recording's lock until the returned function is called (nothing without Web Locks) */
export function holdRecording(id: string): () => void {
  const manager = locks()
  if (!manager) return () => {}
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  void manager.request(lockName(id), () => held).catch(() => {})
  return release
}

/** The recordings some tab is making now, by their locks; null without Web Locks */
export async function heldRecordings(): Promise<string[] | null> {
  const manager = locks()
  if (!manager) return null
  try {
    const { held = [] } = await manager.query()
    const prefix = lockName('')
    return held.flatMap((lock) =>
      lock.name?.startsWith(prefix) ? [lock.name.slice(prefix.length)] : [],
    )
  } catch {
    return null
  }
}

/** A Map in memory (tests) */
export class MemoryBackend implements SegmentBackend {
  readonly metas = new Map<string, RecordingMeta>()
  readonly stored = new Map<string, StoredChunk[]>()

  async putMeta(meta: RecordingMeta) {
    this.metas.set(meta.id, { ...meta })
  }
  async getMeta(id: string) {
    return this.metas.get(id) ?? null
  }
  async allMeta() {
    return [...this.metas.values()].map((meta) => ({ ...meta }))
  }
  async putChunk(chunk: StoredChunk) {
    const list = this.stored.get(chunk.recordingId) ?? []
    list.push(chunk)
    this.stored.set(chunk.recordingId, list)
  }
  async chunks(recordingId: string) {
    return (this.stored.get(recordingId) ?? [])
      .toSorted((a, b) => a.seq - b.seq)
      .map((chunk) => chunk.blob)
  }
  async remove(id: string) {
    this.metas.delete(id)
    this.stored.delete(id)
  }
}

const DB_NAME = 'longtalk-recordings'
const DB_VERSION = 1
const META = 'recordings'
const CHUNKS = 'chunks'

const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })

const committed = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'))
  })

/** IndexedDB: one store of RecordingMeta by id, one of chunks by [recordingId, seq] */
export class IndexedDbBackend implements SegmentBackend {
  private readonly db: IDBDatabase

  private constructor(db: IDBDatabase) {
    this.db = db
  }

  static open(factory: IDBFactory = indexedDB): Promise<IndexedDbBackend> {
    const request = factory.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CHUNKS)) {
        db.createObjectStore(CHUNKS, { keyPath: ['recordingId', 'seq'] })
      }
    }
    return done(request).then((db) => new IndexedDbBackend(db))
  }

  private async write(stores: string[], work: (tx: IDBTransaction) => void): Promise<void> {
    const tx = this.db.transaction(stores, 'readwrite')
    work(tx)
    await committed(tx)
  }

  putMeta(meta: RecordingMeta) {
    return this.write([META], (tx) => tx.objectStore(META).put(meta))
  }
  async getMeta(id: string) {
    const meta = await done(this.db.transaction(META).objectStore(META).get(id))
    return (meta as RecordingMeta | undefined) ?? null
  }
  async allMeta() {
    return (await done(this.db.transaction(META).objectStore(META).getAll())) as RecordingMeta[]
  }
  putChunk(chunk: StoredChunk) {
    return this.write([CHUNKS], (tx) => tx.objectStore(CHUNKS).put(chunk))
  }
  async chunks(recordingId: string) {
    const range = IDBKeyRange.bound([recordingId, 0], [recordingId, Number.MAX_SAFE_INTEGER])
    const rows = (await done(
      this.db.transaction(CHUNKS).objectStore(CHUNKS).getAll(range),
    )) as StoredChunk[]
    // The key orders them by seq already
    return rows.map((row) => row.blob)
  }
  remove(id: string) {
    return this.write([META, CHUNKS], (tx) => {
      tx.objectStore(META).delete(id)
      tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
    })
  }
}

/** The browser's store (IndexedDB) */
export async function openRecordingStore(): Promise<RecordingStore> {
  return new RecordingStore(await IndexedDbBackend.open())
}

/**
 * Hands a file to the browser's download (an <a download> on an object URL), then lets the URL
 * go once the download has had time to start
 */
export function downloadFile(blob: Blob, fileName: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob)
  const link = doc.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  doc.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Downloads a recording left behind and marks it downloaded (the recovery offer) */
export async function downloadLeftover(store: RecordingStore, meta: RecordingMeta): Promise<void> {
  // Its length as far as we know: until the last chunk written
  const blob = await store.file(meta, meta.mimeType.split(';')[0], meta.updatedAt - meta.startedAt)
  downloadFile(blob, meta.fileName)
  await store.markDownloaded(meta)
}

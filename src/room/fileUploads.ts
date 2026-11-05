import { checkUpload, type UploadRequest } from '../../shared/files.ts'
import type { FilesApi, RunningPut, UploadProblem } from '../api/files.ts'

// The uploads a member has running (I5, e5-t05), one at a time so a phone on a thin connection
// does not split it: checks first (a refused file fails at once, no request), then a grant, the
// thumbnail, the bytes. No React and no DOM, so Vitest runs it directly; useFileSharing shows it.
// A finished upload just leaves the list: the room's chat message is what everyone sees, us too.

export type UploadItem = {
  key: number
  name: string
  size: number
  /** 0 to 1, of the file's bytes */
  progress: number
  state: 'queued' | 'uploading' | 'failed'
  problem: UploadProblem | null
  /** How long to wait (`rate_limited`), in seconds */
  retryAfter: number | null
}

type Entry = { item: UploadItem; file: File }

export type MakeThumbnail = (file: File) => Promise<Blob | null>

export class FileUploads {
  private readonly api: FilesApi
  private readonly thumbnail: MakeThumbnail
  private entries: Entry[] = []
  private snapshot: readonly UploadItem[] = []
  private nextKey = 1
  private running: { key: number; id: string | null; put: RunningPut | null } | null = null
  private readonly listeners = new Set<() => void>()

  constructor(api: FilesApi, thumbnail: MakeThumbnail) {
    this.api = api
    this.thumbnail = thumbnail
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  items = (): readonly UploadItem[] => this.snapshot

  private changed(): void {
    this.snapshot = this.entries.map((entry) => entry.item)
    for (const listener of this.listeners) listener()
  }

  private update(key: number, change: Partial<UploadItem>): void {
    this.entries = this.entries.map((entry) =>
      entry.item.key === key ? { ...entry, item: { ...entry.item, ...change } } : entry,
    )
    this.changed()
  }

  /** The member picked files: each is refused at once if it has to be, the rest queue */
  add(files: readonly File[]): void {
    for (const file of files) {
      const checked = checkUpload({ name: file.name, size: file.size, type: file.type })
      this.entries.push({
        file,
        item: {
          key: this.nextKey++,
          name: checked.ok ? checked.file.name : file.name,
          size: file.size,
          progress: 0,
          state: checked.ok ? 'queued' : 'failed',
          problem: checked.ok ? null : checked.code,
          retryAfter: null,
        },
      })
    }
    this.changed()
    void this.pump()
  }

  /** Stops an upload (or takes a waiting one off the list) */
  cancel(key: number): void {
    if (this.running?.key === key) {
      const { id, put } = this.running
      this.running = null
      put?.abort()
      if (id) this.api.abandon(id)
    }
    this.dismiss(key)
    void this.pump()
  }

  retry(key: number): void {
    this.update(key, { state: 'queued', problem: null, retryAfter: null, progress: 0 })
    void this.pump()
  }

  dismiss(key: number): void {
    this.entries = this.entries.filter((entry) => entry.item.key !== key)
    this.changed()
  }

  private async pump(): Promise<void> {
    if (this.running) return
    const next = this.entries.find((entry) => entry.item.state === 'queued')
    if (!next) return
    const { key } = next.item
    const run = { key, id: null as string | null, put: null as RunningPut | null }
    this.running = run
    this.update(key, { state: 'uploading', progress: 0 })
    const stillRunning = () => this.running === run
    let problem: { problem: UploadProblem; retryAfter?: number } | null = null
    try {
      problem = await this.upload(next.file, key, run, stillRunning)
    } catch {
      problem = { problem: 'network' }
    }
    if (!stillRunning()) return
    this.running = null
    if (problem) {
      // The grant holds a place in the limits until it lapses: give it back
      if (run.id) this.api.abandon(run.id)
      this.update(key, {
        state: 'failed',
        problem: problem.problem,
        retryAfter: problem.retryAfter ?? null,
      })
    } else {
      this.dismiss(key)
    }
    void this.pump()
  }

  private async upload(
    file: File,
    key: number,
    run: { id: string | null; put: RunningPut | null },
    stillRunning: () => boolean,
  ): Promise<{ problem: UploadProblem; retryAfter?: number } | null> {
    const thumb = await this.thumbnail(file).catch(() => null)
    if (!stillRunning()) return null
    const meta: UploadRequest = {
      name: file.name,
      size: file.size,
      type: file.type,
      thumb: thumb !== null,
    }
    const granted = await this.api.request(meta)
    if (!stillRunning()) {
      if (granted.ok) this.api.abandon(granted.grant.id)
      return null
    }
    if (!granted.ok) return { problem: granted.problem, retryAfter: granted.retryAfter }
    const { id } = granted.grant
    run.id = id
    if (thumb) {
      // A thumbnail that fails only costs the preview: the image still opens from its card
      run.put = this.api.put(id, 'thumb', thumb, () => {})
      await run.put.done
      if (!stillRunning()) return null
    }
    run.put = this.api.put(id, 'file', file, (progress) => {
      if (stillRunning()) this.update(key, { progress })
    })
    const result = await run.put.done
    if (!stillRunning()) return null
    return result.ok ? null : { problem: result.problem, retryAfter: result.retryAfter }
  }

  /** The room is being left: nothing goes on in the background */
  stop(): void {
    if (this.running) {
      const { id, put } = this.running
      this.running = null
      put?.abort()
      if (id) this.api.abandon(id)
    }
    this.entries = []
    this.changed()
  }
}

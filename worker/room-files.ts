import {
  FILE_TTL_MS,
  MAX_THUMB_BYTES,
  MEMBER_FILE_LIMIT,
  ROOM_FILE_LIMIT,
  UPLOAD_FINISH_MS,
  UPLOAD_START_MS,
  newFileId,
  thumbKey,
  uploadKey,
  type ChatFile,
  type CheckedFile,
} from '../shared/files.ts'

// A room's files (I5, e5-t05) without the runtime: who has which file and upload, the member's and
// the room's limits, the grants. RoomHost asks who the member is and what their role allows; this
// is what comes after. The bytes never come near a room: the Worker streams them to R2.

/** What a room remembers of a stored file; `ChatFile` is what members see of it */
export type StoredFile = ChatFile & { key: string; from: string }

/** An upload that may start (`claimed` null) or has started */
export type Grant = {
  id: string
  from: string
  key: string
  name: string
  size: number
  mime: string
  /** When it was granted: the file's 24 hours and its key's hour count from here */
  at: number
  /** The file's bytes are on their way, since this time */
  claimed: number | null
  /** A thumbnail was announced; has its one PUT been used; did it reach R2 */
  thumb: boolean
  thumbClaimed: boolean
  thumbStored: boolean
}

export type FilesState = { files: StoredFile[]; grants: Grant[] }

export type GrantRequest = CheckedFile & { thumb: boolean }

export type GrantDecision =
  | { ok: true; id: string; expiresAt: number }
  | { ok: false; reason: 'unauthorized' | 'forbidden' | 'member_quota' | 'room_quota' }

export type UploadClaim =
  | { ok: true; key: string; name: string; mime: string; size: number }
  | {
      ok: false
      /** `not_found`: no such grant, someone else's, used up or expired; `wrong_size`: not as announced */
      reason: 'unauthorized' | 'forbidden' | 'not_found' | 'wrong_size'
    }

export type FileAccess =
  | { ok: true; key: string; name: string; mime: string; kind: ChatFile['kind']; thumb: boolean }
  | { ok: false; reason: 'unauthorized' | 'forbidden' | 'not_found' | 'expired' }

/** What is left to clean up when the room closes */
export type FilesGone = { keys: string[]; grants: string[]; bytes: number }

export class RoomFiles {
  private files: StoredFile[]
  private grants: Grant[]

  constructor(state?: FilesState | null) {
    this.files = state?.files ?? []
    this.grants = state?.grants ?? []
  }

  get state(): FilesState {
    return { files: this.files, grants: this.grants }
  }

  /** A grant, or which limit it would break. What is stored and on its way both count */
  grant(from: string, request: GrantRequest, now: number): GrantDecision {
    this.prune(now)
    const all = [...this.files, ...this.grants]
    const mine = all.filter((file) => file.from === from)
    const total = (list: readonly { size: number }[]) =>
      list.reduce((sum, file) => sum + file.size, 0)
    if (
      mine.length >= MEMBER_FILE_LIMIT.files ||
      total(mine) + request.size > MEMBER_FILE_LIMIT.bytes
    ) {
      return { ok: false, reason: 'member_quota' }
    }
    if (all.length >= ROOM_FILE_LIMIT.files || total(all) + request.size > ROOM_FILE_LIMIT.bytes) {
      return { ok: false, reason: 'room_quota' }
    }
    const id = newFileId()
    this.grants.push({
      id,
      from,
      key: uploadKey(now, id),
      name: request.name,
      size: request.size,
      mime: request.mime,
      at: now,
      claimed: null,
      thumb: request.thumb,
      thumbClaimed: false,
      thumbStored: false,
    })
    return { ok: true, id, expiresAt: now + FILE_TTL_MS }
  }

  /** Uses the grant up for one PUT: the file once with exactly its size, the thumbnail once */
  claim(from: string, id: string, part: 'file' | 'thumb', bytes: number, now: number): UploadClaim {
    this.prune(now)
    const grant = this.grants.find((g) => g.id === id && g.from === from)
    if (!grant || grant.claimed !== null) return { ok: false, reason: 'not_found' }
    if (part === 'thumb') {
      if (!grant.thumb || grant.thumbClaimed) return { ok: false, reason: 'not_found' }
      if (bytes > MAX_THUMB_BYTES) return { ok: false, reason: 'wrong_size' }
      grant.thumbClaimed = true
      return { ok: true, key: thumbKey(grant.key), name: grant.name, mime: '', size: bytes }
    }
    if (bytes !== grant.size) return { ok: false, reason: 'wrong_size' }
    grant.claimed = now
    return { ok: true, key: grant.key, name: grant.name, mime: grant.mime, size: grant.size }
  }

  thumbStored(from: string, id: string): boolean {
    const grant = this.grants.find((g) => g.id === id && g.from === from)
    if (!grant || !grant.thumbClaimed) return false
    grant.thumbStored = true
    return true
  }

  /** The grant becomes a file. Null when there is no such upload under way */
  finish(
    from: string,
    id: string,
    stored: { kind: ChatFile['kind']; mime: string },
  ): ChatFile | null {
    const index = this.grants.findIndex(
      (g) => g.id === id && g.from === from && g.claimed !== null,
    )
    if (index < 0) return null
    const [grant] = this.grants.splice(index, 1)
    const file: ChatFile = {
      id,
      name: grant.name,
      size: grant.size,
      mime: stored.mime,
      kind: stored.kind,
      thumb: stored.kind === 'image' && grant.thumbStored,
      expiresAt: grant.at + FILE_TTL_MS,
    }
    this.files.push({ ...file, key: grant.key, from })
    return file
  }

  /** Forgets one of the member's uploads. False when there is none */
  abort(id: string, from: string): boolean {
    const before = this.grants.length
    this.grants = this.grants.filter((g) => !(g.id === id && g.from === from))
    return this.grants.length !== before
  }

  access(id: string, now: number): FileAccess {
    const file = this.files.find((f) => f.id === id)
    if (!file) return { ok: false, reason: 'not_found' }
    if (file.expiresAt <= now) return { ok: false, reason: 'expired' }
    return {
      ok: true,
      key: file.key,
      name: file.name,
      mime: file.mime,
      kind: file.kind,
      thumb: file.thumb,
    }
  }

  /** The room closed: everything goes, and what must leave R2 and the ledger is handed back */
  takeAll(): FilesGone {
    const keys: string[] = []
    let bytes = 0
    for (const file of this.files) {
      keys.push(file.key)
      if (file.thumb) keys.push(thumbKey(file.key))
      bytes += file.size
    }
    // A grant may have stored its thumbnail already. An upload still running when the room closes
    // is refused at its end, and the Worker deletes what it stored
    for (const grant of this.grants) if (grant.thumbClaimed) keys.push(thumbKey(grant.key))
    const grants = this.grants.map((grant) => grant.id)
    this.files = []
    this.grants = []
    return { keys, grants, bytes }
  }

  /** Expired files stop counting (the sweep deletes them); grants nobody used or finished go */
  private prune(now: number): void {
    this.files = this.files.filter((file) => file.expiresAt > now)
    this.grants = this.grants.filter((grant) =>
      grant.claimed === null
        ? now - grant.at < UPLOAD_START_MS
        : now - grant.claimed < UPLOAD_FINISH_MS,
    )
  }
}

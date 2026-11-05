import {
  UPLOAD_STALL_MS,
  filePath,
  filesPath,
  thumbPath,
  type ChatFile,
  type UploadGrant,
  type UploadRefusal,
  type UploadRequest,
} from '../../shared/files.ts'

// The browser's side of /api/files (I5, e5-t05; worker/files.ts): every call carries the member's
// session token, so a file can only be fetched, never opened by following a link.

/** Why an upload stopped: what the Worker said, or what happened on the way */
export type UploadProblem = UploadRefusal | 'network' | 'stalled'

export type GrantResult =
  | { ok: true; grant: UploadGrant }
  | { ok: false; problem: UploadProblem; retryAfter?: number }

export type PutResult = { ok: true } | { ok: false; problem: UploadProblem; retryAfter?: number }

export type RunningPut = { done: Promise<PutResult>; abort(): void }

/** What the uploader needs (a fake in tests) */
export interface FilesApi {
  request(meta: UploadRequest): Promise<GrantResult>
  /** The bytes, with progress from 0 to 1; a stalled connection fails after UPLOAD_STALL_MS */
  put(id: string, part: 'file' | 'thumb', body: Blob, onProgress: (done: number) => void): RunningPut
  /** Gives up on an upload not finished, so its place in the limits comes back at once */
  abandon(id: string): void
}

const KNOWN: ReadonlySet<string> = new Set<UploadRefusal>([
  'too_large',
  'empty',
  'blocked_type',
  'not_an_image',
  'member_quota',
  'room_quota',
  'rate_limited',
  'storage_full',
  'unauthorized',
  'forbidden',
  'blocked',
  'unavailable',
  'incomplete',
  'bad_request',
])

/** The refusal in an answer's body; anything else (a proxy's page, a crash) is `unavailable` */
function refusal(text: string): { problem: UploadProblem; retryAfter?: number } {
  try {
    const body = JSON.parse(text) as { error?: unknown; retryAfter?: unknown }
    if (typeof body.error === 'string' && KNOWN.has(body.error)) {
      const retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : undefined
      return { problem: body.error as UploadRefusal, retryAfter }
    }
  } catch {
    // Not JSON
  }
  return { problem: 'unavailable' }
}

export function filesApi(roomId: string, token: () => string | null): FilesApi {
  const auth = (): Record<string, string> => {
    const value = token()
    return value ? { authorization: `Bearer ${value}` } : {}
  }
  return {
    async request(meta) {
      try {
        const res = await fetch(filesPath(roomId), {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify(meta),
        })
        if (res.ok) return { ok: true, grant: (await res.json()) as UploadGrant }
        return { ok: false, ...refusal(await res.text()) }
      } catch {
        return { ok: false, problem: 'network' }
      }
    },
    put(id, part, body, onProgress) {
      // XMLHttpRequest, not fetch: only it reports upload progress everywhere
      const xhr = new XMLHttpRequest()
      let finish: (result: PutResult) => void = () => {}
      const done = new Promise<PutResult>((resolve) => {
        finish = resolve
      })
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const settle = (result: PutResult) => {
        clearTimeout(watchdog)
        finish(result)
      }
      const watch = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => {
          // In this order: abort() fires onabort at once, and the first answer stands
          settle({ ok: false, problem: 'stalled' })
          xhr.abort()
        }, UPLOAD_STALL_MS)
      }
      xhr.open('PUT', part === 'thumb' ? thumbPath(roomId, id) : filePath(roomId, id))
      for (const [name, value] of Object.entries(auth())) xhr.setRequestHeader(name, value)
      xhr.upload.onprogress = (event) => {
        watch()
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
      }
      // The last byte is out; R2 may still need a moment before the answer
      xhr.upload.onload = () => clearTimeout(watchdog)
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) settle({ ok: true })
        else settle({ ok: false, ...refusal(xhr.responseText) })
      }
      xhr.onerror = () => settle({ ok: false, problem: 'network' })
      xhr.onabort = () => settle({ ok: false, problem: 'network' })
      xhr.send(body)
      watch()
      return { done, abort: () => xhr.abort() }
    },
    abandon(id) {
      void fetch(filePath(roomId, id), { method: 'DELETE', headers: auth() }).catch(() => {})
    },
  }
}

/** A file's bytes as a Blob: `gone` when it expired, `failed` for the rest (retry may help) */
export async function fetchFile(
  roomId: string,
  file: Pick<ChatFile, 'id'>,
  thumb: boolean,
  token: string | null,
): Promise<Blob> {
  const path = thumb ? thumbPath(roomId, file.id) : filePath(roomId, file.id)
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  if (res.status === 410 || res.status === 404) throw new Error('gone')
  if (!res.ok) throw new Error('failed')
  return res.blob()
}

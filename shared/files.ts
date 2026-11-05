// Files in chat (I5, e5-t05, e5-t06, e11-t08): the rules the Worker (which decides) and the browser
// (which checks first so a refused file fails at once) share. The numbers and why they are what
// they are: shared/file-limits.ts.
//
// Why the Worker carries the upload (docs/PRD/e5-chat-reactions-interaction.md has the comparison):
// the R2 binding needs no API credentials, no bucket CORS rule and no CSP change.
import {
  BACKUP_RETENTION_DAYS,
  FILE_TTL_MS,
  MAX_FILE_BYTES,
} from './file-limits.ts'

export * from './file-limits.ts'

/** A thumbnail's longest side in pixels (the chat shows it at most 240 CSS px wide, at 2×) */
export const THUMB_SIDE_PX = 480
/** A stored file's name, in characters (code points) */
export const MAX_FILE_NAME_CHARS = 120

/** An upload must start this soon after its grant */
export const UPLOAD_START_MS = 2 * 60_000
/** A started upload must finish this soon (25 MB at about 128 kbit/s; slower fails clearly) */
export const UPLOAD_FINISH_MS = 30 * 60_000
/** The browser gives up when no byte went out for this long (a dead mobile connection) */
export const UPLOAD_STALL_MS = 60_000

/** The hourly cron (wrangler.jsonc) */
export const SWEEP_CRON = '0 * * * *'
/** Past this without a sweep, the next upload starts one (previews have no cron; a cron can fail) */
export const LAZY_SWEEP_AFTER_MS = 2 * 60 * 60_000
/** The daily D1 backup runs in this UTC hour (02:00 in Taiwan), or the next hour after a failure */
export const BACKUP_HOUR_UTC = 18
/** Past this without a backup, the next run makes one whatever the hour, and /admin warns */
export const BACKUP_STALE_MS = 26 * 60 * 60_000

/** Where uploads live in the bucket; the hour in the key is what the sweep goes by */
export const UPLOAD_PREFIX = 'uploads/'
export const BACKUP_PREFIX = 'd1/'

export const FILES_API = '/api/files'

export const filesPath = (roomId: string) => `${FILES_API}/${encodeURIComponent(roomId)}`
export const filePath = (roomId: string, id: string) => `${filesPath(roomId)}/${id}`
export const thumbPath = (roomId: string, id: string) => `${filePath(roomId, id)}/thumb`

/** A file as a chat message carries it. `mime` for images is what the Worker found in the bytes */
export type ChatFile = {
  id: string
  name: string
  size: number
  mime: string
  /** `image`: its bytes are PNG, JPEG, GIF or WebP, and members see it in the chat */
  kind: 'image' | 'file'
  /** A thumbnail was stored with it */
  thumb: boolean
  /** Until when it can be downloaded (ms since the epoch, the server's clock) */
  expiresAt: number
}

/** POST /api/files/<room>: what the browser wants to upload */
export type UploadRequest = { name: string; size: number; type: string; thumb: boolean }
/** …and what it gets: where to send the bytes, and until when they are kept */
export type UploadGrant = { id: string; expiresAt: number }

/**
 * Why an upload was refused (the `error` of the answer; the browser's text for each is in the
 * dictionaries):
 * - `too_large`, `empty`, `blocked_type`, `not_an_image`: the file itself
 * - `member_quota`, `room_quota`: the member's or the room's limit (429)
 * - `rate_limited`: this network's limit (429 with `retryAfter`)
 * - `storage_full`: the global cap (507)
 * - `unauthorized`: not a member of the room (401); `forbidden`: in the waiting room, or removed
 * - `blocked`: this network is on the blocklist
 * - `unavailable`: files are not set up here, or something behind the Worker failed (503)
 * - `incomplete`: the bytes stopped early or did not match what was announced
 */
export type UploadRefusal =
  | 'too_large'
  | 'empty'
  | 'blocked_type'
  | 'not_an_image'
  | 'member_quota'
  | 'room_quota'
  | 'rate_limited'
  | 'storage_full'
  | 'unauthorized'
  | 'forbidden'
  | 'blocked'
  | 'unavailable'
  | 'incomplete'
  | 'bad_request'

/** What /admin shows (GET /api/admin/summary, `files`) */
export type FilesStatus = {
  bytes: number
  objects: number
  /** Promised to uploads still running */
  reservedBytes: number
  capBytes: number
  /** The last sweep: when, how many objects and bytes it deleted (null before the first) */
  sweep: { at: number; deletedObjects: number; deletedBytes: number } | null
  /** The last D1 backup: when, its key, gzipped size and rows (null before the first) */
  backup: { at: number; key: string; bytes: number; rows: number } | null
  /** Whether this deployment has a backup bucket (previews have none) */
  backups: boolean
}

// ── Names ──

// Control characters, bidirectional overrides and marks, zero-width joiners and the BOM: a name
// that renders as something else (`exe.pdf` from `fdp.exe` with an override) is the classic trick
const UNSAFE_NAME_CHARS = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu
// Path separators and what Windows refuses in a name
const RESERVED_NAME_CHARS = /[/\\<>:"|?*]/g

/**
 * A name safe to store, show and hand to a file system: no path, no control characters, no
 * leading dots, no trailing dots or spaces (Windows drops those, so `a.exe.` would be `a.exe`),
 * at most MAX_FILE_NAME_CHARS with the extension kept. Never empty.
 */
export function sanitizeFileName(raw: unknown): string {
  if (typeof raw !== 'string') return 'file'
  const parts = raw.replace(UNSAFE_NAME_CHARS, '').split(/[/\\]/)
  const cleaned = parts[parts.length - 1]
    .replace(RESERVED_NAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (cleaned === '') return 'file'
  const chars = [...cleaned]
  if (chars.length <= MAX_FILE_NAME_CHARS) return cleaned
  const extension = fileExtension(cleaned)
  const tail = extension && extension.length <= 16 ? `.${extension}` : ''
  const kept = chars.slice(0, MAX_FILE_NAME_CHARS - [...tail].length).join('')
  return `${kept.replace(/[.\s]+$/, '')}${tail}`
}

/** The lower-case extension without its dot, or '' */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** `text/plain; charset=x` → `text/plain`; '' for anything that is not a plain MIME type */
export function normalizeMime(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const mime = raw.split(';')[0].trim().toLowerCase()
  return /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/.test(mime) ? mime : ''
}

// ── What may be uploaded ──

/**
 * Refused by extension: what runs when it is opened (programs, installers, scripts, shortcuts,
 * disk images that carry them), and what runs in a browser (HTML, SVG, XML with scripts). Office
 * files stay allowed: everyone in a meeting expects to share them, and they download as files.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    'exe com bat cmd msi msp mst scr pif cpl dll sys drv ocx gadget ' +
    'ps1 ps2 psm1 psd1 vbs vbe js jse mjs cjs ts ws wsf wsc wsh hta jar jnlp class wasm ' +
    'lnk url scf reg inf desktop webloc command tool ' +
    'sh bash zsh csh ksh fish run bin elf app dmg pkg mpkg deb rpm appimage apk aab ipa xap ' +
    'iso img vhd vhdx ' +
    'html htm xhtml xht shtml mht mhtml svg svgz xml xsl xslt swf chm ' +
    'php phtml asp aspx jsp cgi pl py pyw rb lua'
  ).split(' '),
)

/** Refused by the type the browser says it is, whatever the name */
export const BLOCKED_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/wasm',
  'application/x-msdownload',
  'application/x-msi',
  'application/x-ms-installer',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-sh',
  'application/x-csh',
  'text/x-shellscript',
  'text/x-sh',
  'text/x-python',
  'application/x-python-code',
  'application/x-httpd-php',
  'application/hta',
  'application/java-archive',
  'application/java-vm',
  'application/vnd.android.package-archive',
  'application/x-apple-diskimage',
  'application/x-shockwave-flash',
  'application/x-iso9660-image',
])

/** The image types shown in the page: they cannot carry scripts as an <img> or an image document */
export const SAFE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp'])

export type FileProblem = Extract<
  UploadRefusal,
  'too_large' | 'empty' | 'blocked_type' | 'bad_request'
>

export type CheckedFile = { name: string; size: number; mime: string }

/**
 * The first check, on what was announced (no bytes yet): the size, the name's extension, the type.
 * The browser runs it before asking, the Worker again before granting and sniffs the bytes later.
 */
export function checkUpload(
  meta: Pick<UploadRequest, 'name' | 'size' | 'type'>,
): { ok: true; file: CheckedFile } | { ok: false; code: FileProblem } {
  if (!Number.isSafeInteger(meta.size) || meta.size < 0) return { ok: false, code: 'bad_request' }
  if (meta.size === 0) return { ok: false, code: 'empty' }
  if (meta.size > MAX_FILE_BYTES) return { ok: false, code: 'too_large' }
  const name = sanitizeFileName(meta.name)
  const mime = normalizeMime(meta.type)
  if (BLOCKED_EXTENSIONS.has(fileExtension(name)) || BLOCKED_MIME_TYPES.has(mime)) {
    return { ok: false, code: 'blocked_type' }
  }
  return { ok: true, file: { name, size: meta.size, mime } }
}

/** A request body to POST /api/files/<room>, or null */
export function parseUploadRequest(raw: unknown): UploadRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const body = raw as Record<string, unknown>
  if (typeof body.name !== 'string' || body.name.length > 1024) return null
  if (typeof body.size !== 'number') return null
  const type = typeof body.type === 'string' ? body.type : ''
  return { name: body.name, size: body.size, type, thumb: body.thumb === true }
}

// ── What the bytes are ──

/** The Worker reads this many bytes before it decides (and before any of them reach R2) */
export const SNIFF_BYTES = 4096

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0) =>
  head.length >= at + bytes.length && bytes.every((byte, index) => head[at + index] === byte)

const ascii = (head: Uint8Array, text: string, at = 0) =>
  startsWith(head, [...text].map((char) => char.charCodeAt(0)), at)

/** The safe image type these bytes are, or null */
export function sniffImage(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(head, 'GIF87a') || ascii(head, 'GIF89a')) return 'image/gif'
  if (ascii(head, 'RIFF') && ascii(head, 'WEBP', 8)) return 'image/webp'
  return null
}

/** A Windows program: `MZ` and the PE header it points at (a text starting with MZ is fine) */
function isPortableExecutable(head: Uint8Array): boolean {
  if (!ascii(head, 'MZ')) return false
  // A real program is never this short. A pointer past what was read counts as one: rare in text
  if (head.length < 0x40) return false
  const at = head[0x3c] | (head[0x3d] << 8) | (head[0x3e] << 16) | (head[0x3f] << 24)
  if (at < 0 || at + 4 > head.length) return true
  return ascii(head, 'PE\0\0', at)
}

const MARKUP =
  /^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]|<svg[\s>]|<\?xml\b[^>]*>\s*(?:<!doctype\s+svg|<svg|<html))/i

/**
 * What must not be uploaded whatever its name says: programs (PE, ELF, Mach-O, Java class), scripts
 * (a `#!` line), and pages (HTML, SVG), also behind a byte-order mark or white space.
 */
export function sniffForbidden(head: Uint8Array): boolean {
  if (isPortableExecutable(head)) return true
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return true
  for (const magic of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ]) {
    if (startsWith(head, magic)) return true
  }
  if (ascii(head, '#!')) return true
  // Text in the first bytes, as a browser's own sniffer would read it: latin1 keeps the markup
  // ASCII whatever the rest is, and UTF-16 only needs its zero bytes dropped
  const utf16 =
    startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])
      ? head.filter((byte) => byte !== 0)
      : head
  let text = ''
  for (const byte of utf16.subarray(0, 1024)) text += String.fromCharCode(byte)
  const trimmed = text.replace(/^(?:\xEF\xBB\xBF|\xFF\xFE|\xFE\xFF)/, '').trimStart()
  return MARKUP.test(trimmed)
}

/** Whether the name or type says this is one of the image types shown in the page */
export function claimsImage(name: string, mime: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(name)) || SAFE_IMAGE_TYPES.has(mime)
}

/**
 * The verdict on the first bytes. An image is what the bytes say, whatever the name said (a PNG
 * called .jpg is a PNG). Anything claiming to be an image that is not is refused. Everything else
 * is an opaque file: served only as a download, `application/octet-stream`.
 */
export function classifyUpload(
  file: Pick<CheckedFile, 'name' | 'mime'>,
  head: Uint8Array,
):
  | { ok: true; kind: ChatFile['kind']; mime: string }
  | { ok: false; code: 'blocked_type' | 'not_an_image' } {
  const image = sniffImage(head)
  if (image) return { ok: true, kind: 'image', mime: image }
  if (sniffForbidden(head)) return { ok: false, code: 'blocked_type' }
  if (claimsImage(file.name, file.mime)) return { ok: false, code: 'not_an_image' }
  return { ok: true, kind: 'file', mime: file.mime }
}

// ── Keys ──

/** A new file's id: 128 random bits, base64url (unguessable, and safe in a URL and a key) */
export function newFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const isFileId = (value: string): boolean => /^[A-Za-z0-9_-]{22}$/.test(value)

/** `uploads/2026-11-05T13/<id>`: the hour an upload started, so the key alone tells its age */
export function uploadKey(at: number, id: string): string {
  return `${UPLOAD_PREFIX}${new Date(at).toISOString().slice(0, 13)}/${id}`
}

export const thumbKey = (key: string) => `${key}.thumb`

/** When an upload's key was made (the start of that hour), or null for a key of any other shape */
export function keyHour(key: string): number | null {
  const match = /^uploads\/(\d{4}-\d{2}-\d{2}T\d{2})\//.exec(key)
  if (!match) return null
  const at = Date.parse(`${match[1]}:00:00.000Z`)
  return Number.isNaN(at) ? null : at
}

/**
 * Whether the sweep deletes this key: every file of its hour is past FILE_TTL_MS, so the hour has
 * to be over by a full FILE_TTL_MS. An hourly sweep deletes a file 24 to 25 hours after it started.
 */
export function uploadExpired(key: string, now: number): boolean {
  const hour = keyHour(key)
  return hour !== null && hour + 60 * 60_000 + FILE_TTL_MS <= now
}

/** `d1/2026-11-05.jsonl.gz` */
export const backupKey = (at: number) =>
  `${BACKUP_PREFIX}${new Date(at).toISOString().slice(0, 10)}.jsonl.gz`

/** Whether a backup's key is older than BACKUP_RETENTION_DAYS (the day's backup counts as today) */
export function backupExpired(key: string, now: number): boolean {
  const match = /^d1\/(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(key)
  if (!match) return false
  const day = Date.parse(`${match[1]}T00:00:00.000Z`)
  if (Number.isNaN(day)) return false
  return Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`) - day >=
    BACKUP_RETENTION_DAYS * 24 * 60 * 60_000
}

/** A Content-Disposition with both forms of the name (RFC 6266): ASCII and UTF-8 */
export function contentDisposition(name: string, inline: boolean): string {
  const fallback = sanitizeFileName(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\%;]/g, '_')
  const encoded = encodeURIComponent(sanitizeFileName(name)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

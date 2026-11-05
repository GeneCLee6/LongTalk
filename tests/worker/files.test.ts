// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../shared/abuse.ts'
import {
  FILE_TTL_MS,
  GLOBAL_FILE_CAP_BYTES,
  MAX_FILE_BYTES,
  MAX_THUMB_BYTES,
  MEMBER_FILE_LIMIT,
  NETWORK_UPLOAD_LIMITS,
  ROOM_FILE_LIMIT,
  UPLOAD_FINISH_MS,
  UPLOAD_START_MS,
  checkUpload,
  classifyUpload,
  contentDisposition,
  filePath,
  filesPath,
  keyHour,
  sanitizeFileName,
  sniffForbidden,
  sniffImage,
  thumbPath,
  uploadExpired,
  uploadKey,
  type ChatFile,
} from '../../shared/files.ts'
import { CloseCode, PROTOCOL_VERSION, type ServerMessage } from '../../shared/protocol.ts'
import { FILE_CSP } from '../../shared/security-headers.ts'
import { resetAbuseState, type GuardDeps } from '../../worker/abuse.ts'
import { FileLedger } from '../../worker/file-ledger.ts'
import { handleFiles, type FileLedgerRpc, type FileRoom } from '../../worker/files.ts'
import { RoomFiles } from '../../worker/room-files.ts'
import { RoomHost } from '../../worker/room-host.ts'
import { asBucket, chunkedBody, fakeFixedLength, FakeBucket, png } from './files.fakes.ts'

const encode = (text: string) => new TextEncoder().encode(text)
const MB = 1024 * 1024

describe('what may be uploaded (e5-t05)', () => {
  it('cleans names: no paths, controls, overrides, leading or trailing dots', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf')
    expect(sanitizeFileName('.htaccess')).toBe('htaccess')
    expect(sanitizeFileName('a.exe.')).toBe('a.exe')
    expect(sanitizeFileName('a.exe   ')).toBe('a.exe')
    expect(sanitizeFileName('photo\u202Egnp.exe')).toBe('photognp.exe')
    expect(sanitizeFileName('a\nb\tc.txt')).toBe('abc.txt')
    expect(sanitizeFileName('a<b>:"|?*.txt')).toBe('ab.txt')
    expect(sanitizeFileName('會議 紀錄.pdf')).toBe('會議 紀錄.pdf')
    expect(sanitizeFileName('...')).toBe('file')
    expect(sanitizeFileName(5)).toBe('file')
    const long = sanitizeFileName(`${'x'.repeat(300)}.pdf`)
    expect([...long]).toHaveLength(120)
    expect(long.endsWith('.pdf')).toBe(true)
  })

  it('refuses by size, extension (any case, after cleaning) and declared type', () => {
    const check = (name: string, size = 10, type = '') => checkUpload({ name, size, type })
    expect(check('a.pdf', 10, 'application/pdf')).toEqual({
      ok: true,
      file: { name: 'a.pdf', size: 10, mime: 'application/pdf' },
    })
    expect(check('a.pdf', 0)).toEqual({ ok: false, code: 'empty' })
    expect(check('a.pdf', -1)).toEqual({ ok: false, code: 'bad_request' })
    expect(check('a.pdf', MAX_FILE_BYTES)).toMatchObject({ ok: true })
    expect(check('a.pdf', MAX_FILE_BYTES + 1)).toEqual({ ok: false, code: 'too_large' })
    for (const name of [
      'a.exe',
      'A.EXE',
      'a.exe.',
      'b.bat',
      'c.ps1',
      'd.js',
      'e.html',
      'f.HTM',
      'g.svg',
      'h.sh',
      'i.apk',
      'j.jar',
      'k.lnk',
      'l.iso',
    ]) {
      expect(check(name), name).toEqual({ ok: false, code: 'blocked_type' })
    }
    for (const type of [
      'text/html',
      'text/html; charset=utf-8',
      'IMAGE/SVG+XML',
      'application/x-msdownload',
      'application/javascript',
    ]) {
      expect(check('a.txt', 10, type), type).toEqual({ ok: false, code: 'blocked_type' })
    }
    for (const name of ['a.pdf', 'a.docx', 'a.xlsx', 'a.zip', 'a.png', 'a.mp4', 'noextension']) {
      expect(check(name), name).toMatchObject({ ok: true })
    }
  })

  it('knows the safe images by their bytes', () => {
    expect(sniffImage(png())).toBe('image/png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(encode('GIF89a...'))).toBe('image/gif')
    expect(sniffImage(encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(encode('<svg></svg>'))).toBeNull()
    expect(sniffImage(new Uint8Array(0))).toBeNull()
  })

  it('finds programs, scripts and pages whatever the name says', () => {
    const pe = new Uint8Array(512)
    pe.set(encode('MZ'))
    pe[0x3c] = 0x80
    pe.set(encode('PE\0\0'), 0x80)
    for (const [what, head] of [
      ['PE', pe],
      ['ELF', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2])],
      ['Mach-O', new Uint8Array([0xcf, 0xfa, 0xed, 0xfe])],
      ['shebang', encode('#!/bin/sh\necho hi')],
      ['html', encode('<!DOCTYPE html><html>')],
      ['html with space', encode('  \n <html lang="en">')],
      ['html with BOM', new Uint8Array([0xef, 0xbb, 0xbf, ...encode('<html>')])],
      ['html in UTF-16', new Uint8Array([0xff, 0xfe, ...[...encode('<html>')].flatMap((b) => [b, 0])])],
      ['script', encode('<script>alert(1)</script>')],
      ['svg', encode('<svg xmlns="http://www.w3.org/2000/svg">')],
      ['xml svg', encode('<?xml version="1.0"?>\n<svg>')],
    ] as const) {
      expect(sniffForbidden(head), what).toBe(true)
    }
    for (const [what, head] of [
      ['text', encode('Hello <html> is a tag')],
      ['MZ text', encode('MZ is a company')],
      ['pdf', encode('%PDF-1.7')],
      ['zip', new Uint8Array([0x50, 0x4b, 3, 4])],
      ['xml data', encode('<?xml version="1.0"?><data/>')],
    ] as const) {
      expect(sniffForbidden(head), what).toBe(false)
    }
  })

  it('decides from the bytes: an image is what they say, a claim they do not back is refused', () => {
    const as = (name: string, mime: string, head: Uint8Array) =>
      classifyUpload({ name, mime }, head)
    expect(as('a.png', 'image/png', png())).toEqual({ ok: true, kind: 'image', mime: 'image/png' })
    // A PNG named .pdf is shown as the PNG it is
    expect(as('a.pdf', 'application/pdf', png())).toMatchObject({ kind: 'image', mime: 'image/png' })
    expect(as('a.png', 'image/png', encode('not an image'))).toEqual({
      ok: false,
      code: 'not_an_image',
    })
    expect(as('a.txt', 'image/jpeg', encode('not an image'))).toEqual({
      ok: false,
      code: 'not_an_image',
    })
    // A page under a harmless name
    expect(as('a.txt', 'text/plain', encode('<html><script>x</script>'))).toEqual({
      ok: false,
      code: 'blocked_type',
    })
    expect(as('a.pdf', 'application/pdf', encode('%PDF'))).toEqual({
      ok: true,
      kind: 'file',
      mime: 'application/pdf',
    })
    // HEIC and TIFF are not shown in the page: plain files
    expect(as('a.heic', 'image/heic', encode('....ftypheic'))).toMatchObject({ kind: 'file' })
  })

  it('writes Content-Disposition with both forms of the name, nothing that can break out', () => {
    expect(contentDisposition('a.pdf', false)).toBe(
      `attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`,
    )
    expect(contentDisposition('照片.png', true)).toBe(
      `inline; filename="__.png"; filename*=UTF-8''%E7%85%A7%E7%89%87.png`,
    )
    const evil = contentDisposition('a"; x=y\r\nSet-Cookie: b.pdf', false)
    expect(evil).not.toMatch(/[\r\n]/)
    expect(evil.startsWith('attachment; filename="a_ x=ySet-Cookie b.pdf"')).toBe(true)
  })
})

describe('keys and expiry (e11-t08)', () => {
  const at = Date.UTC(2026, 10, 5, 13, 59, 30)

  it('puts the hour in the key', () => {
    expect(uploadKey(at, 'abc')).toBe('uploads/2026-11-05T13/abc')
    expect(keyHour('uploads/2026-11-05T13/abc')).toBe(Date.UTC(2026, 10, 5, 13))
    expect(keyHour('uploads/2026-11-05T13/abc.thumb')).toBe(Date.UTC(2026, 10, 5, 13))
    expect(keyHour('elsewhere/abc')).toBeNull()
    expect(keyHour('uploads/nonsense/abc')).toBeNull()
  })

  it('expires a key only once all of its hour is past 24 hours', () => {
    const key = uploadKey(at, 'abc')
    expect(uploadExpired(key, at + FILE_TTL_MS)).toBe(false)
    expect(uploadExpired(key, Date.UTC(2026, 10, 6, 13, 59, 59))).toBe(false)
    expect(uploadExpired(key, Date.UTC(2026, 10, 6, 14))).toBe(true)
    // Keys of any other shape are never touched
    expect(uploadExpired('elsewhere/abc', at + 10 * FILE_TTL_MS)).toBe(false)
  })
})

describe('RoomFiles: the member and room limits', () => {
  const file = (size: number) => ({ name: 'a.pdf', size, mime: 'application/pdf', thumb: false })

  it('holds the member limit in files and in bytes', () => {
    const files = new RoomFiles()
    for (let i = 0; i < MEMBER_FILE_LIMIT.files; i++) {
      expect(files.grant('a', file(1), 0).ok).toBe(true)
    }
    expect(files.grant('a', file(1), 0)).toEqual({ ok: false, reason: 'member_quota' })
    expect(files.grant('b', file(1), 0).ok).toBe(true)

    const bytes = new RoomFiles()
    const big = MEMBER_FILE_LIMIT.bytes / 6
    for (let i = 0; i < 6; i++) expect(bytes.grant('a', file(big), 0).ok).toBe(true)
    expect(bytes.grant('a', file(1), 0)).toEqual({ ok: false, reason: 'member_quota' })
  })

  it('holds the room limit in files and in bytes', () => {
    const files = new RoomFiles()
    for (let i = 0; i < ROOM_FILE_LIMIT.files; i++) {
      expect(files.grant(`m${i}`, file(1), 0).ok).toBe(true)
    }
    expect(files.grant('z', file(1), 0)).toEqual({ ok: false, reason: 'room_quota' })

    const bytes = new RoomFiles()
    const big = 25 * MB
    for (let i = 0; i < ROOM_FILE_LIMIT.bytes / big; i++) {
      expect(bytes.grant(`m${i}`, file(big), 0).ok).toBe(true)
    }
    expect(bytes.grant('z', file(1), 0)).toEqual({ ok: false, reason: 'room_quota' })
  })

  it('frees the limits when a file expires, an unused grant lapses or an upload is given up', () => {
    const files = new RoomFiles()
    for (let i = 0; i < MEMBER_FILE_LIMIT.files; i++) files.grant('a', file(1), 0)
    expect(files.grant('a', file(1), UPLOAD_START_MS - 1).ok).toBe(false)
    expect(files.grant('a', file(1), UPLOAD_START_MS).ok).toBe(true)

    const claimed = new RoomFiles()
    const grant = claimed.grant('a', file(1), 0)
    if (!grant.ok) throw new Error('refused')
    expect(claimed.claim('a', grant.id, 'file', 1, 10).ok).toBe(true)
    // Started: it may take its time, up to UPLOAD_FINISH_MS
    claimed.grant('b', file(1), UPLOAD_FINISH_MS)
    expect(claimed.state.grants.map((g) => g.id)).toContain(grant.id)
    claimed.grant('b', file(1), UPLOAD_FINISH_MS + 10)
    expect(claimed.state.grants.map((g) => g.id)).not.toContain(grant.id)

    const given = new RoomFiles()
    const up = given.grant('a', file(1), 0)
    if (!up.ok) throw new Error('refused')
    expect(given.abort(up.id, 'b')).toBe(false)
    expect(given.abort(up.id, 'a')).toBe(true)
    expect(given.state.grants).toEqual([])
  })

  it('a grant is single use, bound to its member and to its announced size', () => {
    const files = new RoomFiles()
    const grant = files.grant('a', file(100), 0)
    if (!grant.ok) throw new Error('refused')
    expect(files.claim('b', grant.id, 'file', 100, 1)).toEqual({ ok: false, reason: 'not_found' })
    expect(files.claim('a', grant.id, 'file', 101, 1)).toEqual({ ok: false, reason: 'wrong_size' })
    expect(files.claim('a', grant.id, 'file', 100, 1).ok).toBe(true)
    expect(files.claim('a', grant.id, 'file', 100, 2)).toEqual({ ok: false, reason: 'not_found' })
    expect(files.claim('a', 'other', 'file', 100, 2)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('stops a file 24 hours after its upload started', () => {
    const files = new RoomFiles()
    const grant = files.grant('a', file(1), 1000)
    if (!grant.ok) throw new Error('refused')
    files.claim('a', grant.id, 'file', 1, 2000)
    files.finish('a', grant.id, { kind: 'file', mime: '' })
    expect(files.access(grant.id, 1000 + FILE_TTL_MS - 1).ok).toBe(true)
    expect(files.access(grant.id, 1000 + FILE_TTL_MS)).toEqual({ ok: false, reason: 'expired' })
    expect(files.access('other', 1)).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('FileLedger: the global cap', () => {
  it('refuses above the cap, counting what is stored and what is on its way', () => {
    const ledger = new FileLedger(null, 100)
    expect(ledger.reserve('a', 60, 0).ok).toBe(true)
    expect(ledger.reserve('b', 40, 0).ok).toBe(true)
    expect(ledger.reserve('c', 1, 0).ok).toBe(false)
    ledger.commit('a', 60, 1)
    expect(ledger.status(0)).toMatchObject({ bytes: 60, objects: 1, reservedBytes: 40 })
    expect(ledger.reserve('c', 1, 0).ok).toBe(false)
    ledger.release('b')
    expect(ledger.reserve('c', 40, 0).ok).toBe(true)
    expect(ledger.reserve('d', 1, 0).ok).toBe(false)
  })

  it('has the promised number as its default', () => {
    expect(new FileLedger(null).status(0).capBytes).toBe(GLOBAL_FILE_CAP_BYTES)
    expect(GLOBAL_FILE_CAP_BYTES).toBe(2 * 1024 * MB)
  })

  it('a reservation an upload never used lapses', () => {
    const ledger = new FileLedger(null, 100)
    ledger.reserve('a', 100, 0)
    expect(ledger.reserve('b', 1, 1).ok).toBe(false)
    expect(ledger.reserve('b', 1, UPLOAD_START_MS + UPLOAD_FINISH_MS).ok).toBe(true)
  })

  it('reconcile replaces a count that drifted with what the bucket holds', () => {
    const ledger = new FileLedger(null, 100)
    ledger.reserve('a', 90, 0)
    ledger.commit('a', 90, 1) // and say the object never reached R2
    expect(ledger.reserve('b', 20, 1).ok).toBe(false)
    ledger.reconcile({ bytes: 5, objects: 1 }, { bytes: 0, objects: 0 }, 2)
    expect(ledger.status(2)).toMatchObject({
      bytes: 5,
      objects: 1,
      sweep: { at: 2, deletedObjects: 0, deletedBytes: 0 },
    })
    expect(ledger.reserve('b', 20, 3).ok).toBe(true)
  })

  it('asks for a sweep when none ran for a while, once', () => {
    const ledger = new FileLedger(null, 1000)
    const hour = 60 * 60_000
    const t = 10 * hour
    expect(ledger.reserve('a', 1, t)).toEqual({ ok: true, sweepDue: true })
    expect(ledger.reserve('b', 1, t + 1)).toEqual({ ok: true, sweepDue: false })
    ledger.reconcile({ bytes: 0, objects: 0 }, { bytes: 0, objects: 0 }, t + 2)
    expect(ledger.reserve('c', 1, t + hour)).toEqual({ ok: true, sweepDue: false })
    expect(ledger.reserve('d', 1, t + 2 + 2 * hour)).toEqual({ ok: true, sweepDue: true })
  })
})

// ── The routes, against RoomHost itself and a bucket in memory ──

const ROOM = 'k7pq2x9m4a'
const NOW = Date.UTC(2026, 10, 5, 13, 30)

class Harness {
  now = NOW
  readonly bucket = new FakeBucket()
  readonly ledger = new FileLedger(null, GLOBAL_FILE_CAP_BYTES)
  readonly sent = new Map<string, ServerMessage[]>()
  readonly limited: string[] = []
  guardRefuses = false
  ledgerFails = false
  readonly waited: Promise<unknown>[] = []
  readonly gone: unknown[] = []
  readonly host = new RoomHost({
    sockets: {
      send: (conn, message) => {
        this.sent.set(conn, [...(this.sent.get(conn) ?? []), message])
      },
      close: () => {},
    },
    storage: {
      saveRoom: () => {},
      saveRev: () => {},
      saveSessions: () => {},
      saveUsage: () => {},
      saveSchedule: () => {},
      saveChat: () => {},
      dropChat: () => {},
      saveBans: () => {},
      savePassword: () => {},
      saveGuesses: () => {},
      saveEnded: () => {},
      clear: () => {},
    },
    now: () => this.now,
    newMemberId: (() => {
      let n = 0
      return () => `m${++n}`
    })(),
    newToken: (() => {
      let n = 0
      return () => `${String(++n).padStart(2, '0')}`.padEnd(43, 'x')
    })(),
    filesGone: (gone) => this.gone.push(gone),
  })

  readonly guard = {
    limit: async (kind: string, key: string) => {
      this.limited.push(`${kind}:${key}`)
      return this.guardRefuses
        ? ({ ok: false, retryAfterMs: 90_000 } as const)
        : ({ ok: true } as const)
    },
    blocked: async () => [],
  } as unknown as GuardDeps

  readonly ledgerRpc: FileLedgerRpc = {
    reserve: async (id, bytes) => {
      if (this.ledgerFails) throw new Error('ledger down')
      return this.ledger.reserve(id, bytes, this.now)
    },
    commit: async (id, bytes, objects) => this.ledger.commit(id, bytes, objects),
    release: async (id) => this.ledger.release(id),
    reconcile: async (live, deleted) => this.ledger.reconcile(live, deleted, this.now),
  }

  constructor() {
    this.host.create({ id: ROOM, createdAt: NOW })
  }

  /** Someone joins; gives their session token */
  join(name: string): { token: string; conn: string } {
    const conn = `conn-${name}`
    expect(this.host.admit(String(PROTOCOL_VERSION), null).ok).toBe(true)
    this.host.opened(conn, null, null)
    void this.host.message(conn, JSON.stringify({ t: 'join', name, token: null }))
    const welcome = this.sent.get(conn)?.find((m) => m.t === 'welcome')
    if (welcome?.t !== 'welcome') throw new Error(`${name} got no welcome`)
    return { token: welcome.token, conn }
  }

  request(
    method: string,
    path: string,
    token: string | null,
    body?: BodyInit | ReadableStream<Uint8Array> | null,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const request = new Request(`https://longtalk.test${path}`, {
      method,
      body,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit)
    return handleFiles(
      request,
      { FILES_BUCKET: asBucket(this.bucket) },
      new URL(request.url),
      {
        guard: this.guard,
        room: () => this.room,
        ledger: this.ledgerRpc,
        waitUntil: (promise) => this.waited.push(promise),
        fixedLength: fakeFixedLength,
        now: () => this.now,
      },
    )
  }

  readonly room: FileRoom = {
    grantUpload: async (token, request) => this.host.grantUpload(token, request),
    claimUpload: async (token, id, part, bytes) => this.host.claimUpload(token, id, part, bytes),
    thumbStored: async (token, id) => this.host.thumbStored(token, id),
    finishUpload: async (token, id, stored) => this.host.finishUpload(token, id, stored),
    abortUpload: async (token, id) => this.host.abortUpload(token, id),
    fileAccess: async (token, id) => this.host.fileAccess(token, id),
  }

  grant(token: string, name: string, size: number, type = '', thumb = false) {
    return this.request(
      'POST',
      filesPath(ROOM),
      token,
      JSON.stringify({ name, size, type, thumb }),
    )
  }

  async upload(
    token: string,
    name: string,
    bytes: Uint8Array,
    type = '',
  ): Promise<{ response: Response; id: string }> {
    const granted = await this.grant(token, name, bytes.byteLength, type)
    expect(granted.status).toBe(201)
    const { id } = (await granted.json()) as { id: string }
    const response = await this.request('PUT', filePath(ROOM, id), token, bytes as BodyInit, {
      'content-length': String(bytes.byteLength),
    })
    return { response, id }
  }
}

describe('/api/files (e5-t05)', () => {
  let h: Harness
  beforeEach(() => {
    resetAbuseState()
    h = new Harness()
  })
  afterEach(() => vi.restoreAllMocks())

  it('a member uploads: bytes in R2 under the hour, everyone gets the file as a chat message', async () => {
    const alice = h.join('Alice')
    const bob = h.join('Bob')
    const bytes = encode('%PDF-1.7 hello')
    const { response, id } = await h.upload(alice.token, '../報告.pdf', bytes, 'application/pdf')
    expect(response.status).toBe(201)
    const file = (await response.json()) as ChatFile
    expect(file).toEqual({
      id,
      name: '報告.pdf',
      size: bytes.byteLength,
      mime: 'application/pdf',
      kind: 'file',
      thumb: false,
      expiresAt: NOW + FILE_TTL_MS,
    })
    const key = `uploads/2026-11-05T13/${id}`
    expect([...h.bucket.objects.keys()]).toEqual([key])
    expect(h.bucket.objects.get(key)!.bytes).toEqual(bytes)
    expect(h.bucket.objects.get(key)!.contentType).toBe('application/octet-stream')
    for (const who of [alice, bob]) {
      const chat = h.sent.get(who.conn)!.filter((m) => m.t === 'chat').at(-1)
      expect(chat).toMatchObject({
        t: 'chat',
        messages: [{ name: 'Alice', text: '報告.pdf', file }],
      })
    }
    expect(h.host.chatHistory.at(-1)?.file).toEqual(file)
    expect(h.ledger.status(NOW)).toMatchObject({ bytes: bytes.byteLength, objects: 1, reservedBytes: 0 })
  })

  it('stops at once when the body runs past what was announced, and stores nothing', async () => {
    const alice = h.join('Alice')
    const size = 8192
    const granted = await h.grant(alice.token, 'a.dat', size)
    const { id } = (await granted.json()) as { id: string }
    // A lying client: the header says 8 KB, the body keeps going
    const chunk = new Uint8Array(4096).fill(1)
    const body = chunkedBody(Array.from({ length: 2000 }, () => chunk))
    const response = await h.request('PUT', filePath(ROOM, id), alice.token, body.stream, {
      'content-length': String(size),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'incomplete' })
    expect(h.bucket.objects.size).toBe(0)
    // Failed at the first byte too many, not at the end of the 8 MB
    expect(body.sent()).toBeLessThan(20)
    expect(h.ledger.status(NOW).reservedBytes).toBe(0)
    expect(h.host.chatHistory).toEqual([])
  })

  it('refuses a body shorter than announced, stores nothing', async () => {
    const alice = h.join('Alice')
    const granted = await h.grant(alice.token, 'a.dat', 100)
    const { id } = (await granted.json()) as { id: string }
    const body = chunkedBody([new Uint8Array(50).fill(1)])
    const response = await h.request('PUT', filePath(ROOM, id), alice.token, body.stream, {
      'content-length': '100',
    })
    expect(response.status).toBe(400)
    expect(h.bucket.objects.size).toBe(0)
  })

  it('refuses a body with no Content-Length, or not what the grant said', async () => {
    const alice = h.join('Alice')
    const granted = await h.grant(alice.token, 'a.dat', 100)
    const { id } = (await granted.json()) as { id: string }
    const noLength = await h.request(
      'PUT',
      filePath(ROOM, id),
      alice.token,
      chunkedBody([new Uint8Array(100)]).stream,
    )
    expect(noLength.status).toBe(411)
    const wrong = await h.request('PUT', filePath(ROOM, id), alice.token, new Uint8Array(200), {
      'content-length': '200',
    })
    expect(wrong.status).toBe(400)
    // Asking for more than the limit never gets a grant
    const big = await h.grant(alice.token, 'a.dat', MAX_FILE_BYTES + 1)
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({ error: 'too_large' })
  })

  it('refuses a blocked type at the grant, and again if the bytes turn out to be one', async () => {
    const alice = h.join('Alice')
    expect((await h.grant(alice.token, 'a.exe', 10)).status).toBe(415)
    expect((await h.grant(alice.token, 'a.html', 10)).status).toBe(415)
    expect((await h.grant(alice.token, 'a.txt', 10, 'text/html')).status).toBe(415)
    const page = await h.upload(alice.token, 'notes.txt', encode('<html><script>x</script></html>'))
    expect(page.response.status).toBe(415)
    expect(await page.response.json()).toEqual({ error: 'blocked_type' })
    const fake = await h.upload(alice.token, 'photo.png', encode('this is not a picture'))
    expect(fake.response.status).toBe(415)
    expect(await fake.response.json()).toEqual({ error: 'not_an_image' })
    expect(h.bucket.objects.size).toBe(0)
    expect(h.ledger.status(NOW).reservedBytes).toBe(0)
    // Their places in the limits came back: nothing is left under way
    expect(h.host.chatHistory).toEqual([])
  })

  it('sniffs across a first chunk too small to tell', async () => {
    const alice = h.join('Alice')
    const whole = encode(`   <html>${'x'.repeat(100)}`)
    const granted = await h.grant(alice.token, 'a.txt', whole.byteLength)
    const { id } = (await granted.json()) as { id: string }
    const body = chunkedBody([whole.subarray(0, 3), whole.subarray(3, 5), whole.subarray(5)])
    const response = await h.request('PUT', filePath(ROOM, id), alice.token, body.stream, {
      'content-length': String(whole.byteLength),
    })
    expect(response.status).toBe(415)
  })

  it('only members: no token, an unknown token, the waiting room', async () => {
    const alice = h.join('Alice')
    expect((await h.request('POST', filesPath(ROOM), null, '{}')).status).toBe(401)
    const unknown = 'z'.repeat(43)
    expect((await h.grant(unknown, 'a.pdf', 10)).status).toBe(401)
    expect(h.limited).toEqual([])

    // Bob waits: he has a token, not a seat
    void h.host.message(
      alice.conn,
      JSON.stringify({ t: 'host', action: 'waitingRoom', on: true }),
    )
    const bobConn = 'conn-Bob'
    h.host.opened(bobConn, null, null)
    void h.host.message(bobConn, JSON.stringify({ t: 'join', name: 'Bob', token: null }))
    const lobby = h.sent.get(bobConn)?.find((m) => m.t === 'welcome' || m.t === 'lobby')
    expect(lobby?.t).toBe('lobby')
    const bobToken = lobby?.t === 'lobby' ? lobby.token : ''
    expect(bobToken).not.toBe('')
    const refused = await h.grant(bobToken, 'a.pdf', 10)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'forbidden' })

    const { id } = await h.upload(alice.token, 'a.pdf', encode('%PDF'))
    expect((await h.request('GET', filePath(ROOM, id), bobToken)).status).toBe(403)
    expect((await h.request('GET', filePath(ROOM, id), unknown)).status).toBe(401)
    expect((await h.request('GET', filePath(ROOM, id), null)).status).toBe(401)
    expect((await h.request('GET', filePath(ROOM, id), alice.token)).status).toBe(200)
  })

  it('another room’s member cannot fetch a file; ids that are not ours are 404', async () => {
    const alice = h.join('Alice')
    const { id } = await h.upload(alice.token, 'a.pdf', encode('%PDF'))
    const other = new Harness()
    const carol = other.join('Carol')
    other.bucket.objects.set('x', { bytes: new Uint8Array(1) })
    expect((await other.request('GET', filePath(ROOM, id), carol.token)).status).toBe(404)
    expect((await h.request('GET', `${filesPath(ROOM)}/nope`, alice.token)).status).toBe(404)
    expect((await h.request('GET', '/api/files/UPPER CASE', alice.token)).status).toBe(404)
  })

  it('someone else cannot use a grant, nor a member removed meanwhile finish one', async () => {
    const alice = h.join('Alice')
    const bob = h.join('Bob')
    const granted = await h.grant(bob.token, 'a.dat', 4)
    const { id } = (await granted.json()) as { id: string }
    const stolen = await h.request('PUT', filePath(ROOM, id), alice.token, new Uint8Array(4), {
      'content-length': '4',
    })
    expect(stolen.status).toBe(404)
    // Claimed, then the room forgets Bob before the bytes end
    const claim = h.host.claimUpload(bob.token, id, 'file', 4)
    expect(claim.ok).toBe(true)
    void h.host.message(
      alice.conn,
      JSON.stringify({ t: 'host', action: 'remove', memberId: 'm2' }),
    )
    expect(h.host.finishUpload(bob.token, id, { kind: 'file', mime: '' })).toBeNull()
    expect(h.host.chatHistory).toEqual([])
    expect(CloseCode.removed).toBeDefined()
  })

  it('serves a file so it can never run: attachment, octet-stream, nosniff, sandbox', async () => {
    const alice = h.join('Alice')
    const { id } = await h.upload(alice.token, '合約 v2.pdf', encode('%PDF'), 'application/pdf')
    const response = await h.request('GET', filePath(ROOM, id), alice.token)
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': '4',
      'x-content-type-options': 'nosniff',
      'content-security-policy': FILE_CSP,
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, no-store',
    })
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; /)
    expect(FILE_CSP).toContain('sandbox')
    expect(FILE_CSP).toContain("default-src 'none'")
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('%PDF')
  })

  it('serves only checked images inline, with the type their bytes say', async () => {
    const alice = h.join('Alice')
    const { id } = await h.upload(alice.token, 'photo.jpg', png(), 'image/jpeg')
    const response = await h.request('GET', filePath(ROOM, id), alice.token)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-disposition')).toMatch(/^inline; /)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe(FILE_CSP)
    expect((await h.upload(alice.token, 'a.txt', encode('hello'), 'text/plain')).response.status).toBe(
      201,
    )
  })

  it('thumbnails: must be small, must be a real image, once, and the message says there is one', async () => {
    const alice = h.join('Alice')
    const bytes = png(1024)
    const granted = await h.grant(alice.token, 'photo.png', bytes.byteLength, 'image/png', true)
    const { id } = (await granted.json()) as { id: string }
    const big = await h.request('PUT', thumbPath(ROOM, id), alice.token, new Uint8Array(MAX_THUMB_BYTES + 1), {
      'content-length': String(MAX_THUMB_BYTES + 1),
    })
    expect(big.status).toBe(413)
    const thumb = png(128)
    const ok = await h.request('PUT', thumbPath(ROOM, id), alice.token, thumb as BodyInit, {
      'content-length': '128',
    })
    expect(ok.status).toBe(201)
    const again = await h.request('PUT', thumbPath(ROOM, id), alice.token, thumb as BodyInit, {
      'content-length': '128',
    })
    expect(again.status).toBe(404)
    const put = await h.request('PUT', filePath(ROOM, id), alice.token, bytes as BodyInit, {
      'content-length': String(bytes.byteLength),
    })
    expect(put.status).toBe(201)
    expect(((await put.json()) as ChatFile).thumb).toBe(true)
    expect(h.ledger.status(NOW).objects).toBe(2)
    const served = await h.request('GET', thumbPath(ROOM, id), alice.token)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect((await served.arrayBuffer()).byteLength).toBe(128)

    const plain = await h.grant(alice.token, 'b.png', 8, 'image/png', true)
    const plainId = ((await plain.json()) as { id: string }).id
    const script = await h.request(
      'PUT',
      thumbPath(ROOM, plainId),
      alice.token,
      encode('<svg onload=x>') as BodyInit,
      { 'content-length': '14' },
    )
    expect(script.status).toBe(415)
    expect(h.bucket.objects.size).toBe(2)
  })

  it('a file past its 24 hours is gone for everyone, before the sweep deletes it', async () => {
    const alice = h.join('Alice')
    const { id } = await h.upload(alice.token, 'a.pdf', encode('%PDF'))
    h.now = NOW + FILE_TTL_MS - 1
    expect((await h.request('GET', filePath(ROOM, id), alice.token)).status).toBe(200)
    h.now = NOW + FILE_TTL_MS
    expect((await h.request('GET', filePath(ROOM, id), alice.token)).status).toBe(410)
  })

  it('answers 429 over the member limit, with nothing spent elsewhere', async () => {
    const alice = h.join('Alice')
    for (let i = 0; i < MEMBER_FILE_LIMIT.files; i++) {
      expect((await h.upload(alice.token, `f${i}.pdf`, encode('%PDF'))).response.status).toBe(201)
    }
    const refused = await h.grant(alice.token, 'one-more.pdf', 4)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'member_quota' })
  })

  it('answers 429 over the room limit', async () => {
    const big = 25 * MB
    const members = Array.from({ length: 5 }, (_, i) => h.join(`M${i}`))
    let refused: Response | null = null
    for (const member of members) {
      for (let i = 0; i < 6 && !refused; i++) {
        const granted = await h.grant(member.token, 'big.dat', big)
        if (granted.status !== 201) refused = granted
      }
    }
    expect(refused?.status).toBe(429)
    expect(await refused?.json()).toEqual({ error: 'room_quota' })
  })

  it('counts per network with GuardDO, and answers when to try again', async () => {
    const alice = h.join('Alice')
    expect(LIMITS.upload).toBe(NETWORK_UPLOAD_LIMITS)
    const headers = { 'cf-connecting-ip': '203.0.113.9' }
    const body = JSON.stringify({ name: 'a.pdf', size: 4, type: '', thumb: false })
    const ok = await h.request('POST', filesPath(ROOM), alice.token, body, headers)
    expect(ok.status).toBe(201)
    expect(h.limited).toHaveLength(1)
    expect(h.limited[0]).toMatch(/^upload:[0-9a-f]{24}$/)
    h.guardRefuses = true
    const refused = await h.request('POST', filesPath(ROOM), alice.token, body, headers)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('90')
    expect(await refused.json()).toEqual({ error: 'rate_limited', retryAfter: 90 })
  })

  it('refuses over the global cap with a clear answer, and fails closed if the cap is unknown', async () => {
    const alice = h.join('Alice')
    h.ledger.record.bytes = GLOBAL_FILE_CAP_BYTES - 3
    const full = await h.grant(alice.token, 'a.pdf', 4)
    expect(full.status).toBe(507)
    expect(await full.json()).toEqual({ error: 'storage_full' })
    expect(h.host.grantUpload(alice.token, { name: 'b', size: 1, mime: '', thumb: false }).ok).toBe(true)
    h.ledger.record.bytes = 0
    h.ledgerFails = true
    const unknown = await h.grant(alice.token, 'a.pdf', 4)
    expect(unknown.status).toBe(503)
    expect(await unknown.json()).toEqual({ error: 'unavailable' })
  })

  it('gives an upload up on DELETE; its place comes back', async () => {
    const alice = h.join('Alice')
    const granted = await h.grant(alice.token, 'a.pdf', 4)
    const { id } = (await granted.json()) as { id: string }
    expect(h.ledger.status(NOW).reservedBytes).toBe(4)
    const bob = h.join('Bob')
    expect((await h.request('DELETE', filePath(ROOM, id), bob.token)).status).toBe(404)
    expect((await h.request('DELETE', filePath(ROOM, id), alice.token)).status).toBe(200)
    expect(h.ledger.status(NOW).reservedBytes).toBe(0)
    expect((await h.request('DELETE', filePath(ROOM, id), alice.token)).status).toBe(404)
  })

  it('answers 503 without a bucket, and refuses other sites', async () => {
    const alice = h.join('Alice')
    const request = new Request(`https://longtalk.test${filesPath(ROOM)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
      body: '{}',
    })
    const deps = {
      guard: h.guard,
      room: () => h.room,
      ledger: h.ledgerRpc,
      waitUntil: () => {},
    }
    expect((await handleFiles(request, {}, new URL(request.url), deps)).status).toBe(503)
    const foreign = await h.request('POST', filesPath(ROOM), alice.token, '{}', {
      origin: 'https://evil.example',
    })
    expect(foreign.status).toBe(403)
  })

  it('starts a sweep when an upload finds none ran for a while', async () => {
    const alice = h.join('Alice')
    const key = uploadKey(NOW - 3 * FILE_TTL_MS, 'old')
    h.bucket.objects.set(key, { bytes: new Uint8Array(10) })
    await h.grant(alice.token, 'a.pdf', 4)
    await Promise.all(h.waited)
    expect(h.bucket.objects.has(key)).toBe(false)
    expect(h.ledger.status(NOW).sweep).toMatchObject({ deletedObjects: 1, deletedBytes: 10 })
  })

  it('the room closing hands back what must leave R2', async () => {
    const alice = h.join('Alice')
    const { id } = await h.upload(alice.token, 'a.pdf', encode('%PDF'))
    const pending = await h.grant(alice.token, 'b.pdf', 4)
    const pendingId = ((await pending.json()) as { id: string }).id
    void h.host.message(alice.conn, JSON.stringify({ t: 'host', action: 'endMeeting' }))
    expect(h.gone).toEqual([
      { keys: [`uploads/2026-11-05T13/${id}`], grants: [pendingId], bytes: 4 },
    ])
    expect(h.host.fileAccess(alice.token, id)).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('files and grants survive the room object leaving memory', async () => {
    const saved: unknown[] = []
    const alice = h.join('Alice')
    const { id } = await h.upload(alice.token, 'a.pdf', encode('%PDF'))
    const files = new RoomFiles(JSON.parse(JSON.stringify((h.host as unknown as { files: RoomFiles }).files.state)))
    saved.push(files.state)
    expect(files.access(id, NOW + 1)).toMatchObject({ ok: true, name: 'a.pdf' })
    expect(saved).toHaveLength(1)
  })
})

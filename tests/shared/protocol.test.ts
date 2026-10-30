import { describe, expect, it } from 'vitest'
import {
  MAX_CLIENT_MESSAGE_CHARS,
  MAX_NAME_CHARS,
  PROTOCOL_VERSION,
  isSessionToken,
  newSessionToken,
  normalizeName,
  parseClientMessage,
  parseServerMessage,
  roomSocketPath,
  type ServerMessage,
} from '../../shared/protocol.ts'

const state = {
  room: { id: 'abcdefghij', createdAt: 1 },
  members: { m1: { id: 'm1', name: 'Gene', joinedAt: 2, reconnecting: false } },
}
const TOKEN = 'A'.repeat(43)

describe('protocol', () => {
  it('builds the versioned WebSocket path', () => {
    expect(roomSocketPath('abcdefghij')).toBe(`/api/rooms/abcdefghij/ws?v=${PROTOCOL_VERSION}`)
  })

  it('parses the messages a browser may send', () => {
    expect(parseClientMessage('{"t":"resync"}')).toEqual({ t: 'resync' })
    expect(parseClientMessage('{"t":"leave"}')).toEqual({ t: 'leave' })
    expect(parseClientMessage(`{"t":"join","name":" Gene ","token":"${TOKEN}"}`)).toEqual({
      t: 'join',
      name: 'Gene',
      token: TOKEN,
    })
  })

  it('treats a join with a malformed token as someone new, and refuses one without a name', () => {
    for (const token of [null, 'short', 42, `${TOKEN}A`, `${TOKEN.slice(1)}=`]) {
      expect(parseClientMessage(JSON.stringify({ t: 'join', name: 'Gene', token }))).toEqual({
        t: 'join',
        name: 'Gene',
        token: null,
      })
    }
    expect(parseClientMessage('{"t":"join","name":"   ","token":null}')).toBeNull()
    expect(parseClientMessage('{"t":"join","token":null}')).toBeNull()
  })

  it('normalizes names', () => {
    expect(normalizeName('  小潔\t  Chen \n')).toBe('小潔 Chen')
    expect(normalizeName('Ge\u0000ne\u202E')).toBe('Gene')
    expect(normalizeName('👩‍💻 Wei')).toBe('👩‍💻 Wei')
    expect(normalizeName('字'.repeat(MAX_NAME_CHARS))).toBe('字'.repeat(MAX_NAME_CHARS))
    expect(normalizeName('字'.repeat(MAX_NAME_CHARS + 1))).toBeNull()
    for (const bad of ['', '   ', '\u202E', 7, null]) expect(normalizeName(bad)).toBeNull()
  })

  it('makes session tokens of 32 random bytes in base64url', () => {
    const tokens = new Set(Array.from({ length: 50 }, newSessionToken))
    expect(tokens.size).toBe(50)
    for (const token of tokens) expect(isSessionToken(token), token).toBe(true)
  })

  it('rejects anything else from a browser', () => {
    for (const raw of ['', 'ping', 'null', '[]', '"resync"', '{"t":"nope"}', '{bad json']) {
      expect(parseClientMessage(raw)).toBeNull()
    }
    expect(
      parseClientMessage(`{"t":"resync","pad":"${'x'.repeat(MAX_CLIENT_MESSAGE_CHARS)}"}`),
    ).toBeNull()
  })

  it('round-trips every server message', () => {
    const messages: ServerMessage[] = [
      { t: 'welcome', v: PROTOCOL_VERSION, you: 'm1', token: TOKEN, rev: 3, state },
      { t: 'snapshot', rev: 4, state },
      { t: 'patch', rev: 5, ops: [{ op: 'del', path: ['members', 'm1'] }] },
      { t: 'error', code: 'bad_message' },
    ]
    for (const message of messages)
      expect(parseServerMessage(JSON.stringify(message))).toEqual(message)
  })

  it('rejects server messages it does not understand', () => {
    const bad = [
      { t: 'welcome', v: PROTOCOL_VERSION + 1, you: 'm1', token: TOKEN, rev: 0, state },
      { t: 'welcome', v: PROTOCOL_VERSION, token: TOKEN, rev: 0, state },
      { t: 'welcome', v: PROTOCOL_VERSION, you: 'm1', rev: 0, state },
      { t: 'snapshot', rev: -1, state },
      { t: 'snapshot', rev: 1, state: { room: null, members: {} } },
      { t: 'patch', rev: 1.5, ops: [] },
      { t: 'patch', rev: 1 },
      { t: 'unknown' },
    ]
    for (const message of bad) expect(parseServerMessage(JSON.stringify(message))).toBeNull()
    expect(parseServerMessage('pong')).toBeNull()
  })
})

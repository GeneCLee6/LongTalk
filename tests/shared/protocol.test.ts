import { describe, expect, it } from 'vitest'
import {
  MAX_CLIENT_MESSAGE_CHARS,
  MAX_NAME_CHARS,
  PROTOCOL_VERSION,
  isClientId,
  isSessionToken,
  newSessionToken,
  normalizeName,
  parseClientMessage,
  parseServerMessage,
  roomSocketPath,
  waitingQueue,
  type ServerMessage,
} from '../../shared/protocol.ts'

const state = {
  room: {
    id: 'abcdefghij',
    createdAt: 1,
    name: null,
    createdBy: null,
    startedAt: null,
    share: null,
    locked: false,
    waitingRoom: false,
    passwordSetAt: null,
    spotlight: null,
  },
  members: {
    m1: {
      id: 'm1',
      name: 'Gene',
      role: 'host' as const,
      joinedAt: 2,
      reconnecting: false,
      tracks: [],
      hand: null,
    },
  },
  waiting: {},
  usage: 'normal' as const,
}
const TOKEN = 'A'.repeat(43)

describe('protocol', () => {
  it('builds the versioned WebSocket path', () => {
    expect(roomSocketPath('abcdefghij')).toBe(`/api/rooms/abcdefghij/ws?v=${PROTOCOL_VERSION}`)
  })

  it('parses renames: a display name up to 40 characters, a room name up to 60 (C2)', () => {
    expect(parseClientMessage('{"t":"rename","name":" 阿明 "}')).toEqual({
      t: 'rename',
      name: '阿明',
    })
    expect(parseClientMessage(JSON.stringify({ t: 'rename', name: 'x'.repeat(41) }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'renameRoom', name: 'x'.repeat(60) }))).toEqual({
      t: 'renameRoom',
      name: 'x'.repeat(60),
    })
    expect(parseClientMessage(JSON.stringify({ t: 'renameRoom', name: 'x'.repeat(61) }))).toBeNull()
    expect(parseClientMessage('{"t":"renameRoom","name":"‮ "}')).toBeNull()
    expect(parseClientMessage('{"t":"renameRoom"}')).toBeNull()
  })

  it('parses share and unshare (D1)', () => {
    expect(parseClientMessage('{"t":"share","takeOver":false}')).toEqual({
      t: 'share',
      takeOver: false,
    })
    expect(parseClientMessage('{"t":"share","takeOver":true}')).toEqual({
      t: 'share',
      takeOver: true,
    })
    expect(parseClientMessage('{"t":"share"}')).toBeNull()
    expect(parseClientMessage('{"t":"share","takeOver":"yes"}')).toBeNull()
    expect(parseClientMessage('{"t":"unshare"}')).toEqual({ t: 'unshare' })
  })

  it('parses spotlight (G2): a member id, or null to end it', () => {
    expect(parseClientMessage('{"t":"spotlight","memberId":"m1"}')).toEqual({
      t: 'spotlight',
      memberId: 'm1',
    })
    expect(parseClientMessage('{"t":"spotlight","memberId":null}')).toEqual({
      t: 'spotlight',
      memberId: null,
    })
    expect(parseClientMessage('{"t":"spotlight"}')).toBeNull()
    expect(parseClientMessage('{"t":"spotlight","memberId":5}')).toBeNull()
    expect(parseClientMessage('{"t":"spotlight","memberId":""}')).toBeNull()
  })

  it('parses the messages a browser may send', () => {
    expect(parseClientMessage('{"t":"resync"}')).toEqual({ t: 'resync' })
    expect(parseClientMessage('{"t":"leave"}')).toEqual({ t: 'leave' })
    expect(parseClientMessage(`{"t":"join","name":" Gene ","token":"${TOKEN}"}`)).toEqual({
      t: 'join',
      name: 'Gene',
      token: TOKEN,
      client: null,
    })
  })

  it('treats a join with a malformed token as someone new, and refuses one without a name', () => {
    for (const token of [null, 'short', 42, `${TOKEN}A`, `${TOKEN.slice(1)}=`]) {
      expect(parseClientMessage(JSON.stringify({ t: 'join', name: 'Gene', token }))).toEqual({
        t: 'join',
        name: 'Gene',
        token: null,
        client: null,
      })
    }
    expect(parseClientMessage('{"t":"join","name":"   ","token":null}')).toBeNull()
    expect(parseClientMessage('{"t":"join","token":null}')).toBeNull()
  })

  it('parses what a member publishes and the bytes it received', () => {
    const tracks = {
      t: 'tracks',
      sessionId: 'sess-1',
      tracks: [
        { trackName: 'mic-1a2b', kind: 'mic', muted: false },
        { trackName: 'cam-3c4d', kind: 'cam', muted: true },
      ],
    }
    expect(parseClientMessage(JSON.stringify(tracks))).toEqual(tracks)
    expect(parseClientMessage('{"t":"tracks","sessionId":"s","tracks":[]}')).toEqual({
      t: 'tracks',
      sessionId: 's',
      tracks: [],
    })
    expect(
      parseClientMessage('{"t":"stats","sessionId":"s","bytesReceived":1234,"relay":true}'),
    ).toEqual({ t: 'stats', sessionId: 's', bytesReceived: 1234, relay: true })
  })

  it('refuses malformed track lists and stats', () => {
    const bad = [
      { t: 'tracks', sessionId: 'a/b', tracks: [] },
      { t: 'tracks', sessionId: 's', tracks: [{ trackName: 'x', kind: 'hologram', muted: false }] },
      { t: 'tracks', sessionId: 's', tracks: [{ trackName: '../x', kind: 'mic', muted: false }] },
      // v4: `muted` is required and a boolean
      { t: 'tracks', sessionId: 's', tracks: [{ trackName: 'x', kind: 'mic' }] },
      { t: 'tracks', sessionId: 's', tracks: [{ trackName: 'x', kind: 'mic', muted: 'yes' }] },
      // Two of one kind
      {
        t: 'tracks',
        sessionId: 's',
        tracks: [
          { trackName: 'a', kind: 'cam', muted: false },
          { trackName: 'b', kind: 'cam', muted: false },
        ],
      },
      { t: 'tracks', sessionId: 's', tracks: 'mic' },
      { t: 'tracks', sessionId: 's', tracks: [null] },
      { t: 'stats', sessionId: 's', bytesReceived: -1, relay: false },
      { t: 'stats', sessionId: 's', bytesReceived: 1.5, relay: false },
      { t: 'stats', sessionId: 's', bytesReceived: '10', relay: false },
      { t: 'stats', bytesReceived: 10, relay: false },
      // v5: `relay` is required and a boolean
      { t: 'stats', sessionId: 's', bytesReceived: 10 },
      { t: 'stats', sessionId: 's', bytesReceived: 10, relay: 'yes' },
    ]
    for (const message of bad) expect(parseClientMessage(JSON.stringify(message))).toBeNull()
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
      { t: 'error', code: 'share_busy' },
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

  it('parses the host controls (F1): one member or the whole room', () => {
    expect(parseClientMessage('{"t":"host","action":"muteMember","memberId":"m-1"}')).toEqual({
      t: 'host',
      action: 'muteMember',
      memberId: 'm-1',
    })
    for (const action of ['camOff', 'stopShare', 'remove']) {
      expect(parseClientMessage(JSON.stringify({ t: 'host', action, memberId: 'x' }))).toEqual({
        t: 'host',
        action,
        memberId: 'x',
      })
    }
    // A room action drops a stray member id
    expect(parseClientMessage('{"t":"host","action":"muteAll","memberId":"x"}')).toEqual({
      t: 'host',
      action: 'muteAll',
    })
    expect(parseClientMessage('{"t":"host","action":"endMeeting"}')).toEqual({
      t: 'host',
      action: 'endMeeting',
    })
    for (const bad of [
      '{"t":"host","action":"muteMember"}',
      '{"t":"host","action":"remove","memberId":""}',
      '{"t":"host","action":"remove","memberId":"a b"}',
      '{"t":"host","action":"unmute","memberId":"x"}',
      '{"t":"host"}',
    ]) {
      expect(parseClientMessage(bad), bad).toBeNull()
    }
  })

  it("carries the browser's own id in join, when it looks like one (F1)", () => {
    const client = 'browser-id-0123456789'
    expect(isClientId(client)).toBe(true)
    for (const bad of ['short', 'x'.repeat(65), 'has space in it here', 42, null]) {
      expect(isClientId(bad)).toBe(false)
    }
    expect(
      parseClientMessage(JSON.stringify({ t: 'join', name: 'Gene', token: null, client })),
    ).toEqual({ t: 'join', name: 'Gene', token: null, client })
  })

  it('parses the lock, the waiting room, admit, admit all and deny (F2)', () => {
    for (const action of ['lock', 'waitingRoom']) {
      for (const on of [true, false]) {
        expect(parseClientMessage(JSON.stringify({ t: 'host', action, on }))).toEqual({
          t: 'host',
          action,
          on,
        })
      }
      expect(parseClientMessage(JSON.stringify({ t: 'host', action }))).toBeNull()
      expect(parseClientMessage(JSON.stringify({ t: 'host', action, on: 'yes' }))).toBeNull()
    }
    for (const action of ['admit', 'deny']) {
      expect(parseClientMessage(JSON.stringify({ t: 'host', action, memberId: 'm-2' }))).toEqual({
        t: 'host',
        action,
        memberId: 'm-2',
      })
      expect(parseClientMessage(JSON.stringify({ t: 'host', action }))).toBeNull()
    }
    expect(parseClientMessage('{"t":"host","action":"admitAll"}')).toEqual({
      t: 'host',
      action: 'admitAll',
    })
  })

  it('parses a lobby (F2), and refuses one of another version or shape', () => {
    const lobby = {
      t: 'lobby',
      v: PROTOCOL_VERSION,
      you: 'm2',
      token: TOKEN,
      position: 2,
      count: 3,
      room: { name: null, createdBy: 'Gene' },
      hostPresent: true,
    }
    expect(parseServerMessage(JSON.stringify(lobby))).toEqual(lobby)
    for (const bad of [
      { ...lobby, v: PROTOCOL_VERSION - 1 },
      { ...lobby, position: -1 },
      { ...lobby, room: null },
      { ...lobby, hostPresent: 'yes' },
    ]) {
      expect(parseServerMessage(JSON.stringify(bad))).toBeNull()
    }
  })

  it('orders the waiting room first come, first in (F2)', () => {
    const entry = (id: string, since: number) => ({ id, name: id, since, reconnecting: false })
    expect(
      waitingQueue({ b: entry('b', 5), a: entry('a', 5), c: entry('c', 1) }).map((e) => e.id),
    ).toEqual(['c', 'a', 'b'])
    expect(waitingQueue(undefined)).toEqual([])
  })

  it('parses a notice (F1)', () => {
    const notice = { t: 'notice', notice: 'muted', by: 'm1', all: true }
    expect(parseServerMessage(JSON.stringify(notice))).toEqual(notice)
    expect(parseServerMessage('{"t":"notice","notice":"muted"}')).toBeNull()
  })
})

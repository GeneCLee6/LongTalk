import { describe, expect, it } from 'vitest'
import {
  MAX_CLIENT_MESSAGE_CHARS,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  roomSocketPath,
  type ServerMessage,
} from '../../shared/protocol.ts'

const state = {
  room: { id: 'abcdefghij', createdAt: 1 },
  members: { m1: { id: 'm1', joinedAt: 2 } },
}

describe('protocol', () => {
  it('builds the versioned WebSocket path', () => {
    expect(roomSocketPath('abcdefghij')).toBe(`/api/rooms/abcdefghij/ws?v=${PROTOCOL_VERSION}`)
  })

  it('parses the messages a browser may send', () => {
    expect(parseClientMessage('{"t":"resync"}')).toEqual({ t: 'resync' })
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
      { t: 'welcome', v: PROTOCOL_VERSION, you: 'm1', rev: 3, state },
      { t: 'snapshot', rev: 4, state },
      { t: 'patch', rev: 5, ops: [{ op: 'del', path: ['members', 'm1'] }] },
      { t: 'error', code: 'bad_message' },
    ]
    for (const message of messages)
      expect(parseServerMessage(JSON.stringify(message))).toEqual(message)
  })

  it('rejects server messages it does not understand', () => {
    const bad = [
      { t: 'welcome', v: PROTOCOL_VERSION + 1, you: 'm1', rev: 0, state },
      { t: 'welcome', v: PROTOCOL_VERSION, rev: 0, state },
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

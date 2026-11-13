import { describe, expect, it } from 'vitest'
import {
  CHAT_RATE,
  ChatRateLimit,
  MAX_CHAT_CHARS,
  isChatMessage,
  normalizeChatText,
} from '../../shared/chat.ts'
import {
  MAX_CLIENT_MESSAGE_CHARS,
  parseClientMessage,
  parseServerMessage,
} from '../../shared/protocol.ts'

describe('normalizeChatText (e5-t01)', () => {
  it('keeps newlines, trims, unifies line breaks and tabs', () => {
    expect(normalizeChatText('  第一行\r\n第二行\r第三行\t結束  ')).toBe(
      '第一行\n第二行\n第三行 結束',
    )
  })

  it('removes control characters and bidi overrides, but not the text around them', () => {
    expect(normalizeChatText('a\u0000b\u0007c\u202Ed\u2066e\u001Bf')).toBe('abcdef')
  })

  it('squeezes long runs of blank lines', () => {
    expect(normalizeChatText('a\n\n\n\n\n\nb')).toBe('a\n\n\nb')
  })

  it('refuses nothing, whitespace only, non-strings and anything too long', () => {
    expect(normalizeChatText('')).toBeNull()
    expect(normalizeChatText(' \n \t ')).toBeNull()
    expect(normalizeChatText(42)).toBeNull()
    expect(normalizeChatText(null)).toBeNull()
    expect(normalizeChatText('字'.repeat(MAX_CHAT_CHARS))).toHaveLength(MAX_CHAT_CHARS)
    expect(normalizeChatText('字'.repeat(MAX_CHAT_CHARS + 1))).toBeNull()
  })

  it('counts characters, not UTF-16 units: 2000 emoji fit', () => {
    const emoji = '😀'.repeat(MAX_CHAT_CHARS)
    expect(normalizeChatText(emoji)).toBe(emoji)
    // And the socket frame carrying them fits the protocol's limit
    expect(JSON.stringify({ t: 'chat', text: emoji }).length).toBeLessThan(MAX_CLIENT_MESSAGE_CHARS)
    expect(parseClientMessage(JSON.stringify({ t: 'chat', text: emoji }))).toEqual({
      t: 'chat',
      text: emoji,
    })
  })

  it('leaves markup as text: rendering is text only', () => {
    expect(normalizeChatText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('ChatRateLimit', () => {
  it(`lets ${CHAT_RATE.count} through per window per sender, sliding`, () => {
    const limit = new ChatRateLimit()
    for (let i = 0; i < CHAT_RATE.count; i++) expect(limit.take('a', 1000 + i)).toBe(true)
    expect(limit.take('a', 2000)).toBe(false)
    expect(limit.take('b', 2000)).toBe(true)
    // The first one leaves the window
    expect(limit.take('a', 1000 + CHAT_RATE.windowMs)).toBe(true)
    expect(limit.take('a', 1000 + CHAT_RATE.windowMs)).toBe(false)
    limit.forget('a')
    expect(limit.take('a', 1000 + CHAT_RATE.windowMs)).toBe(true)
  })
})

describe('chat on the wire (protocol v8)', () => {
  it('parses a chat message from the browser, normalized', () => {
    expect(parseClientMessage('{"t":"chat","text":"  hi  "}')).toEqual({ t: 'chat', text: 'hi' })
    expect(parseClientMessage('{"t":"chat","text":"   "}')).toBeNull()
    expect(parseClientMessage('{"t":"chat"}')).toBeNull()
  })

  it('parses the room’s chat frames and rejects malformed ones', () => {
    const message = { id: 1, from: 'm1', name: 'Gene', text: 'hi', at: 5 }
    expect(isChatMessage(message)).toBe(true)
    expect(
      parseServerMessage(JSON.stringify({ t: 'chat', messages: [message], reset: true })),
    ).toEqual({ t: 'chat', messages: [message], reset: true })
    expect(
      parseServerMessage(JSON.stringify({ t: 'chat', messages: [{ ...message, id: 'x' }] })),
    ).toBeNull()
    expect(parseServerMessage(JSON.stringify({ t: 'chat' }))).toBeNull()
  })
})

describe('private messages on the wire (O4, e5-t09)', () => {
  it('parses `to` when it is a member id, and refuses anything else', () => {
    expect(parseClientMessage('{"t":"chat","text":"hi","to":"m2"}')).toEqual({
      t: 'chat',
      text: 'hi',
      to: 'm2',
    })
    expect(parseClientMessage('{"t":"chat","text":"hi","to":5}')).toBeNull()
    expect(parseClientMessage('{"t":"chat","text":"hi","to":null}')).toBeNull()
  })

  it('accepts a private message from the room, and refuses a malformed recipient', () => {
    const message = { id: 1, from: 'm1', name: 'Gene', text: 'hi', at: 5, to: 'm2', toName: 'Bo' }
    expect(isChatMessage(message)).toBe(true)
    expect(isChatMessage({ ...message, to: 2 })).toBe(false)
    expect(isChatMessage({ ...message, toName: null })).toBe(false)
  })
})

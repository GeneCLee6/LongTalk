import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../shared/chat.ts'
import { ChatPanel } from '../../src/components/ChatPanel.tsx'
import { ChatPreview } from '../../src/components/ChatPreview.tsx'
import { Drawer } from '../../src/components/Drawer.tsx'
import { SidePanel } from '../../src/components/SidePanel.tsx'
import {
  COMPOSITION_GRACE_MS,
  chatTime,
  countUnread,
  isSendKey,
  safeHref,
  splitLinks,
} from '../../src/room/chatText.ts'
import { CHAT_PREVIEW_MS, useChatNotifications } from '../../src/room/useChatNotifications.ts'
import { strings } from '../../src/strings.ts'
import { media } from '../../src/styles/tokens.ts'

const at = new Date(2026, 10, 2, 21, 4).getTime()
const message = (id: number, from = 'b', text = `m${id}`, name = '小潔'): ChatMessage => ({
  id,
  from,
  name,
  text,
  at: at + id,
})

describe('splitLinks (e5-t02)', () => {
  it('finds http and https links in running text, Chinese punctuation included', () => {
    expect(splitLinks('連結在這 https://longtalk.app/r/k7pq2x9m4a，快來')).toEqual([
      { type: 'text', text: '連結在這 ' },
      {
        type: 'link',
        text: 'https://longtalk.app/r/k7pq2x9m4a',
        href: 'https://longtalk.app/r/k7pq2x9m4a',
      },
      { type: 'text', text: '，快來' },
    ])
    expect(splitLinks('see http://a.example/x.')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'http://a.example/x', href: 'http://a.example/x' },
      { type: 'text', text: '.' },
    ])
  })

  it('keeps a closing parenthesis that belongs to the URL, drops one that ends the sentence', () => {
    expect(splitLinks('(https://en.wikipedia.org/wiki/Foo_(bar))')[1]).toMatchObject({
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    })
    expect(splitLinks('(see https://a.example/x)')[1]).toMatchObject({
      text: 'https://a.example/x',
    })
  })

  it('never links anything but http(s), and leaves markup as text', () => {
    expect(splitLinks('javascript:alert(1) data:text/html,x ftp://x')).toEqual([
      { type: 'text', text: 'javascript:alert(1) data:text/html,x ftp://x' },
    ])
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('https://a.example')).toBe('https://a.example/')
    expect(splitLinks('<a href="https://x.example">x</a>')).toEqual([
      { type: 'text', text: '<a href="' },
      { type: 'link', text: 'https://x.example', href: 'https://x.example/' },
      { type: 'text', text: '">x</a>' },
    ])
  })

  it('handles plain text and several links', () => {
    expect(splitLinks('沒有連結')).toEqual([{ type: 'text', text: '沒有連結' }])
    expect(
      splitLinks('https://a.example https://b.example').filter((s) => s.type === 'link'),
    ).toHaveLength(2)
  })
})

describe('isSendKey', () => {
  it('sends on Enter, not Shift+Enter, and never while an input method composes', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: false })).toBe(true)
    expect(isSendKey({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    // Safari reports the candidate pick as keyCode 229 with isComposing already false
    expect(isSendKey({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false)
    expect(isSendKey({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe(false)
    expect(isSendKey({ key: 'a', shiftKey: false })).toBe(false)
  })

  const enter = { key: 'Enter', shiftKey: false }

  it('does not send while a composition is open, even if the event does not say so', () => {
    expect(isSendKey(enter, { enterSends: true, composing: true })).toBe(false)
  })

  it(`does not send within ${COMPOSITION_GRACE_MS} ms after compositionend (Safari's order)`, () => {
    const ended = 1_000
    // Safari: compositionend, then the Enter's keydown with isComposing false and keyCode 13
    const right = { enterSends: true, compositionEndedAt: ended, now: ended + 5 }
    expect(isSendKey({ ...enter, keyCode: 13 }, right)).toBe(false)
    const edge = {
      enterSends: true,
      compositionEndedAt: ended,
      now: ended + COMPOSITION_GRACE_MS - 1,
    }
    expect(isSendKey(enter, edge)).toBe(false)
    // A later Enter is a real one
    const later = { enterSends: true, compositionEndedAt: ended, now: ended + COMPOSITION_GRACE_MS }
    expect(isSendKey(enter, later)).toBe(true)
  })

  it('never sends on Enter where a touch screen is the main input', () => {
    expect(isSendKey(enter, { enterSends: false })).toBe(false)
    expect(
      isSendKey({ ...enter, keyCode: 13 }, { enterSends: false, compositionEndedAt: null }),
    ).toBe(false)
  })
})

describe('unread counting', () => {
  it('counts messages from others after the last one seen', () => {
    const messages = [message(1), message(2, 'me'), message(3), message(4)]
    expect(countUnread(messages, 0, 'me')).toBe(3)
    expect(countUnread(messages, 2, 'me')).toBe(2)
    expect(countUnread(messages, 4, 'me')).toBe(0)
  })

  it('formats times as 24-hour hh:mm', () => {
    expect(chatTime(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05')
  })
})

describe('useChatNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  type Props = Parameters<typeof useChatNotifications>[0]
  const start: Props = { messages: [], loaded: false, you: 'me', open: false }

  it('does not count the history as new, counts what arrives after, and clears on open', () => {
    const { result, rerender } = renderHook((props: Props) => useChatNotifications(props), {
      initialProps: start,
    })
    rerender({ ...start, messages: [message(1), message(2)], loaded: true })
    expect(result.current.unread).toBe(0)
    expect(result.current.preview).toBeNull()
    rerender({ ...start, messages: [message(1), message(2), message(3)], loaded: true })
    expect(result.current.unread).toBe(1)
    expect(result.current.preview).toMatchObject({ id: 3 })
    // Our own message is never unread, and does not preview
    rerender({
      ...start,
      messages: [message(1), message(2), message(3), message(4, 'me')],
      loaded: true,
    })
    expect(result.current.unread).toBe(1)
    expect(result.current.preview).toMatchObject({ id: 3 })
    rerender({
      ...start,
      messages: [message(1), message(2), message(3), message(4, 'me')],
      loaded: true,
      open: true,
    })
    expect(result.current.unread).toBe(0)
    expect(result.current.preview).toBeNull()
  })

  it('previews briefly, and nothing while the panel is open', () => {
    const { result, rerender } = renderHook((props: Props) => useChatNotifications(props), {
      initialProps: { ...start, loaded: true },
    })
    rerender({ ...start, loaded: true, messages: [message(1)] })
    expect(result.current.preview).toMatchObject({ id: 1 })
    act(() => {
      vi.advanceTimersByTime(CHAT_PREVIEW_MS)
    })
    expect(result.current.preview).toBeNull()
    expect(result.current.unread).toBe(1)
    rerender({ ...start, loaded: true, open: true, messages: [message(1), message(2)] })
    expect(result.current.preview).toBeNull()
    expect(result.current.unread).toBe(0)
  })

  it('neither previews nor counts a breakout room’s history replayed mid-meeting (L3)', () => {
    const { result, rerender } = renderHook((props: Props) => useChatNotifications(props), {
      initialProps: { ...start, loaded: true, messages: [message(1)], historyUntil: 1 },
    })
    rerender({ ...start, loaded: true, messages: [message(1), message(2)], historyUntil: 1 })
    expect(result.current.unread).toBe(1)
    act(() => {
      vi.advanceTimersByTime(CHAT_PREVIEW_MS)
    })
    // Moved: the new room's chat replaces the list, newer ids than we had, all of it history
    const room = [message(5), message(7), message(9)]
    rerender({ ...start, loaded: true, messages: room, historyUntil: 9 })
    expect(result.current.unread).toBe(0)
    expect(result.current.preview).toBeNull()
    // What is said there afterwards is new
    rerender({ ...start, loaded: true, messages: [...room, message(10)], historyUntil: 9 })
    expect(result.current.unread).toBe(1)
    expect(result.current.preview).toMatchObject({ id: 10 })
    // Back to a room where nothing was said, panel open: settles; then a new message counts
    rerender({ ...start, loaded: true, open: true, messages: [], historyUntil: 9 })
    expect(result.current.unread).toBe(0)
    rerender({ ...start, loaded: true, messages: [message(11)], historyUntil: 9 })
    expect(result.current.unread).toBe(1)
    expect(result.current.preview).toMatchObject({ id: 11 })
  })

  it('does not count the rest of a long first history as new', () => {
    const { result, rerender } = renderHook((props: Props) => useChatNotifications(props), {
      initialProps: start,
    })
    rerender({ ...start, loaded: true, messages: [message(1), message(2)], historyUntil: 2 })
    rerender({
      ...start,
      loaded: true,
      messages: [message(1), message(2), message(3)],
      historyUntil: 3,
    })
    expect(result.current.unread).toBe(0)
    expect(result.current.preview).toBeNull()
  })
})

describe('ChatPanel', () => {
  const panel = (props: Partial<Parameters<typeof ChatPanel>[0]> = {}) => {
    const onSend = vi.fn(() => 'sent' as const)
    const view = render(
      <ChatPanel
        messages={[message(1, 'b', '大家好'), message(2, 'me', '連結 https://example.com/a')]}
        you="me"
        onSend={onSend}
        {...props}
      />,
    )
    return {
      ...view,
      onSend,
      input: screen.getByRole('textbox', { name: strings.chat.inputLabel }),
    }
  }

  it('lists messages with sender and time, ours headed 你, links as safe new-tab anchors', () => {
    panel()
    const log = screen.getByRole('log', { name: strings.chat.messages })
    expect(log).toHaveTextContent('小潔 · 21:04')
    expect(log).toHaveTextContent('你 · 21:04')
    expect(log).toHaveTextContent('大家好')
    const link = screen.getByRole('link', { name: 'https://example.com/a' })
    expect(link).toHaveAttribute('href', 'https://example.com/a')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders markup as text, never as HTML', () => {
    const { container } = panel({
      messages: [message(1, 'b', '<img src=x onerror="window.hacked=1"><script>x</script>')],
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByRole('log')).toHaveTextContent('<img src=x onerror="window.hacked=1">')
  })

  it('sends on Enter and clears the box; Shift+Enter and composing Enter do not send', () => {
    const { onSend, input } = panel()
    fireEvent.change(input, { target: { value: '第一行' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    // 注音 picking a candidate: Enter with isComposing
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('第一行')
    expect(input).toHaveValue('')
  })

  it('ignores the Enter that comes right after compositionend, sends a later one', () => {
    const now = vi.spyOn(performance, 'now')
    try {
      const { onSend, input } = panel()
      fireEvent.change(input, { target: { value: '你好' } })
      now.mockReturnValue(10_000)
      fireEvent.compositionStart(input)
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSend).not.toHaveBeenCalled()
      fireEvent.compositionEnd(input)
      now.mockReturnValue(10_020)
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
      expect(onSend).not.toHaveBeenCalled()
      now.mockReturnValue(10_000 + COMPOSITION_GRACE_MS + 50)
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
      expect(onSend).toHaveBeenCalledExactlyOnceWith('你好')
    } finally {
      now.mockRestore()
    }
  })

  it('on touch screens Enter is a new line and only the send button sends', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === media.touchPrimary,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    try {
      const { onSend, input } = panel()
      expect(input).toHaveAttribute('enterkeyhint', 'enter')
      expect(input).toHaveAccessibleDescription(strings.chat.hintTouch)
      fireEvent.change(input, { target: { value: '第一行' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSend).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: strings.chat.send }))
      expect(onSend).toHaveBeenCalledExactlyOnceWith('第一行')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('with a keyboard the hint says Enter sends', () => {
    const { input } = panel()
    expect(input).toHaveAttribute('enterkeyhint', 'send')
    expect(input).toHaveAccessibleDescription(strings.chat.hint)
  })

  it('keeps the text and says why when it could not send', () => {
    const onSend = vi.fn(() => 'rateLimited' as const)
    const { input } = panel({ onSend })
    fireEvent.change(input, { target: { value: '太快了' } })
    fireEvent.click(screen.getByRole('button', { name: strings.chat.send }))
    expect(input).toHaveValue('太快了')
    expect(screen.getByRole('alert')).toHaveTextContent(strings.chat.rateLimited)
  })

  it('counts down near the limit and disables send when empty', () => {
    const { input } = panel()
    expect(screen.getByRole('button', { name: strings.chat.send })).toBeDisabled()
    fireEvent.change(input, { target: { value: '字'.repeat(1990) } })
    expect(screen.getByText(strings.chat.remaining(10))).toBeInTheDocument()
  })

  it('says the chat is empty and only lasts the meeting', () => {
    panel({ messages: [] })
    expect(screen.getByText(strings.chat.empty)).toBeInTheDocument()
    expect(screen.getByText(strings.chat.retention)).toBeInTheDocument()
  })

  it('focuses the box when asked (desktop)', () => {
    const { input } = panel({ autoFocus: true })
    expect(input).toHaveFocus()
  })
})

describe('ChatPreview', () => {
  it('shows the sender and text; pressing it opens the chat', () => {
    const onOpen = vi.fn()
    const onDismiss = vi.fn()
    const { rerender } = render(
      <ChatPreview message={message(1, 'b', '快來看')} onOpen={onOpen} onDismiss={onDismiss} />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`^小潔.*${strings.chat.previewOpen}$`) }),
    )
    expect(onOpen).toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('快來看')
    fireEvent.click(screen.getByRole('button', { name: strings.common.close }))
    expect(onDismiss).toHaveBeenCalled()
    rerender(<ChatPreview message={null} onOpen={onOpen} onDismiss={onDismiss} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('chat containers', () => {
  it('desktop: a side panel named 聊天 that Escape closes', () => {
    const onClose = vi.fn()
    render(
      <SidePanel title={strings.chat.title} closeLabel={strings.chat.close} onClose={onClose}>
        <ChatPanel messages={[]} you="me" onSend={() => 'sent'} autoFocus />
      </SidePanel>,
    )
    expect(screen.getByRole('complementary', { name: strings.chat.title })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: strings.chat.close }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('phones: a full-screen drawer that keeps the keyboard down (focus on the list)', () => {
    render(
      <Drawer variant="full" title={strings.chat.title} onClose={() => undefined}>
        <ChatPanel messages={[message(1)]} you="me" onSend={() => 'sent'} />
      </Drawer>,
    )
    expect(screen.getByRole('dialog', { name: strings.chat.title })).toBeInTheDocument()
    expect(screen.getByRole('log')).toHaveFocus()
  })
})

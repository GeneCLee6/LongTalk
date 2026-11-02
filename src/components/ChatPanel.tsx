import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import styled from 'styled-components'
import { MAX_CHAT_CHARS, type ChatMessage } from '../../shared/chat.ts'
import { chatTime, isSendKey, splitLinks } from '../room/chatText.ts'
import type { ChatSendResult } from '../room/RoomConnection.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, size, space } from '../styles/tokens.ts'
import { SendIcon } from './icons.tsx'

export interface ChatPanelProps {
  messages: readonly ChatMessage[]
  /** Our member id: our messages sit on the right, headed 「你」 */
  you: string | null
  /** Sends the text; anything but `sent` keeps it in the box and says why */
  onSend: (text: string) => ChatSendResult
  /** Put the cursor in the box when the panel opens (desktop; on phones the keyboard would cover the list) */
  autoFocus?: boolean
}

/** Consecutive messages from one sender this close together share one header */
const GROUP_MS = 2 * 60_000
/** The character count shows once this few are left */
const COUNT_FROM = MAX_CHAT_CHARS - 200
/** How close to the bottom counts as "at the bottom" (new messages then scroll into view) */
const STICK_PX = 48

/**
 * The room's chat (e5-t02, DESIGN.md §5 SidePanel): the messages and the box to write in. Used
 * in the desktop side panel and the phones' full-screen drawer, which bring the heading.
 *
 * Messages are text: rendered as React text nodes (never as HTML), newlines kept, with http(s)
 * links as anchors that open in a new tab without access to this page (rel="noopener
 * noreferrer"). Enter sends, Shift+Enter is a new line, and Enter while an input method is
 * composing (注音、倉頡、拼音) only picks the candidate. The list follows new messages while it
 * is scrolled to the bottom, and always after our own.
 */
export function ChatPanel({ messages, you, onSend, autoFocus = false }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const atBottom = useRef(true)
  const hintId = useId()
  const problemId = useId()

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  // Before paint, so a new message never flashes above the fold first
  const last = messages.at(-1)
  useLayoutEffect(() => {
    const element = log.current
    if (!element || !last) return
    if (atBottom.current || last.from === you) element.scrollTop = element.scrollHeight
  }, [last, you])

  // The box grows with its text, up to five lines
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [draft])

  const length = [...draft.trim()].length
  const send = () => {
    const result = onSend(draft)
    switch (result) {
      case 'sent':
        setDraft('')
        setProblem(null)
        atBottom.current = true
        return
      case 'empty':
        return
      case 'tooLong':
        setProblem(strings.chat.tooLong(MAX_CHAT_CHARS))
        return
      case 'rateLimited':
        setProblem(strings.chat.rateLimited)
        return
      case 'offline':
        setProblem(strings.chat.offline)
        return
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const sends = isSendKey({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    })
    if (!sends) return
    event.preventDefault()
    send()
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    send()
    input.current?.focus()
  }

  return (
    <Panel>
      <Log
        ref={log}
        role="log"
        aria-label={strings.chat.messages}
        // A scrolling region is reachable by keyboard
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget
          atBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
        }}
      >
        {messages.length === 0 ? (
          <Empty>
            <p>{strings.chat.empty}</p>
            <p>{strings.chat.retention}</p>
          </Empty>
        ) : (
          <List>
            {messages.map((message, index) => {
              const own = message.from === you
              const previous = messages[index - 1]
              const grouped =
                previous !== undefined &&
                previous.from === message.from &&
                message.at - previous.at < GROUP_MS
              const name = own ? strings.chat.you : message.name
              const time = chatTime(message.at)
              return (
                <Item key={message.id} $own={own} $grouped={grouped}>
                  {!grouped && <Meta aria-hidden="true">{strings.chat.meta(name, time)}</Meta>}
                  <Bubble $own={own}>
                    <Hidden>{strings.chat.spoken(name, time)}</Hidden>
                    <MessageText text={message.text} />
                  </Bubble>
                </Item>
              )
            })}
          </List>
        )}
      </Log>
      <Compose onSubmit={onSubmit}>
        <Box>
          <Input
            ref={input}
            rows={1}
            value={draft}
            aria-label={strings.chat.inputLabel}
            aria-describedby={problem ? `${hintId} ${problemId}` : hintId}
            placeholder={strings.chat.placeholder}
            enterKeyHint="send"
            onChange={(event) => {
              setDraft(event.target.value)
              if (problem) setProblem(null)
            }}
            onKeyDown={onKeyDown}
          />
          <Send
            type="submit"
            aria-label={strings.chat.send}
            title={strings.chat.send}
            disabled={length === 0}
          >
            <SendIcon />
          </Send>
        </Box>
        <Footer>
          <span id={hintId}>{strings.chat.hint}</span>
          {length >= COUNT_FROM && (
            <Count $over={length > MAX_CHAT_CHARS} aria-live="polite">
              {strings.chat.remaining(MAX_CHAT_CHARS - length)}
            </Count>
          )}
        </Footer>
        {problem && (
          <Problem id={problemId} role="alert">
            {problem}
          </Problem>
        )}
      </Compose>
    </Panel>
  )
}

/** A message's text: plain text nodes and safe anchors, nothing else (never innerHTML) */
export function MessageText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((segment, index) =>
        segment.type === 'link' ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            title={strings.chat.openLink(segment.text)}
          >
            {segment.text}
          </a>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  )
}

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`

const Log = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: ${space(3)};

  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: -2px;
  }
`

const Empty = styled.div`
  display: grid;
  gap: ${space(2)};
  padding: ${space(6)} ${space(2)};
  color: ${color.muted};
  font-size: ${fontSize.small};
  text-align: center;

  p {
    margin: 0;
  }
`

const List = styled.ol`
  display: grid;
  gap: ${space(1)};
  margin: 0;
  padding: 0;
  list-style: none;
`

const Item = styled.li<{ $own: boolean; $grouped: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: ${({ $own }) => ($own ? 'flex-end' : 'flex-start')};
  margin-top: ${({ $grouped }) => ($grouped ? '0' : space(2))};
`

const Meta = styled.span`
  margin-bottom: ${space(0.5)};
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`

const Bubble = styled.p<{ $own: boolean }>`
  position: relative;
  max-width: 85%;
  margin: 0;
  padding: ${space(2)} ${space(2.5)};
  border-radius: ${radius.button};
  background: ${({ $own }) => ($own ? color.primarySoft : color.surface2)};
  color: ${color.fg};
  font-size: ${fontSize.small};
  line-height: 1.5;
  /* Newlines as typed; long URLs and words wrap instead of widening the panel */
  white-space: pre-wrap;
  overflow-wrap: anywhere;

  a {
    color: ${color.primary};
    text-decoration: underline;
  }
`

/** Read by screen readers, not shown: who said it and when, before the text */
const Hidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

const Compose = styled.form`
  display: grid;
  gap: ${space(1)};
  padding: ${space(2)} ${space(3)} ${space(3)};
  border-top: 1px solid ${color.line};
`

const Box = styled.div`
  display: flex;
  align-items: flex-end;
  gap: ${space(1)};
  padding: ${space(1)} ${space(1)} ${space(1)} ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface2};

  &:focus-within {
    border-color: ${color.focus};
  }
`

const Input = styled.textarea`
  flex: 1;
  min-width: 0;
  max-height: calc(5 * 1.5em + ${space(4)});
  padding: ${space(2)} 0;
  border: none;
  background: transparent;
  color: ${color.fg};
  font: inherit;
  font-size: ${fontSize.small};
  line-height: 1.5;
  resize: none;
  overflow-y: auto;

  &:focus {
    outline: none;
  }
  &::placeholder {
    color: ${color.muted};
  }
`

const Send = styled.button`
  display: inline-grid;
  place-items: center;
  flex: none;
  width: ${size.toolbarButton};
  height: ${size.toolbarButton};
  border: none;
  border-radius: ${radius.button};
  background: ${color.primary};
  color: ${color.onPrimary};
  cursor: pointer;

  svg {
    width: 20px;
    height: 20px;
  }
  &:disabled {
    background: transparent;
    color: ${color.muted};
    cursor: default;
  }
`

const Footer = styled.div`
  display: flex;
  justify-content: space-between;
  gap: ${space(2)};
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`

const Count = styled.span<{ $over: boolean }>`
  color: ${({ $over }) => ($over ? color.danger : color.muted)};
  font-variant-numeric: tabular-nums;
`

const Problem = styled.p`
  margin: 0;
  color: ${color.warn};
  font-size: ${fontSize.toolbarLabel};
`

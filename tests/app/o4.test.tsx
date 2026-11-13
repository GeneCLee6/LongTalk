// O4 (e5-t09): private messages in the browser. The chat box chooses who it writes to (everyone or
// one person the room would let us write to), private messages say who they were for in words, a
// reply goes back privately, the participants menu offers 私訊 and a host or co-host has the switch.
// The room decides again on every message (tests/worker/room-o4.test.ts).
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../shared/chat.ts'
import type { Member } from '../../shared/protocol.ts'
import type { Role } from '../../shared/roles.ts'
import { ChatPanel, type ChatRecipient } from '../../src/components/ChatPanel.tsx'
import { ChatPreview } from '../../src/components/ChatPreview.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { strings } from '../../src/strings.ts'

const at = new Date(2026, 10, 13, 21, 4).getTime()
const message = (id: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: 'b',
  name: '小潔',
  text: `m${id}`,
  at: at + id,
  ...extra,
})

const BOB: ChatRecipient = { id: 'b', name: '小潔' }
const DAN: ChatRecipient = { id: 'd', name: 'Dan' }

function chat(props: Partial<Parameters<typeof ChatPanel>[0]> = {}) {
  const onSend = vi.fn(() => 'sent' as const)
  const onTo = vi.fn()
  const view = render(
    <ChatPanel
      messages={[]}
      you="me"
      onSend={onSend}
      recipients={[BOB, DAN]}
      to={null}
      onTo={onTo}
      {...props}
    />,
  )
  return {
    ...view,
    onSend,
    onTo,
    input: () => screen.getByRole('textbox', { name: strings.chat.inputLabel }),
  }
}

describe('ChatPanel: private messages (O4)', () => {
  it('chooses who to write to: everyone first, then whom we may write to', () => {
    const { onTo } = chat()
    const select = screen.getByRole('combobox', { name: strings.chat.private.recipient })
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['所有人', '小潔', 'Dan'])
    fireEvent.change(select, { target: { value: 'd' } })
    expect(onTo).toHaveBeenCalledWith(DAN)
    fireEvent.change(select, { target: { value: '' } })
    expect(onTo).toHaveBeenLastCalledWith(null)
  })

  it('has no picker when there is nobody to write to privately', () => {
    chat({ recipients: [] })
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('sends privately to the chosen person, says who sees it, and offers no attachment', () => {
    const files = {
      uploads: [],
      pick: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      dismiss: vi.fn(),
      load: vi.fn(),
      download: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof ChatPanel>[0]['files']>
    const { onSend, input } = chat({ to: DAN, files })
    expect(input()).toHaveAttribute('placeholder', '私訊給 Dan…')
    expect(screen.getByText(strings.chat.private.hint('Dan'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: strings.chat.file.attach })).toBeNull()
    fireEvent.change(input(), { target: { value: '悄悄話' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('悄悄話', 'd')
  })

  it('keeps the text and says so when the chosen person left; never sends it to everyone', () => {
    const { onSend, input } = chat({ to: { id: 'z', name: 'Zoe' } })
    const select = screen.getByRole('combobox', { name: strings.chat.private.recipient })
    expect(select).toHaveValue('z')
    expect(within(select).getByRole('option', { name: 'Zoe（不在）' })).toBeInTheDocument()
    fireEvent.change(input(), { target: { value: '還在嗎' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(strings.chat.private.goneProblem('Zoe'))
    expect(input()).toHaveValue('還在嗎')
  })

  it('shows who a private message was for, in words, and replies privately', () => {
    const { onTo } = chat({
      messages: [
        message(1, { to: 'me', toName: 'Me' }),
        message(2, { from: 'me', name: 'Me', text: 'reply', to: 'd', toName: 'Dan' }),
        message(3, { text: 'everyone' }),
      ],
    })
    const log = screen.getByRole('log')
    expect(log).toHaveTextContent('小潔 → 你（私訊）· 21:04')
    expect(log).toHaveTextContent('你 → Dan（私訊）· 21:04')
    expect(log).toHaveTextContent('小潔 · 21:04')
    expect(log).toHaveTextContent('小潔 私訊 你，21:04：m1')
    // Only someone else's private message has 回覆
    const replies = screen.getAllByRole('button', { name: /回覆/ })
    expect(replies).toHaveLength(1)
    expect(replies[0]).toHaveAccessibleName(strings.chat.private.replyLabel('小潔'))
    fireEvent.click(replies[0])
    expect(onTo).toHaveBeenCalledWith(BOB)
  })

  it('previews a private message as one', () => {
    render(
      <ChatPreview
        message={message(4, { to: 'me', toName: 'Me' })}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /小潔（私訊）/ })).toBeInTheDocument()
  })
})

const person = (id: string, name: string, role: Role, joinedAt: number): Member => ({
  id,
  name,
  role,
  joinedAt,
  reconnecting: false,
  tracks: [],
  hand: null,
  signal: null,
  mayRecord: false,
})

const MEMBERS = [
  person('g', 'Gene', 'host', 1),
  person('x', '小潔', 'participant', 2),
  person('w', 'Wei', 'participant', 3),
]

function participants(
  you: string,
  overrides: Partial<Parameters<typeof ParticipantsPanel>[0]> = {},
) {
  const props = {
    members: MEMBERS,
    you,
    sharerIds: [],
    onAction: vi.fn(),
    onMuteAll: vi.fn(),
    onEndMeeting: vi.fn(),
    onPrivateMessage: vi.fn(),
    onPrivateChat: vi.fn(),
    ...overrides,
  }
  render(<ParticipantsPanel {...props} />)
  return props
}

describe('ParticipantsPanel: private messages (O4)', () => {
  it('offers 私訊 first to a participant, for whom they may write to', () => {
    const p = participants('x', { messageable: ['g'] })
    fireEvent.click(screen.getByRole('button', { name: '對 Gene 的動作' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['私訊'])
    fireEvent.click(screen.getByRole('menuitem', { name: '私訊' }))
    expect(p.onPrivateMessage).toHaveBeenCalledWith('g')
    // Wei is not among those they may write to (the switch is off): no menu at all
    expect(screen.queryByRole('button', { name: '對 Wei 的動作' })).toBeNull()
  })

  it('gives a host the switch; a participant does not see it', () => {
    const p = participants('g', { privateChat: true })
    const toggle = screen.getByRole('switch', { name: strings.chat.private.switch })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(p.onPrivateChat).toHaveBeenCalledWith(false)
  })

  it('hides the switch from a participant', () => {
    participants('x')
    expect(screen.queryByRole('switch', { name: strings.chat.private.switch })).toBeNull()
  })
})

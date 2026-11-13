// N2 (e9-t02; docs/PRD/f-remote-control-security.md §5.1): 更多 › 連接我的電腦 and its pairing
// code (hidden until 顯示, a countdown, 重新產生, 取消, the warning while sharing, `pair_busy`),
// the owner's 「這不是我」, and a desktop agent named 「<owner> 的電腦」 wherever a name shows. Each
// only asks; the room decides (the worker's own tests).
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAIRING_CODE_TTL_MS } from '../../shared/control.ts'
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type Member,
  type MemberAgent,
} from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'
import PairComputerDialog, {
  AGENT_DOWNLOAD_URL,
  type PairComputerDialogProps,
} from '../../src/components/PairComputerDialog.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { enRoom } from '../../src/i18n/en.ts'
import { zhTWRoom } from '../../src/i18n/zh-TW.ts'
import { memberLabel, nameAgents } from '../../src/room/agentNames.ts'
import {
  RoomConnection,
  type PairCodeState,
  type SocketLike,
} from '../../src/room/RoomConnection.ts'
import { setLocale, strings } from '../../src/strings.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

const CODE = '7K3MQ9TD'
const SHOWN = '7K3M-Q9TD'
const MASK = '••••-••••'

const member = (
  id: string,
  name: string,
  role: Member['role'] = 'participant',
  agent?: MemberAgent,
): Member => ({
  id,
  name,
  role,
  joinedAt: id.charCodeAt(0),
  reconnecting: false,
  tracks: [],
  hand: null,
  signal: null,
  mayRecord: false,
  ...(agent ? { agent } : {}),
})
const laptop = (owner: string | null): MemberAgent => ({
  owner,
  device: '客廳的筆電',
  platform: 'windows',
})

// ── The dictionaries ─────────────────────────────────────────────────────────────────────────

describe('the agent texts', () => {
  it('have the same keys in both languages', () => {
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([key, inner]) =>
        typeof inner === 'object' && inner !== null
          ? keys(inner).map((rest) => `${key}.${rest}`)
          : [key],
      )
    expect(keys(enRoom.agent).sort()).toEqual(keys(zhTWRoom.agent).sort())
  })
})

// ── The names ────────────────────────────────────────────────────────────────────────────────

describe('a desktop agent’s name', () => {
  const members = {
    a: member('a', 'Alice'),
    c: member('c', 'DESKTOP-01', 'participant', laptop('a')),
    d: member('d', 'x', 'participant', laptop(null)),
    e: member('e', 'y', 'participant', laptop('gone')),
  }

  it('is its owner’s computer, or its own name once the owner is gone', () => {
    expect(memberLabel(members.c, members)).toBe('Alice 的電腦')
    expect(memberLabel(members.d, members)).toBe('客廳的筆電（電腦）')
    expect(memberLabel(members.e, members)).toBe('客廳的筆電（電腦）')
    expect(memberLabel(members.a, members)).toBe('Alice')
  })

  it('is put in the view; a view without agents comes back as it was', () => {
    const view = {
      room: { id: 'abcdefghij', createdAt: 1, shares: {} },
      members,
      usage: 'normal',
    } as unknown as Parameters<typeof nameAgents>[0]
    const named = nameAgents(view)
    expect(named.members.c.name).toBe('Alice 的電腦')
    expect(named.members.a).toBe(members.a)
    const people = { ...view, members: { a: members.a } }
    expect(nameAgents(people)).toBe(people)
  })

  it('follows the language', () => {
    setLocale('en', false)
    try {
      expect(memberLabel(members.c, members)).toBe('Alice’s computer')
    } finally {
      setLocale('zh-TW', false)
    }
  })
})

// ── The connection ───────────────────────────────────────────────────────────────────────────

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }
  receive(message: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
}

describe('RoomConnection and `pairCode`', () => {
  afterEach(() => vi.useRealTimers())

  function connect() {
    let socket!: FakeSocket
    const connection = new RoomConnection(
      'abcdefghij',
      { name: 'Alice', token: null, client: null },
      {
        origin: 'ws://test',
        createSocket: () => {
          socket = new FakeSocket()
          return socket
        },
      },
    )
    connection.start()
    socket.open()
    return { connection, socket }
  }
  const welcome = {
    t: 'welcome',
    v: PROTOCOL_VERSION,
    you: 'a',
    token: 'T'.repeat(43),
    rev: 1,
    state: { room: { id: 'abcdefghij', createdAt: 1, shares: {} }, members: {}, usage: 'normal' },
  }

  it('keeps the code, with a deadline on our own clock, and its end', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { connection, socket } = connect()
    socket.receive({ t: 'pairCode', code: CODE, expiresAt: 1 })
    expect(connection.getState().pairCode).toBeNull()
    socket.receive(welcome)
    // A room clock far ahead: never longer than PAIRING_CODE_TTL_MS
    socket.receive({ t: 'pairCode', code: CODE, expiresAt: 1_000_000 + 10 * PAIRING_CODE_TTL_MS })
    const first = connection.getState().pairCode!
    expect(first).toMatchObject({ code: CODE, deadline: 1_000_000 + PAIRING_CODE_TTL_MS })
    socket.receive({ t: 'pairCode', code: null, expiresAt: null })
    const ended = connection.getState().pairCode!
    expect(ended).toMatchObject({ code: null, deadline: null })
    expect(ended.seq).toBeGreaterThan(first.seq)
    // A malformed one is ignored
    socket.receive({ t: 'pairCode', code: 7, expiresAt: null })
    expect(connection.getState().pairCode).toBe(ended)
  })
})

// ── The dialog ───────────────────────────────────────────────────────────────────────────────

describe('the 連接我的電腦 dialog', () => {
  let clock = 1_000_000
  const now = () => clock
  beforeEach(() => {
    clock = 1_000_000
  })
  afterEach(() => vi.useRealTimers())

  const code = (seq: number, value: string | null = CODE): PairCodeState => ({
    code: value,
    deadline: value === null ? null : clock + PAIRING_CODE_TTL_MS,
    seq,
  })

  function dialog(props: Partial<PairComputerDialogProps> = {}) {
    const handlers = {
      onGenerate: vi.fn(),
      onCancelCode: vi.fn(),
      onRemove: vi.fn(),
      onCopied: vi.fn(),
      onClose: vi.fn(),
    }
    const base: PairComputerDialogProps = {
      pairCode: null,
      myComputer: null,
      busy: false,
      paired: null,
      sharing: false,
      now,
      ...handlers,
      ...props,
    }
    const view = render(<PairComputerDialog {...base} />)
    const rerender = (next: Partial<PairComputerDialogProps>) =>
      view.rerender(<PairComputerDialog {...base} {...next} />)
    return { ...handlers, rerender }
  }
  const button = (name: string) => screen.getByRole('button', { name })

  it('says what it is, links the download, and asks the room for a code', () => {
    const { onGenerate, rerender } = dialog()
    const box = screen.getByRole('dialog', { name: strings.agent.title })
    expect(within(box).getByText(strings.agent.intro)).toBeTruthy()
    expect(within(box).getByRole('link', { name: strings.agent.download })).toHaveAttribute(
      'href',
      AGENT_DOWNLOAD_URL,
    )
    fireEvent.click(button(strings.agent.generate))
    expect(onGenerate).toHaveBeenCalledTimes(1)
    // Until the room answers
    expect((button(strings.agent.generating) as HTMLButtonElement).disabled).toBe(true)
    rerender({ pairCode: code(1) })
    expect(screen.getByText(strings.agent.codeHidden)).toBeTruthy()
  })

  it('hides the code until 顯示, and hides it again', () => {
    dialog({ pairCode: code(1) })
    expect(screen.queryByText(SHOWN)).toBeNull()
    expect(screen.getByText(MASK)).toBeTruthy()
    fireEvent.click(button(strings.agent.show))
    expect(screen.getByText(SHOWN)).toBeTruthy()
    expect(button(strings.agent.hide)).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(button(strings.agent.hide))
    expect(screen.queryByText(SHOWN)).toBeNull()
  })

  it('counts down, and says when the code ran out', () => {
    vi.useFakeTimers()
    dialog({ pairCode: code(1) })
    expect(screen.getByText(strings.agent.expiresIn('5:00'))).toBeTruthy()
    clock += 61_000
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText(strings.agent.expiresIn('3:59'))).toBeTruthy()
    clock += PAIRING_CODE_TTL_MS
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText(strings.agent.ended)).toBeTruthy()
    expect(button(strings.agent.regenerate)).toBeTruthy()
  })

  it('makes a new code, hidden again, and waits for it', () => {
    const { onGenerate, rerender } = dialog({ pairCode: code(1) })
    fireEvent.click(button(strings.agent.show))
    fireEvent.click(button(strings.agent.regenerate))
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: strings.agent.generating })).toBeTruthy()
    rerender({ pairCode: code(2, 'ABCDEFGH') })
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
    fireEvent.click(button(strings.agent.show))
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy()
  })

  it('取消 voids the code and goes back to the start', () => {
    const { onCancelCode, rerender } = dialog({ pairCode: code(1) })
    fireEvent.click(button(strings.agent.cancelCode))
    expect(onCancelCode).toHaveBeenCalledTimes(1)
    rerender({ pairCode: code(2, null) })
    expect(button(strings.agent.generate)).toBeTruthy()
    expect(screen.queryByText(strings.agent.ended)).toBeNull()
  })

  it('a code used or voided while open says so', () => {
    const { rerender } = dialog({ pairCode: code(1) })
    rerender({ pairCode: code(2, null) })
    expect(screen.getByText(strings.agent.ended)).toBeTruthy()
  })

  it('copies the code, formatted, without showing it', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const { onCopied } = dialog({ pairCode: code(1) })
      fireEvent.click(button(strings.agent.copy))
      await act(async () => {})
      expect(writeText).toHaveBeenCalledWith(SHOWN)
      expect(onCopied).toHaveBeenCalledWith(true)
      expect(screen.queryByText(SHOWN)).toBeNull()
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('warns while we share our screen', () => {
    const { rerender } = dialog({ pairCode: code(1) })
    expect(screen.queryByText(strings.agent.sharingWarning)).toBeNull()
    rerender({ sharing: true })
    expect(screen.getByRole('note')).toHaveTextContent(strings.agent.sharingWarning)
  })

  it('`pair_busy`, our computer in the room: 中斷我的電腦', () => {
    const { onRemove, rerender } = dialog()
    fireEvent.click(button(strings.agent.generate))
    rerender({ busy: true })
    expect(screen.getByText(strings.agent.busy)).toBeTruthy()
    // Not known yet: nothing to disconnect
    expect(screen.queryByRole('button', { name: strings.agent.disconnectMine })).toBeNull()
    rerender({ busy: true, myComputer: { id: 'c', device: '客廳的筆電' } })
    expect(screen.getByText(strings.agent.busyNamed('客廳的筆電'))).toBeTruthy()
    fireEvent.click(button(strings.agent.disconnectMine))
    expect(onRemove).toHaveBeenCalledWith('c')
    rerender({ busy: false, myComputer: null })
    expect(button(strings.agent.generate)).toBeTruthy()
  })

  it('names the computer that joined, with 這不是我', () => {
    const { onRemove, rerender } = dialog({ pairCode: code(1) })
    rerender({ pairCode: code(2, null), paired: { id: 'c', device: '客廳的筆電' } })
    expect(
      screen.getByRole('dialog', { name: strings.agent.pairedTitle('客廳的筆電') }),
    ).toBeTruthy()
    fireEvent.click(button(strings.agent.notMe))
    expect(onRemove).toHaveBeenCalledWith('c')
  })

  it('Escape closes it', () => {
    const { onClose } = dialog()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ── The participants list ────────────────────────────────────────────────────────────────────

describe('a computer in the participants list', () => {
  const panel = (you: string, members: Member[]) => {
    const onAgentRemove = vi.fn()
    const onAction = vi.fn()
    render(
      <ParticipantsPanel
        members={members}
        you={you}
        sharerIds={[]}
        onAction={onAction}
        onMuteAll={() => {}}
        onEndMeeting={() => {}}
        onAgentRemove={onAgentRemove}
      />,
    )
    return { onAgentRemove, onAction }
  }
  // As the room page shows it: named already (useRoomConnection)
  const computer = member('c', 'Alice 的電腦', 'participant', laptop('a'))

  it('shows the device, no microphone or camera, and 中斷 for its owner', () => {
    const { onAgentRemove } = panel('a', [member('a', 'Alice'), computer])
    const row = screen.getByRole('listitem', { name: 'Alice 的電腦' })
    expect(within(row).getByText('客廳的筆電 · Windows')).toBeTruthy()
    expect(within(row).queryByRole('img', { name: strings.participants.micOff })).toBeNull()
    expect(within(row).queryByRole('img', { name: strings.participants.camOff })).toBeNull()
    fireEvent.click(
      within(row).getByRole('button', { name: strings.agent.disconnectLabel('Alice 的電腦') }),
    )
    expect(onAgentRemove).toHaveBeenCalledWith('c')
  })

  it('someone else has no 中斷; a host removes it from the menu, and cannot make it co-host', () => {
    panel('h', [member('h', 'Hana', 'host'), member('a', 'Alice'), computer])
    const row = screen.getByRole('listitem', { name: 'Alice 的電腦' })
    expect(
      within(row).queryByRole('button', { name: strings.agent.disconnectLabel('Alice 的電腦') }),
    ).toBeNull()
    fireEvent.click(
      within(row).getByRole('button', { name: strings.participants.actions('Alice 的電腦') }),
    )
    expect(screen.getByRole('menuitem', { name: strings.participants.remove })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: strings.participants.makeCohost })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: strings.participants.makeHost })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: strings.record.allow })).toBeNull()
  })
})

// ── The room page ────────────────────────────────────────────────────────────────────────────

const ROOM_ID = 'abcdefghij'
const TOKEN = 'N'.repeat(43)

class RoomSocket {
  static instances: RoomSocket[] = []
  static members: Member[] = []
  static shares: Record<string, { memberId: string; since: number }> = {}
  readyState = 0
  sent: ClientMessage[] = []
  rev = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor() {
    RoomSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(data: string) {
    if (data === 'ping') return
    const message = JSON.parse(data) as ClientMessage
    this.sent.push(message)
    if (message.t !== 'join') return
    const state = {
      room: { id: ROOM_ID, createdAt: 1, shares: RoomSocket.shares, spotlight: null },
      members: Object.fromEntries(RoomSocket.members.map((m) => [m.id, m])),
      waiting: {},
      usage: 'normal',
    }
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({
          t: 'welcome',
          v: PROTOCOL_VERSION,
          you: 'a',
          token: TOKEN,
          rev: 1,
          state,
        }),
      }),
    )
  }
  close() {}
  receive(frame: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }))
  }
  patch(ops: unknown[]) {
    this.rev += 1
    this.receive({ t: 'patch', rev: this.rev, ops })
  }
}

describe('pairing in the room page', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', RoomSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === `/api/rooms/${ROOM_ID}`
          ? Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 1 })
          : Response.json({ error: 'not_found' }, { status: 404 }),
      ),
    )
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('longtalk.client', 'browser-id-0123456789')
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    RoomSocket.instances = []
    RoomSocket.shares = {}
    window.history.replaceState(null, '', '/')
  })

  async function enter(members: Member[]) {
    RoomSocket.members = members
    window.history.pushState({}, '', `/r/${ROOM_ID}`)
    render(<App />)
    await screen.findByRole('toolbar', { name: strings.devices.controls })
    await screen.findByRole('button', { name: strings.toolbar.more })
    return RoomSocket.instances.at(-1)!
  }
  const openMore = () => fireEvent.click(screen.getByRole('button', { name: strings.toolbar.more }))
  async function openDialog() {
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: strings.agent.menu }))
    return screen.findByRole('dialog', { name: strings.agent.title })
  }

  it('更多 › 連接我的電腦 opens the dialog (its own chunk); the code arrives hidden', async () => {
    const socket = await enter([member('a', 'Gene'), member('b', 'Bob')])
    const box = await openDialog()
    fireEvent.click(within(box).getByRole('button', { name: strings.agent.generate }))
    expect(socket.sent).toContainEqual({ t: 'pairStart' })
    socket.receive({ t: 'pairCode', code: CODE, expiresAt: Date.now() + PAIRING_CODE_TTL_MS })
    expect(within(box).getByText(strings.agent.codeHidden)).toBeTruthy()
    expect(within(box).queryByText(SHOWN)).toBeNull()
    fireEvent.click(within(box).getByRole('button', { name: strings.agent.show }))
    expect(within(box).getByText(SHOWN)).toBeTruthy()
    fireEvent.click(within(box).getByRole('button', { name: strings.agent.cancelCode }))
    expect(socket.sent).toContainEqual({ t: 'pairCancel' })
  })

  it('`pair_busy`: says our computer is in the room, and disconnects it', async () => {
    const socket = await enter([
      member('a', 'Gene'),
      member('c', 'DESKTOP', 'participant', laptop('a')),
    ])
    const box = await openDialog()
    // Our computer is already here: the dialog says so before anything is asked
    expect(within(box).getByText(strings.agent.busyNamed('客廳的筆電'))).toBeTruthy()
    socket.receive({ t: 'error', code: 'pair_busy' })
    fireEvent.click(within(box).getByRole('button', { name: strings.agent.disconnectMine }))
    expect(socket.sent).toContainEqual({ t: 'agentRemove', memberId: 'c' })
  })

  it('`agentPaired`: the toast names the computer, and 這不是我 removes it', async () => {
    const socket = await enter([member('a', 'Gene')])
    socket.patch([
      {
        op: 'set',
        path: ['members', 'c'],
        value: member('c', 'DESKTOP', 'participant', laptop('a')),
      },
    ])
    socket.receive({ t: 'notice', notice: 'agentPaired', by: 'c' })
    const toast = screen.getByText(strings.agent.paired('客廳的筆電')).parentElement!
    fireEvent.click(within(toast).getByRole('button', { name: strings.agent.notMe }))
    expect(socket.sent).toContainEqual({ t: 'agentRemove', memberId: 'c' })
  })

  it('`pairingVoided` says so', async () => {
    const socket = await enter([member('a', 'Gene')])
    socket.receive({ t: 'notice', notice: 'pairingVoided', by: 'a' })
    expect(screen.getByText(strings.agent.voided)).toBeTruthy()
  })

  it('a computer is 「<owner> 的電腦」 in the list, has no camera tile, and its share is tagged so', async () => {
    const socket = await enter([
      member('a', 'Gene'),
      member('b', 'Bob'),
      member('c', 'DESKTOP', 'participant', laptop('b')),
    ])
    const grid = screen.getAllByRole('region', { name: strings.room.grid })[0]
    expect(within(grid).getByLabelText('Bob')).toBeTruthy()
    expect(within(grid).queryByLabelText('Bob 的電腦')).toBeNull()
    expect(within(grid).queryByLabelText('DESKTOP')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.toolbar.participants) }))
    const row = await screen.findByRole('listitem', { name: 'Bob 的電腦' })
    expect(within(row).getByText('客廳的筆電 · Windows')).toBeTruthy()
    // Not ours: no 中斷
    expect(
      within(row).queryByRole('button', { name: strings.agent.disconnectLabel('Bob 的電腦') }),
    ).toBeNull()
    socket.patch([{ op: 'set', path: ['room', 'shares', 'c'], value: { memberId: 'c', since: 9 } }])
    const share = await screen.findByRole('figure', {
      name: strings.screenShare.region('Bob 的電腦'),
    })
    expect(within(share).getByText('Bob 的電腦')).toBeTruthy()
  })

  it('the menu entry is there for a participant (pairComputer is anyone’s)', async () => {
    await enter([member('a', 'Gene'), member('h', 'Hana', 'host')])
    openMore()
    expect(screen.getByRole('menuitem', { name: strings.agent.menu })).toBeTruthy()
  })
})

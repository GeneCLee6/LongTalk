// N3 (e9-t04, e9-t05; docs/PRD/f-remote-control-security.md §5.2–§5.6): the browser's side of
// remote control. The controller's batches (ControlSender: moves merged every CONTROL_BATCH_MS,
// keys and clicks at once, seq from 1, the hold keepalive, releasing what is held), our own request
// and grant in RoomConnection, and the room page: 請求控制 on a computer's share, its status for
// everyone, 停止控制, the capture layer, the notices, a host's 停止遠端控制. Each only asks; the
// room decides (tests/worker/room-n3.test.ts).
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_BATCH_MS,
  CONTROL_HOLD_KEEPALIVE_MS,
  MAX_CONTROL_BATCH,
  MAX_TEXT_CHARS,
  MOD_CTRL,
  MOD_SHIFT,
  type ControlEventMessage,
} from '../../shared/control.ts'
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type Member,
  type MemberAgent,
} from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { enRoom } from '../../src/i18n/en.ts'
import { zhTWRoom } from '../../src/i18n/zh-TW.ts'
import { ControlSender, buttonOf, modsOf } from '../../src/room/controlSender.ts'
import { RoomConnection, type SocketLike } from '../../src/room/RoomConnection.ts'
import { strings } from '../../src/strings.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

const GRANT = 'G'.repeat(22)
const REQUEST = 'R'.repeat(22)

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

describe('the control texts', () => {
  it('have the same keys in both languages', () => {
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([key, inner]) =>
        typeof inner === 'object' && inner !== null
          ? keys(inner).map((rest) => `${key}.${rest}`)
          : [key],
      )
    expect(keys(enRoom.control).sort()).toEqual(keys(zhTWRoom.control).sort())
  })
})

// ── The controller's batches ─────────────────────────────────────────────────────────────────

describe('ControlSender (e9-t05)', () => {
  afterEach(() => vi.useRealTimers())

  function sender() {
    const sent: ControlEventMessage[] = []
    return { sent, control: new ControlSender(GRANT, (message) => sent.push(message)) }
  }

  it('merges moves within CONTROL_BATCH_MS, numbering batches from 1', () => {
    vi.useFakeTimers()
    const { sent, control } = sender()
    control.move(0.1, 0.1)
    control.move(0.2, 0.2)
    control.move(1.5, -3) // clamped to the picture
    expect(sent).toEqual([])
    vi.advanceTimersByTime(CONTROL_BATCH_MS)
    expect(sent).toEqual([
      { t: 'controlEvent', grant: GRANT, seq: 1, events: [{ type: 'move', x: 1, y: 0 }] },
    ])
    control.move(0.5, 0.5)
    vi.advanceTimersByTime(CONTROL_BATCH_MS)
    expect(sent.map((m) => m.seq)).toEqual([1, 2])
  })

  it('sends clicks, keys, wheel and text at once, with the moves before them', () => {
    vi.useFakeTimers()
    const { sent, control } = sender()
    control.move(0.3, 0.4)
    control.button('left', true)
    expect(sent).toEqual([
      {
        t: 'controlEvent',
        grant: GRANT,
        seq: 1,
        events: [
          { type: 'move', x: 0.3, y: 0.4 },
          { type: 'button', button: 'left', down: true },
        ],
      },
    ])
    expect(control.key('KeyA', true, MOD_CTRL)).toBe(true)
    control.wheel(0, 120.4)
    control.text('你好')
    expect(sent.slice(1).map((m) => m.events)).toEqual([
      [{ type: 'key', code: 'KeyA', down: true, mods: MOD_CTRL }],
      [{ type: 'wheel', dx: 0, dy: 120 }],
      [{ type: 'text', text: '你好' }],
    ])
    // Keys the agent will not press are not sent at all
    expect(control.key('MediaPlayPause', true, 0)).toBe(false)
    expect(control.key('Power', true, 0)).toBe(false)
    expect(sent).toHaveLength(4)
  })

  it('splits long text and big batches; drops an up for something never pressed here', () => {
    const { sent, control } = sender()
    control.text('字'.repeat(MAX_TEXT_CHARS + 1))
    expect(sent.map((m) => m.events)).toEqual([
      [{ type: 'text', text: '字'.repeat(MAX_TEXT_CHARS) }],
      [{ type: 'text', text: '字' }],
    ])
    control.button('right', false)
    control.key('KeyB', false, 0)
    expect(sent).toHaveLength(2)
    for (let i = 0; i < MAX_CONTROL_BATCH + 5; i++) control.push({ type: 'wheel', dx: 0, dy: 1 })
    expect(sent.every((m) => m.events.length <= MAX_CONTROL_BATCH)).toBe(true)
    // Text the agent would refuse (a control character) is not sent
    control.text('a\u0007b')
    expect(sent.at(-1)!.events).not.toEqual([{ type: 'text', text: 'a\u0007b' }])
  })

  it('repeats the last move while something is held, so the agent keeps holding it', () => {
    vi.useFakeTimers()
    const { sent, control } = sender()
    control.move(0.5, 0.5)
    control.button('left', true)
    const before = sent.length
    vi.advanceTimersByTime(CONTROL_HOLD_KEEPALIVE_MS + CONTROL_BATCH_MS)
    expect(sent.length).toBe(before + 1)
    expect(sent.at(-1)!.events).toEqual([{ type: 'move', x: 0.5, y: 0.5 }])
    control.button('left', false)
    const after = sent.length
    vi.advanceTimersByTime(CONTROL_HOLD_KEEPALIVE_MS * 3)
    expect(sent.length).toBe(after)
  })

  it('releases everything held when the window blurs and when it stops, then sends nothing', () => {
    const { sent, control } = sender()
    control.key('ShiftLeft', true, MOD_SHIFT)
    control.key('KeyA', true, MOD_SHIFT)
    control.button('left', true)
    control.releaseAll()
    expect(sent.at(-1)!.events).toEqual([
      { type: 'key', code: 'KeyA', down: false, mods: 0 },
      { type: 'key', code: 'ShiftLeft', down: false, mods: 0 },
      { type: 'button', button: 'left', down: false },
    ])
    expect(control.held.size).toBe(0)
    control.key('ControlLeft', true, MOD_CTRL)
    control.stop()
    expect(sent.at(-1)!.events).toEqual([
      { type: 'key', code: 'ControlLeft', down: false, mods: 0 },
    ])
    const count = sent.length
    control.move(0.1, 0.1)
    control.key('KeyA', true, 0)
    control.flush()
    expect(sent).toHaveLength(count)
  })

  it('reads modifiers and buttons as the agent knows them', () => {
    expect(modsOf({ shiftKey: true, ctrlKey: true, altKey: false, metaKey: false })).toBe(
      MOD_SHIFT | MOD_CTRL,
    )
    expect([0, 1, 2, 3].map(buttonOf)).toEqual(['left', 'middle', 'right', null])
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

describe('RoomConnection and our own control', () => {
  const welcome = {
    t: 'welcome',
    v: PROTOCOL_VERSION,
    you: 'a',
    token: 'T'.repeat(43),
    rev: 1,
    state: { room: { id: 'abcdefghij', createdAt: 1, shares: {} }, members: {}, usage: 'normal' },
  }

  it('follows the request and the grant, and forgets them with a new socket', () => {
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
    const heard: string[] = []
    connection.onControl((message) => heard.push(message.t))
    connection.start()
    socket.open()
    // Before the welcome: nothing
    socket.receive({ t: 'controlRequested', request: REQUEST, agent: 'c' })
    expect(connection.getState().control).toBeNull()
    socket.receive(welcome)
    socket.receive({ t: 'controlRequested', request: REQUEST, agent: 'c' })
    expect(connection.getState().control).toEqual({
      agent: 'c',
      request: REQUEST,
      grant: null,
      until: null,
    })
    socket.receive({ t: 'controlGranted', grant: GRANT, agent: 'c', until: 5000 })
    expect(connection.getState().control).toEqual({
      agent: 'c',
      request: null,
      grant: GRANT,
      until: 5000,
    })
    // Another grant's end changes nothing; ours clears it
    socket.receive({ t: 'controlEnd', grant: 'X'.repeat(22), reason: 'expired' })
    expect(connection.getState().control?.grant).toBe(GRANT)
    socket.receive({ t: 'controlEnd', grant: GRANT, reason: 'agentStopped' })
    expect(connection.getState().control).toBeNull()
    expect(heard).toEqual(['controlRequested', 'controlGranted', 'controlEnd', 'controlEnd'])
    socket.receive({ t: 'controlGranted', grant: GRANT, agent: 'c', until: null })
    socket.receive(welcome)
    expect(connection.getState().control).toBeNull()
  })
})

// ── The participants list ────────────────────────────────────────────────────────────────────

describe('a controlled computer in the participants list', () => {
  it('a host stops the control from its menu; a participant has no such entry', () => {
    const onAction = vi.fn()
    const members = [
      member('a', 'Gene', 'host'),
      member('b', 'Bob'),
      member('c', 'Bob 的電腦', 'participant', laptop('b')),
    ]
    const { rerender } = render(
      <ParticipantsPanel
        members={members}
        you="a"
        sharerIds={['c']}
        controlledIds={['c']}
        onAction={onAction}
        onMuteAll={() => {}}
        onEndMeeting={() => {}}
      />,
    )
    const row = screen.getByRole('listitem', { name: 'Bob 的電腦' })
    fireEvent.click(within(row).getByRole('button', { name: /Bob 的電腦/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: strings.control.stopTheirs }))
    expect(onAction).toHaveBeenCalledWith('stopControl', 'c')
    rerender(
      <ParticipantsPanel
        members={members.map((m) => (m.id === 'a' ? { ...m, role: 'participant' } : m))}
        you="a"
        sharerIds={['c']}
        controlledIds={['c']}
        onAction={onAction}
        onMuteAll={() => {}}
        onEndMeeting={() => {}}
      />,
    )
    expect(screen.queryByRole('menuitem', { name: strings.control.stopTheirs })).toBeNull()
  })
})

// ── The room page ────────────────────────────────────────────────────────────────────────────

const ROOM_ID = 'abcdefghij'
const TOKEN = 'N'.repeat(43)

class RoomSocket {
  static instances: RoomSocket[] = []
  static members: Member[] = []
  static room: Record<string, unknown> = {}
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
      room: {
        id: ROOM_ID,
        createdAt: 1,
        shares: { c: { memberId: 'c', since: 9 } },
        spotlight: null,
        ...RoomSocket.room,
      },
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

describe('remote control in the room page', () => {
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
    RoomSocket.room = {}
    window.history.replaceState(null, '', '/')
  })

  async function enter(members: Member[] = []) {
    RoomSocket.members = [
      member('a', 'Gene'),
      member('b', 'Bob'),
      member('c', 'DESKTOP', 'participant', laptop('b')),
      ...members,
    ]
    window.history.pushState({}, '', `/r/${ROOM_ID}`)
    render(<App />)
    await screen.findByRole('toolbar', { name: strings.devices.controls })
    const share = await screen.findByRole('figure', {
      name: strings.screenShare.region('Bob 的電腦'),
    })
    return { socket: RoomSocket.instances.at(-1)!, share }
  }

  it('asks for control of a computer’s share, then may cancel', async () => {
    const { socket, share } = await enter()
    fireEvent.click(within(share).getByRole('button', { name: strings.control.request }))
    expect(socket.sent).toContainEqual({ t: 'controlRequest', agent: 'c' })
    socket.receive({ t: 'controlRequested', request: REQUEST, agent: 'c' })
    socket.patch([
      {
        op: 'set',
        path: ['control'],
        value: { c: { agent: 'c', controller: 'a', phase: 'asking', since: 1, until: 61_000 } },
      },
    ])
    expect(within(share).getByText(strings.control.waitingAnswer)).toBeTruthy()
    fireEvent.click(within(share).getByRole('button', { name: strings.control.cancel }))
    expect(socket.sent).toContainEqual({ t: 'controlCancel', request: REQUEST })
    socket.receive({ t: 'controlRefused', request: REQUEST, reason: 'denied' })
    expect(screen.getByText(strings.control.refused.denied)).toBeTruthy()
  })

  it('shows everyone who controls the computer, with no button for them', async () => {
    const { socket, share } = await enter()
    socket.patch([
      {
        op: 'set',
        path: ['control'],
        value: {
          c: { agent: 'c', controller: 'b', phase: 'granted', since: 1, until: Date.now() + 600_000 },
        },
      },
    ])
    expect(within(share).getByText(new RegExp(strings.control.controlling('Bob')))).toBeTruthy()
    expect(within(share).queryByRole('button', { name: strings.control.request })).toBeNull()
    socket.receive({ t: 'notice', notice: 'controlStarted', by: 'b', agent: 'c' })
    expect(screen.getByText(strings.control.started('Bob', 'Bob 的電腦'))).toBeTruthy()
    socket.receive({ t: 'notice', notice: 'controlEnded', by: 'b', agent: 'c', reason: 'expired' })
    expect(
      screen.getByText(strings.control.ended('Bob 的電腦', strings.control.reasons.expired)),
    ).toBeTruthy()
  })

  it('offers nothing in a room that turned remote control off', async () => {
    RoomSocket.room = { allowControl: false }
    const { share } = await enter()
    expect(within(share).queryByRole('button', { name: strings.control.request })).toBeNull()
  })

  it('says why the room refused a request', async () => {
    const { socket } = await enter()
    socket.receive({ t: 'error', code: 'control_muted' })
    expect(screen.getByText(strings.control.errors.control_muted)).toBeTruthy()
  })

  it('with a grant: 停止控制, and the capture sends our keys for that grant', async () => {
    const { socket, share } = await enter()
    socket.receive({ t: 'controlGranted', grant: GRANT, agent: 'c', until: Date.now() + 600_000 })
    socket.patch([
      {
        op: 'set',
        path: ['control'],
        value: {
          c: { agent: 'c', controller: 'a', phase: 'granted', since: 1, until: Date.now() + 600_000 },
        },
      },
    ])
    expect(within(share).getByText(new RegExp(strings.control.youControl))).toBeTruthy()
    fireEvent.click(within(share).getByRole('button', { name: strings.control.stop }))
    expect(socket.sent).toContainEqual({ t: 'controlStop', grant: GRANT })
    // The room's end clears our grant: the button goes (the capture, which waits for the
    // picture's frames that jsdom never has, is ControlLayer over ControlSender, tested above)
    socket.receive({ t: 'controlEnd', grant: GRANT, reason: 'controllerStopped' })
    socket.patch([{ op: 'set', path: ['control'], value: null }])
    expect(within(share).queryByRole('button', { name: strings.control.stop })).toBeNull()
    expect(within(share).getByRole('button', { name: strings.control.request })).toBeTruthy()
  })
})

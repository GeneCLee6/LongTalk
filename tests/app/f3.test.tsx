// F3 in the browser (e1-t15 – e1-t17): the link's ?pwd=, the pre-join password, the host's
// password and co-host controls, and the host's leave question
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASSWORD_WAIT_MS } from '../../shared/password.ts'
import { PROTOCOL_VERSION, type Member } from '../../shared/protocol.ts'
import { scrubErrorText } from '../../shared/telemetry.ts'
import { App } from '../../src/App.tsx'
import { LeaveDialog, PasswordDialog } from '../../src/components/HostDialogs.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { RoomConnection, type SocketLike } from '../../src/room/RoomConnection.ts'
import {
  currentPassword,
  linkPassword,
  linkWithPassword,
  reconcileKnown,
  takePasswordFromUrl,
} from '../../src/room/roomPassword.ts'
import { Telemetry } from '../../src/telemetry.ts'

const ROOM_ID = 'abcdefghij'
const TOKEN = 'S'.repeat(43)
const CLIENT = 'browser-id-0123456789'

type Frame = Record<string, unknown>

/** A WebSocket stand-in whose answers each test scripts */
class RoomSocket {
  static instances: RoomSocket[] = []
  static onJoin: (socket: RoomSocket, join: Frame) => void = () => {}
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    RoomSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(data: string) {
    this.sent.push(data)
    const message = JSON.parse(data) as Frame
    if (message.t === 'join') RoomSocket.onJoin(this, message)
  }
  close() {}
  receive(frame: Frame) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const member = (id: string, name: string, role: Member['role'], joinedAt: number): Member => ({
  id,
  name,
  role,
  joinedAt,
  reconnecting: false,
  tracks: [],
  hand: null,
})

function welcome(members: Member[], room: Frame = {}): Frame {
  return {
    t: 'welcome',
    v: PROTOCOL_VERSION,
    you: 'a',
    token: TOKEN,
    rev: 1,
    state: {
      room: { id: ROOM_ID, createdAt: 1, passwordSetAt: null, ...room },
      members: Object.fromEntries(members.map((m) => [m.id, m])),
      waiting: {},
      usage: 'normal',
    },
  }
}

function stubApi(summary: Frame = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === `/api/rooms/${ROOM_ID}`
        ? Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 1, ...summary })
        : Response.json({ error: 'not_found' }, { status: 404 }),
    ),
  )
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', RoomSocket)
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('longtalk.client', CLIENT)
  localStorage.setItem('longtalk.name', 'Gene')
})

afterEach(() => {
  vi.unstubAllGlobals()
  RoomSocket.instances = []
  RoomSocket.onJoin = () => {}
  window.history.replaceState(null, '', '/')
})

describe('?pwd= in the link (e1-t15)', () => {
  it('is read once and removed from the address bar, keeping everything else', () => {
    window.history.replaceState({ keep: 1 }, '', `/r/${ROOM_ID}?ice=relay&pwd=tea4two#x`)
    expect(takePasswordFromUrl()).toBe('tea4two')
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      `/r/${ROOM_ID}?ice=relay#x`,
    )
    expect(window.location.href).not.toContain('tea4two')
    expect(window.history.state).toEqual({ keep: 1 })
    expect(linkPassword(ROOM_ID)).toBe('tea4two')
    expect(linkPassword('bcdefghijk')).toBeNull()
  })

  it('is removed even when it is not a valid password', () => {
    window.history.replaceState(null, '', `/r/${ROOM_ID}?pwd=a%20b`)
    expect(takePasswordFromUrl()).toBeNull()
    expect(window.location.search).toBe('')
    expect(linkPassword(ROOM_ID)).toBeNull()
    window.history.replaceState(null, '', `/r/${ROOM_ID}?x=1`)
    expect(takePasswordFromUrl()).toBeNull()
    expect(window.location.search).toBe('?x=1')
  })

  it('never reaches telemetry or the socket URL; it travels only in the join message', () => {
    window.history.replaceState(null, '', `/r/${ROOM_ID}?pwd=tea4two`)
    takePasswordFromUrl()
    const sent: string[] = []
    const t = new Telemetry({ send: (body) => sent.push(body), random: () => 0 })
    t.reportError('error', new Error(`failed at ${window.location.href} pwd=tea4two`))
    t.flush()
    expect(sent.join('')).not.toContain('tea4two')
    expect(scrubErrorText('see pwd=secret1&x=1')).toBe('see pwd=<password>&x=1')
    const sockets: { url: string; sent: string[] }[] = []
    const connection = new RoomConnection(
      ROOM_ID,
      { name: 'Gene', token: null, client: CLIENT, password: 'tea4two' },
      {
        origin: 'wss://example.test',
        createSocket: (url) => {
          const socket = { url, sent: [] as string[] }
          sockets.push(socket)
          const like: SocketLike = {
            readyState: 1,
            send: (data) => socket.sent.push(data),
            close: () => {},
            onopen: null,
            onmessage: null,
            onclose: null,
          }
          queueMicrotask(() => like.onopen?.(new Event('open')))
          return like
        },
      },
    )
    connection.start()
    return Promise.resolve().then(() => {
      expect(sockets[0].url).not.toContain('tea4two')
      expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ t: 'join', password: 'tea4two' })
      connection.stop()
    })
  })

  it('makes the link with the password, and knows when it is still the current one', () => {
    expect(linkWithPassword(`https://x.test/r/${ROOM_ID}`, 'a&b=1')).toBe(
      `https://x.test/r/${ROOM_ID}?pwd=a%26b%3D1`,
    )
    // Typed on the pre-join screen: confirmed by the first report
    expect(reconcileKnown({ password: 'p1p1', setAt: null }, 50)).toEqual({
      password: 'p1p1',
      setAt: 50,
    })
    // Set here while the room still had another: waits for the change
    const pending = { password: 'p2p2', setAt: null, after: 50 }
    expect(reconcileKnown(pending, 50)).toBe(pending)
    expect(currentPassword(pending, 50)).toBeNull()
    expect(reconcileKnown(pending, 60)).toEqual({ password: 'p2p2', setAt: 60 })
    // Changed or cleared since: forgotten
    expect(reconcileKnown({ password: 'p1p1', setAt: 50 }, 70)).toBeNull()
    expect(reconcileKnown({ password: 'p1p1', setAt: 50 }, null)).toBeNull()
    expect(currentPassword({ password: 'p1p1', setAt: 50 }, 50)).toBe('p1p1')
  })
})

describe('joining a room with a password (e1-t15)', () => {
  it('asks for it, sends it in join, and asks again after a wrong one and a wait', async () => {
    stubApi({ passwordSetAt: 5 })
    window.history.replaceState(null, '', `/r/${ROOM_ID}`)
    takePasswordFromUrl()
    render(<App />)
    const field = await screen.findByLabelText('會議室密碼')
    expect(screen.getByText(/這間會議室有密碼/)).toBeInTheDocument()
    const join = screen.getByRole('button', { name: '加入' })
    expect(join).toBeDisabled()
    fireEvent.change(field, { target: { value: 'ab' } })
    expect(screen.getByText('密碼是 4–12 個英文字母、數字或符號。')).toBeInTheDocument()
    expect(join).toBeDisabled()
    fireEvent.change(field, { target: { value: 'wrong1' } })
    expect(join).toBeEnabled()
    RoomSocket.onJoin = (socket) => queueMicrotask(() => socket.onclose?.({ code: 4402 }))
    fireEvent.click(join)
    expect(await screen.findByText('密碼不對，請再試一次。')).toBeInTheDocument()
    const sentJoin = JSON.parse(RoomSocket.instances[0].sent[0]) as Frame
    expect(sentJoin).toMatchObject({ t: 'join', password: 'wrong1', token: null })
    expect(RoomSocket.instances[0].url).not.toContain('wrong1')
    // Too many: the room says how long to wait, and joining waits
    RoomSocket.onJoin = (socket) =>
      queueMicrotask(() => socket.onclose?.({ code: 4429, reason: String(PASSWORD_WAIT_MS) }))
    fireEvent.change(screen.getByLabelText('會議室密碼'), { target: { value: 'wrong2' } })
    fireEvent.click(screen.getByRole('button', { name: '加入' }))
    expect(await screen.findByText(/密碼錯太多次，請等 30 秒再試/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加入' })).toBeDisabled()
  })

  it('fills it in from the link', async () => {
    stubApi({ passwordSetAt: 5 })
    window.history.replaceState(null, '', `/r/${ROOM_ID}?pwd=tea4two`)
    takePasswordFromUrl()
    render(<App />)
    expect(await screen.findByLabelText('會議室密碼')).toHaveValue('tea4two')
    expect(screen.getByText('已從連結帶入密碼。')).toBeInTheDocument()
    expect(window.location.search).toBe('')
  })
})

describe('the host in the room (e1-t15 – e1-t17)', () => {
  async function enter(members: Member[], room: Frame = {}) {
    stubApi()
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    RoomSocket.onJoin = (socket) => queueMicrotask(() => socket.receive(welcome(members, room)))
    window.history.replaceState(null, '', `/r/${ROOM_ID}`)
    render(<App />)
    await screen.findByText(`目前 ${members.length} 人在線`)
    return RoomSocket.instances.at(-1)!
  }
  const lastSent = (socket: RoomSocket) => JSON.parse(socket.sent.at(-1)!) as Frame

  it('sets a password, then offers the link with it', async () => {
    const socket = await enter([member('a', 'Gene', 'host', 1)])
    fireEvent.click(screen.getByRole('button', { name: /^參與者/ }))
    fireEvent.click(screen.getByRole('button', { name: '設定會議室密碼' }))
    const dialog = screen.getByRole('dialog', { name: '設定會議室密碼' })
    fireEvent.change(within(dialog).getByLabelText('密碼'), { target: { value: 'ｔｅａ４ｔｗｏ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存' }))
    expect(lastSent(socket)).toEqual({ t: 'host', action: 'setPassword', password: 'tea4two' })
    expect(screen.getByText('已設定會議室密碼')).toBeInTheDocument()
    // The room reports it: the more menu offers the link with the password
    await act(async () =>
      socket.receive({
        t: 'patch',
        rev: 2,
        ops: [{ op: 'set', path: ['room', 'passwordSetAt'], value: 99 }],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menuitem', { name: '複製含密碼的連結' })).toBeInTheDocument()
  })

  it('names a co-host and hands over after asking', async () => {
    const socket = await enter([
      member('a', 'Gene', 'host', 1),
      member('b', 'Bob', 'participant', 2),
    ])
    fireEvent.click(screen.getByRole('button', { name: /^參與者/ }))
    fireEvent.click(screen.getByRole('button', { name: '對 Bob 的動作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '設為共同主持人' }))
    expect(lastSent(socket)).toEqual({ t: 'host', action: 'setCohost', memberId: 'b', on: true })
    fireEvent.click(screen.getByRole('button', { name: '對 Bob 的動作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '設為主持人' }))
    const ask = screen.getByRole('alertdialog', { name: '把主持人交給 Bob？' })
    fireEvent.click(within(ask).getByRole('button', { name: '交給對方' }))
    expect(lastSent(socket)).toEqual({ t: 'host', action: 'makeHost', memberId: 'b' })
  })

  it('a member sees who made them a co-host', async () => {
    const socket = await enter([
      member('h', 'Gene', 'host', 1),
      member('a', 'Bob', 'participant', 2),
    ])
    await act(async () => socket.receive({ t: 'notice', notice: 'madeCohost', by: 'h' }))
    expect(screen.getByText('主持人 Gene 把你設為共同主持人。')).toBeInTheDocument()
  })

  it('asks a host who leaves: only me (and who takes over), or end for everyone', async () => {
    const socket = await enter([
      member('a', 'Gene', 'host', 1),
      member('b', 'Bob', 'participant', 2),
      member('c', 'Carol', 'cohost', 3),
    ])
    fireEvent.click(screen.getByRole('button', { name: '離開' }))
    const dialog = screen.getByRole('dialog', { name: '要離開會議嗎？' })
    // The room's own pick (the co-host) comes first
    const select = within(dialog).getByLabelText('誰接手主持人')
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Carol（自動）', 'Bob'])
    fireEvent.click(within(dialog).getByRole('button', { name: '結束會議（所有人）' }))
    expect(lastSent(socket)).toEqual({ t: 'host', action: 'endMeeting' })
    await act(async () => socket.onclose?.({ code: 4411 }))
    expect(screen.getByRole('heading', { name: '你已結束會議' })).toBeInTheDocument()
  })

  it('leaves naming someone else as the next host', async () => {
    const socket = await enter([
      member('a', 'Gene', 'host', 1),
      member('b', 'Bob', 'participant', 2),
      member('c', 'Carol', 'cohost', 3),
    ])
    fireEvent.click(screen.getByRole('button', { name: '離開' }))
    const dialog = screen.getByRole('dialog', { name: '要離開會議嗎？' })
    fireEvent.change(within(dialog).getByLabelText('誰接手主持人'), { target: { value: 'b' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '只有我離開' }))
    expect(lastSent(socket)).toEqual({ t: 'leave', host: 'b' })
    expect(screen.getByRole('heading', { name: '你已經離開會議室' })).toBeInTheDocument()
  })

  it('a member whose connection dropped when the meeting ended sees the ended screen', async () => {
    const socket = await enter([
      member('h', 'Wei', 'host', 1),
      member('a', 'Gene', 'participant', 2),
    ])
    // The socket drops; the reconnect is refused with `ended` (the room's tombstone)
    RoomSocket.onJoin = () => {}
    await act(async () => socket.onclose?.({ code: 1006 }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_500))
    })
    const again = RoomSocket.instances.at(-1)!
    expect(again).not.toBe(socket)
    await act(async () => again.onclose?.({ code: 4411 }))
    expect(screen.getByRole('heading', { name: '主持人已結束會議' })).toBeInTheDocument()
  })
})

describe('the host dialogs and panel (e1-t15, e1-t16)', () => {
  it('saves a normalized password, refuses a bad one, clears', () => {
    const props = { onSave: vi.fn(), onClear: vi.fn(), onCancel: vi.fn() }
    render(<PasswordDialog hasPassword current="old1" {...props} />)
    const input = screen.getByLabelText('密碼')
    expect(input).toHaveValue('old1')
    fireEvent.change(input, { target: { value: 'a b' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(screen.getByRole('alert')).toHaveTextContent('不能有空白')
    expect(props.onSave).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: ' 2468 ' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(props.onSave).toHaveBeenCalledWith('2468')
    fireEvent.click(screen.getByRole('button', { name: '清除密碼' }))
    expect(props.onClear).toHaveBeenCalled()
  })

  it('leave dialog: the automatic successor is preselected', () => {
    const props = { onLeave: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn() }
    render(
      <LeaveDialog
        candidates={[
          { id: 'b', name: 'Bob' },
          { id: 'c', name: 'Carol' },
        ]}
        automatic="c"
        {...props}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '只有我離開' }))
    expect(props.onLeave).toHaveBeenCalledWith('c')
  })

  it('shows the password and role controls to the host only', () => {
    const members = [
      member('h', 'Gene', 'host', 1),
      member('c', 'Carol', 'cohost', 2),
      member('p', 'Pat', 'participant', 3),
    ]
    const base = {
      members,
      sharerId: null,
      onAction: vi.fn(),
      onMuteAll: vi.fn(),
      onEndMeeting: vi.fn(),
    }
    const onRole = vi.fn()
    const { unmount } = render(<ParticipantsPanel {...base} you="h" onRole={onRole} passwordSet />)
    expect(screen.getByText('已設定，新加入的人要輸入密碼')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '對 Carol 的動作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '取消共同主持人' }))
    expect(onRole).toHaveBeenCalledWith('revokeCohost', 'c')
    unmount()
    // A co-host: the room's switches but not the password; no role changes in the menus
    render(<ParticipantsPanel {...base} you="c" onRole={onRole} />)
    expect(screen.getByRole('switch', { name: '鎖定會議室' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '設定會議室密碼' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '對 Pat 的動作' }))
    expect(screen.queryByRole('menuitem', { name: '設為共同主持人' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '移出會議室' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '對 Gene 的動作' })).toBeNull()
  })
})

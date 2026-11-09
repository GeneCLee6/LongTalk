import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'
import { telemetry } from '../../src/telemetry.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

const ROOM_ID = 'abcdefghij'
const TOKEN = 'S'.repeat(43)

/**
 * Stands in for the browser's WebSocket: answers `join` with a welcome (one other member, Wei,
 * plus the newcomer under the name it sent) and records everything sent.
 */
class RoomSocket {
  static instances: RoomSocket[] = []
  /** `lobby`: the room has its waiting room on and answers `join` with a lobby (F2) */
  static answer: 'welcome' | 'lobby' = 'welcome'
  readyState = 0
  sent: string[] = []
  closedWith: number | undefined
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
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
    const message = JSON.parse(data) as { t: string; name?: string }
    if (message.t !== 'join') return
    if (RoomSocket.answer === 'lobby') {
      const lobby = {
        t: 'lobby',
        v: PROTOCOL_VERSION,
        you: 'a',
        token: TOKEN,
        position: 1,
        count: 1,
        room: { name: '週五聊天', createdBy: 'Wei' },
        hostPresent: true,
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(lobby) }))
      return
    }
    const roomId = /rooms\/([^/]+)\/ws/.exec(this.url)?.[1] ?? ''
    const members = {
      w: { id: 'w', name: 'Wei', role: 'participant', joinedAt: 1, reconnecting: true, tracks: [] },
      a: {
        id: 'a',
        name: message.name,
        role: 'host',
        joinedAt: 2,
        reconnecting: false,
        tracks: [],
      },
    }
    const state = { room: { id: roomId, createdAt: 1 }, members, usage: 'normal' }
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
  close(code?: number) {
    this.closedWith = code
  }
}

/** POST /api/rooms creates ROOM_ID; GET /api/rooms/<id> knows ROOM_ID only */
function stubApi({ createStatus = 201, locked = false, waitingRoom = false } = {}) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/rooms' && init?.method === 'POST') {
      return createStatus === 201
        ? Response.json({ id: ROOM_ID }, { status: 201 })
        : new Response('', { status: createStatus })
    }
    if (url === `/api/rooms/${ROOM_ID}`) {
      return Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 1, locked, waitingRoom })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function visit(path: string) {
  window.history.pushState({}, '', path)
  render(<App />)
}

const CLIENT = 'browser-id-0123456789'

beforeEach(() => {
  vi.stubGlobal('WebSocket', RoomSocket)
  localStorage.clear()
  sessionStorage.clear()
  // This browser's own id (F1), sent with every join
  localStorage.setItem('longtalk.client', CLIENT)
})

afterEach(() => {
  vi.unstubAllGlobals()
  RoomSocket.instances = []
  RoomSocket.answer = 'welcome'
})

describe('home page', () => {
  it('shows the logo, the line, the two actions and the three reasons', () => {
    visit('/')
    expect(screen.getByText('LongTalk')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '開著就不會斷的會議室' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '開一間房' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: '會議室連結或代碼' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('creates a room and goes to its pre-join screen', async () => {
    const fetch = stubApi()
    visit('/')
    fireEvent.click(screen.getByRole('button', { name: '開一間房' }))
    expect(await screen.findByRole('heading', { name: '準備加入' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/r/${ROOM_ID}`)
    expect(fetch).toHaveBeenCalledWith('/api/rooms', { method: 'POST' })
    expect(screen.getByText(/目前 1 人在裡面/)).toBeInTheDocument()
    // No socket until the person joins
    expect(RoomSocket.instances).toHaveLength(0)
  })

  it('says so when the room cannot be created', async () => {
    stubApi({ createStatus: 503 })
    visit('/')
    fireEvent.click(screen.getByRole('button', { name: '開一間房' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('開房失敗')
    expect(screen.getByRole('button', { name: '開一間房' })).toBeEnabled()
  })

  it('joins by a pasted link or code', async () => {
    stubApi()
    visit('/')
    const box = screen.getByRole('textbox', { name: '會議室連結或代碼' })
    fireEvent.change(box, { target: { value: ` https://longtalk.app/r/${ROOM_ID}?x=1 ` } })
    fireEvent.click(screen.getByRole('button', { name: '加入' }))
    expect(await screen.findByRole('heading', { name: '準備加入' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/r/${ROOM_ID}`)
  })

  it('explains when the join box holds no room', () => {
    visit('/')
    const box = screen.getByRole('textbox', { name: '會議室連結或代碼' })
    expect(screen.getByRole('button', { name: '加入' })).toBeDisabled()
    fireEvent.change(box, { target: { value: 'hello world' } })
    fireEvent.click(screen.getByRole('button', { name: '加入' }))
    expect(screen.getByRole('alert')).toHaveTextContent('看不出這是哪一間房')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(window.location.pathname).toBe('/')
  })
})

describe('joining a room', () => {
  it('asks for a name, joins with it and shows who is in the room', async () => {
    stubApi()
    visit(`/r/${ROOM_ID}`)
    const join = await screen.findByRole('button', { name: '加入' })
    expect(join).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '你的名字' }), {
      target: { value: '  小潔  ' },
    })
    fireEvent.click(join)
    expect(await screen.findByRole('heading', { name: `會議室 ${ROOM_ID}` })).toBeInTheDocument()
    const socket = RoomSocket.instances.at(-1)!
    expect(socket.url).toMatch(new RegExp(`/api/rooms/${ROOM_ID}/ws\\?v=${PROTOCOL_VERSION}$`))
    expect(socket.sent[0]).toBe(`{"t":"join","name":"小潔","token":null,"client":"${CLIENT}"}`)
    expect(await screen.findByText('目前 2 人在線')).toBeInTheDocument()
    const grid = screen.getByRole('region', { name: '會議室畫面' })
    expect(within(grid).getByRole('figure', { name: '小潔（你）' })).toBeInTheDocument()
    expect(within(grid).getByRole('figure', { name: 'Wei' })).toHaveTextContent('重新連線中')
    // Remembered for the next visit (name) and for a reload of this tab (token)
    expect(localStorage.getItem('longtalk.name')).toBe('小潔')
    expect(sessionStorage.getItem(`longtalk.session.${ROOM_ID}`)).toBe(TOKEN)
  })

  it('fills in the name from last time', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    visit(`/r/${ROOM_ID}`)
    expect(await screen.findByRole('textbox', { name: '你的名字' })).toHaveValue('Gene')
    expect(screen.getByRole('button', { name: '加入' })).toBeEnabled()
  })

  it('goes straight back in as the same member after a reload', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    expect(await screen.findByText('目前 2 人在線')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '準備加入' })).toBeNull()
    expect(RoomSocket.instances.at(-1)!.sent[0]).toBe(
      JSON.stringify({ t: 'join', name: 'Gene', token: TOKEN, client: CLIENT }),
    )
  })

  it('leaves on purpose: tells the room, forgets the session, shows the after-leave screen', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    const socket = RoomSocket.instances.at(-1)!
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '離開' })))
    expect(socket.sent.at(-1)).toBe('{"t":"leave"}')
    expect(sessionStorage.getItem(`longtalk.session.${ROOM_ID}`)).toBeNull()
    // e4-t18
    expect(screen.getByRole('heading', { name: '你已經離開會議室' })).toBeInTheDocument()
    expect(screen.getByText(`你離開了「會議室 ${ROOM_ID}」。`)).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/r/${ROOM_ID}`)
    fireEvent.click(screen.getByRole('button', { name: '回首頁' }))
    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('button', { name: '開一間房' })).toBeInTheDocument()
  })

  it('rates the call once, as telemetry with the score only (e4-t18)', async () => {
    stubApi()
    const track = vi.spyOn(telemetry, 'track')
    const flush = vi.spyOn(telemetry, 'flush')
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '離開' })))
    const four = screen.getByRole('button', { name: '4 分：不錯' })
    fireEvent.click(four)
    expect(track).toHaveBeenCalledWith({ type: 'rating', score: 4 })
    expect(flush).toHaveBeenCalled()
    expect(four).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('謝謝你的回饋')
    // Once: the other scores are now disabled
    expect(screen.getByRole('button', { name: '5 分：很好' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '5 分：很好' }))
    expect(track.mock.calls.filter(([event]) => event.type === 'rating')).toHaveLength(1)
    track.mockRestore()
    flush.mockRestore()
  })

  it('rejoins through the pre-join screen with the remembered name, as a new member', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '離開' })))
    fireEvent.click(screen.getByRole('button', { name: '重新加入' }))
    expect(await screen.findByRole('heading', { name: '準備加入' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '你的名字' })).toHaveValue('Gene')
    fireEvent.click(screen.getByRole('button', { name: '加入' }))
    expect(await screen.findByText('目前 2 人在線')).toBeInTheDocument()
    // The session was forgotten on leaving: no token, so a new member
    expect(RoomSocket.instances.at(-1)!.sent[0]).toBe(
      `{"t":"join","name":"Gene","token":null,"client":"${CLIENT}"}`,
    )
  })

  it('says the room closed (no rejoin) when it is gone after we were in it', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    const socket = RoomSocket.instances.at(-1)!
    await act(async () => socket.onclose?.({ code: 4404 }))
    expect(await screen.findByRole('heading', { name: '這間會議室已經關閉' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新加入' })).toBeNull()
    expect(screen.getByRole('button', { name: '1 分：很差' })).toBeEnabled()
    expect(sessionStorage.getItem(`longtalk.session.${ROOM_ID}`)).toBeNull()
  })

  it('renames the room (as host) and myself, and copies the link (e1-t05)', async () => {
    stubApi()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    const socket = RoomSocket.instances.at(-1)!

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重新命名會議室' }))
    fireEvent.change(screen.getByRole('textbox', { name: '會議室名稱' }), {
      target: { value: '週五聊天' },
    })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(socket.sent.at(-1)).toBe('{"t":"renameRoom","name":"週五聊天"}')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '修改我的名字' }))
    const box = screen.getByRole('textbox', { name: '你的名字' })
    expect(box).toHaveValue('Gene')
    fireEvent.change(box, { target: { value: ' 阿明 ' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(socket.sent.at(-1)).toBe('{"t":"rename","name":"阿明"}')
    expect(localStorage.getItem('longtalk.name')).toBe('阿明')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '複製連結' })))
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/r/${ROOM_ID}`)
    expect(await screen.findByText(/已複製會議室連結/)).toBeInTheDocument()
  })

  it('says so when the room does not exist, without asking for the camera', async () => {
    stubApi()
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    visit('/r/bbbbbbbbbb')
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到這間會議室')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(RoomSocket.instances).toHaveLength(0)
  })

  it('does not even look up a room id that cannot exist', async () => {
    const fetch = stubApi()
    visit('/r/Abc_123')
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到這間會議室')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('chat in the room (D3, e5-t01, e5-t02)', () => {
  const push = (socket: RoomSocket, frame: unknown) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(frame) }))
  const fromWei = (id: number, text: string) => ({ id, from: 'w', name: 'Wei', text, at: id })

  it('counts what arrives as unread with a preview, and sends from the side panel', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    const socket = RoomSocket.instances.at(-1)!
    // The history that follows the welcome is not new
    await push(socket, { t: 'chat', messages: [fromWei(1, '舊訊息')], reset: true })
    expect(screen.getByRole('button', { name: '聊天' })).toBeInTheDocument()
    await push(socket, { t: 'chat', messages: [fromWei(2, '看這個 https://example.com')] })
    expect(screen.getByRole('button', { name: '聊天（1 則未讀）' })).toBeInTheDocument()
    // The preview bubble opens the chat
    fireEvent.click(screen.getByRole('button', { name: /^Wei.*打開聊天$/ }))
    const panel = screen.getByRole('complementary', { name: '聊天' })
    expect(within(panel).getByRole('link', { name: 'https://example.com' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-expanded', 'true')
    const box = within(panel).getByRole('textbox', { name: '輸入訊息' })
    expect(box).toHaveFocus()
    fireEvent.change(box, { target: { value: '收到' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'chat', text: '收到' }))
    await push(socket, {
      t: 'chat',
      messages: [{ id: 3, from: 'a', name: 'Gene', text: '收到', at: 3 }],
    })
    expect(within(panel).getByRole('log')).toHaveTextContent('你 · ')
    // The room refusing a message as too fast is said
    await push(socket, { t: 'error', code: 'rate_limited' })
    expect(screen.getByText('你傳得太快了，請等幾秒再傳。')).toBeInTheDocument()
  })
})

describe('host controls in the room (F1, e1-t07, e1-t08)', () => {
  const push = (socket: RoomSocket, frame: unknown) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(frame) }))
  async function enter() {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    return RoomSocket.instances.at(-1)!
  }

  it('opens the participants in the side panel, switches to chat and back', async () => {
    await enter()
    fireEvent.click(screen.getByRole('button', { name: '參與者（2 人）' }))
    const panel = screen.getByRole('complementary', { name: '參與者' })
    const list = within(panel).getByRole('list', { name: '參與者名單' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Gene', 'Wei'])
    expect(within(panel).getByRole('tab', { name: '參與者 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    fireEvent.click(within(panel).getByRole('tab', { name: '聊天' }))
    expect(screen.getByRole('complementary', { name: '聊天' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '參與者（2 人）' }))
    expect(screen.getByRole('complementary', { name: '參與者' })).toBeInTheDocument()
  })

  it('sends the host controls: mute all, remove after asking, end after asking', async () => {
    const socket = await enter()
    fireEvent.click(screen.getByRole('button', { name: '參與者（2 人）' }))
    const panel = screen.getByRole('complementary', { name: '參與者' })
    fireEvent.click(within(panel).getByRole('button', { name: '全員靜音' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"muteAll"}')
    expect(screen.getByText('已將所有人靜音')).toBeInTheDocument()
    // Wei publishes nothing and is reconnecting: only recording, the co-host role and removing
    fireEvent.click(within(panel).getByRole('button', { name: '對 Wei 的動作' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '允許錄影',
      '設為共同主持人',
      '移出會議室',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: '移出會議室' }))
    const ask = screen.getByRole('alertdialog', { name: '把 Wei 移出會議室？' })
    fireEvent.click(within(ask).getByRole('button', { name: '移出' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"remove","memberId":"w"}')
    fireEvent.click(within(panel).getByRole('button', { name: '結束會議' }))
    fireEvent.click(
      within(screen.getByRole('alertdialog', { name: '結束會議？' })).getByRole('button', {
        name: '結束會議',
      }),
    )
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"endMeeting"}')
  })

  it('says who muted us, and that only we can turn it back on', async () => {
    const socket = await enter()
    await push(socket, { t: 'notice', notice: 'muted', by: 'w' })
    expect(
      screen.getByText('主持人 Wei 將你靜音了。要說話時，請自己打開麥克風。'),
    ).toBeInTheDocument()
    await push(socket, { t: 'notice', notice: 'camOff', by: 'w' })
    expect(
      screen.getByText('主持人 Wei 關閉了你的鏡頭。要開鏡頭時，請自己再打開。'),
    ).toBeInTheDocument()
  })

  it('shows the removed screen (no rejoin) when the host removes us', async () => {
    const socket = await enter()
    await act(async () => socket.onclose?.({ code: 4403 }))
    expect(await screen.findByRole('heading', { name: '你已被移出會議室' })).toBeInTheDocument()
    expect(screen.getByText(/10 分鐘內不能用這個瀏覽器再加入/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新加入' })).toBeNull()
    expect(sessionStorage.getItem(`longtalk.session.${ROOM_ID}`)).toBeNull()
  })

  it('shows the ended screen when the host ends the meeting', async () => {
    const socket = await enter()
    await act(async () => socket.onclose?.({ code: 4411 }))
    expect(await screen.findByRole('heading', { name: '主持人已結束會議' })).toBeInTheDocument()
    expect(screen.getByText(`「會議室 ${ROOM_ID}」已經結束，會議室也關閉了。`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新加入' })).toBeNull()
  })
})

describe('lock and waiting room (F2, e1-t09 – e1-t11)', () => {
  const push = (socket: RoomSocket, frame: unknown) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(frame) }))
  const welcomeFrame = (rev = 1) => ({
    t: 'welcome',
    v: PROTOCOL_VERSION,
    you: 'a',
    token: TOKEN,
    rev,
    state: {
      room: { id: ROOM_ID, createdAt: 1, name: '週五聊天', locked: false, waitingRoom: true },
      members: {
        w: { id: 'w', name: 'Wei', role: 'host', joinedAt: 1, reconnecting: false, tracks: [] },
        a: {
          id: 'a',
          name: 'Gene',
          role: 'participant',
          joinedAt: 2,
          reconnecting: false,
          tracks: [],
        },
      },
      waiting: {},
      usage: 'normal',
    },
  })

  async function enterWaiting() {
    stubApi({ waitingRoom: true })
    RoomSocket.answer = 'lobby'
    localStorage.setItem('longtalk.name', 'Gene')
    visit(`/r/${ROOM_ID}`)
    expect(await screen.findByText(/開了等候室/)).toBeInTheDocument()
    // G1: the status card says so, and 加入 asks to join
    expect(screen.getByText(/主持人放行你才會進入/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '要求加入' }))
    expect(await screen.findByRole('heading', { name: '你在等候室' })).toBeInTheDocument()
    return RoomSocket.instances.at(-1)!
  }

  it('waits with the room name and its place, then comes in when admitted, nothing asked again', async () => {
    const socket = await enterWaiting()
    expect(screen.getByText('週五聊天')).toBeInTheDocument()
    expect(screen.getByText('你是下一位')).toBeInTheDocument()
    expect(screen.getByText(/主持人會讓你進來/)).toBeInTheDocument()
    // The token is kept, so a reload comes back to the same place in the queue
    expect(sessionStorage.getItem(`longtalk.session.${ROOM_ID}`)).toBe(TOKEN)
    await push(socket, {
      t: 'lobby',
      v: PROTOCOL_VERSION,
      you: 'a',
      token: TOKEN,
      position: 1,
      count: 1,
      room: { name: '週五聊天', createdBy: 'Wei' },
      hostPresent: false,
    })
    expect(screen.getByText(/主持人目前不在線上/)).toBeInTheDocument()
    // Admitted: the room on the same socket, no pre-join screen, no name asked
    await push(socket, welcomeFrame())
    expect(await screen.findByText('目前 2 人在線')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '你在等候室' })).toBeNull()
    expect(RoomSocket.instances).toHaveLength(1)
    expect(screen.getByRole('heading', { name: '週五聊天' })).toBeInTheDocument()
  })

  it('leaves the waiting room: tells the room, then offers to try again', async () => {
    const socket = await enterWaiting()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '離開等候室' })))
    expect(socket.sent.at(-1)).toBe('{"t":"leave"}')
    expect(screen.getByRole('heading', { name: '你已離開等候室' })).toBeInTheDocument()
    expect(sessionStorage.getItem(`longtalk.session.${ROOM_ID}`)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '再試一次' }))
    expect(await screen.findByRole('heading', { name: '準備加入' })).toBeInTheDocument()
  })

  it('says the host did not let us in when denied, with a way to ask again', async () => {
    const socket = await enterWaiting()
    await act(async () => socket.onclose?.({ code: 4406 }))
    expect(await screen.findByRole('heading', { name: '主持人沒有讓你進入' })).toBeInTheDocument()
    expect(screen.getByText(/1 分鐘後可以再請求一次/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /分：/ })).toBeNull()
    expect(sessionStorage.getItem(`longtalk.session.${ROOM_ID}`)).toBeNull()
  })

  it('says when waiting took too long', async () => {
    const socket = await enterWaiting()
    await act(async () => socket.onclose?.({ code: 4412 }))
    expect(await screen.findByRole('heading', { name: '等候太久了' })).toBeInTheDocument()
  })

  it('shows the locked screen when the room locked between the pre-join screen and joining', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    await act(async () => RoomSocket.instances.at(-1)!.onclose?.({ code: 4423 }))
    expect(await screen.findByRole('heading', { name: '這間會議室已鎖定' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '再試一次' }))
    expect(await screen.findByRole('heading', { name: '準備加入' })).toBeInTheDocument()
  })

  it('says a room is locked before asking for the camera, and looks again on 再試一次', async () => {
    const fetch = stubApi({ locked: true })
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    visit(`/r/${ROOM_ID}`)
    expect(await screen.findByRole('heading', { name: '這間會議室已鎖定' })).toBeInTheDocument()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(RoomSocket.instances).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '再試一次' }))
    await screen.findByRole('heading', { name: '這間會議室已鎖定' })
    expect(fetch.mock.calls.filter(([url]) => url === `/api/rooms/${ROOM_ID}`)).toHaveLength(2)
  })

  it('host: a toast and a badge when someone waits, admit and deny, the switches', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    const socket = RoomSocket.instances.at(-1)!
    await push(socket, {
      t: 'patch',
      rev: 2,
      ops: [
        { op: 'set', path: ['room', 'waitingRoom'], value: true },
        {
          op: 'set',
          path: ['waiting'],
          value: {
            x: { id: 'x', name: '阿明', since: 5, reconnecting: false },
            y: { id: 'y', name: '阿華', since: 6, reconnecting: false },
          },
        },
      ],
    })
    expect(screen.getByText('2 人在等候室，等你放行')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '參與者（2 人，2 人在等候室）' }))
    const panel = screen.getByRole('complementary', { name: '參與者' })
    expect(within(panel).getByRole('heading', { name: '等候中 2' })).toBeInTheDocument()
    const queue = within(panel).getByRole('list', { name: '等候室名單' })
    expect(
      within(queue)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['阿明', '阿華'])
    fireEvent.click(within(panel).getByRole('button', { name: '放行 阿明 進入會議室' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"admit","memberId":"x"}')
    fireEvent.click(within(panel).getByRole('button', { name: '拒絕 阿華 進入' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"deny","memberId":"y"}')
    fireEvent.click(within(panel).getByRole('button', { name: '全部放行' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"admitAll"}')
    // A third one arrives: one toast with the name
    await push(socket, {
      t: 'patch',
      rev: 3,
      ops: [
        {
          op: 'set',
          path: ['waiting', 'z'],
          value: { id: 'z', name: '小美', since: 7, reconnecting: false },
        },
      ],
    })
    expect(screen.getByText('小美 在等候室，等你放行')).toBeInTheDocument()
    // Lock
    fireEvent.click(within(panel).getByRole('switch', { name: '鎖定會議室' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"lock","on":true}')
    await push(socket, {
      t: 'patch',
      rev: 4,
      ops: [{ op: 'set', path: ['room', 'locked'], value: true }],
    })
    expect(within(panel).getByRole('switch', { name: '鎖定會議室' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('img', { name: '會議室已鎖定，新的人不能加入' })).toBeInTheDocument()
    // Turning the waiting room off with people in it asks first: they all come in
    fireEvent.click(within(panel).getByRole('switch', { name: '等候室' }))
    const ask = screen.getByRole('alertdialog', { name: '關閉等候室？' })
    expect(ask).toHaveTextContent('等候中的 3 人會一起進入會議室。')
    fireEvent.click(within(ask).getByRole('button', { name: '放行 3 人並關閉' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"waitingRoom","on":false}')
  })

  it('participant: sees the lock, not the waiting list or the switches', async () => {
    const socket = await enterWaiting()
    await push(socket, welcomeFrame())
    await screen.findByText('目前 2 人在線')
    await push(socket, {
      t: 'patch',
      rev: 2,
      ops: [
        { op: 'set', path: ['room', 'locked'], value: true },
        {
          op: 'set',
          path: ['waiting'],
          value: { x: { id: 'x', name: '阿明', since: 5, reconnecting: false } },
        },
      ],
    })
    expect(screen.getByRole('img', { name: '會議室已鎖定，新的人不能加入' })).toBeInTheDocument()
    expect(screen.queryByText(/在等候室，等你放行/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '參與者（2 人）' }))
    const panel = screen.getByRole('complementary', { name: '參與者' })
    expect(within(panel).queryByRole('switch')).toBeNull()
    expect(within(panel).queryByRole('list', { name: '等候室名單' })).toBeNull()
  })
})

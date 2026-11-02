import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'

const ROOM_ID = 'abcdefghij'
const TOKEN = 'S'.repeat(43)

/**
 * Stands in for the browser's WebSocket: answers `join` with a welcome (one other member, Wei,
 * plus the newcomer under the name it sent) and records everything sent.
 */
class RoomSocket {
  static instances: RoomSocket[] = []
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
function stubApi({ createStatus = 201 } = {}) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/rooms' && init?.method === 'POST') {
      return createStatus === 201
        ? Response.json({ id: ROOM_ID }, { status: 201 })
        : new Response('', { status: createStatus })
    }
    if (url === `/api/rooms/${ROOM_ID}`) {
      return Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 1 })
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

beforeEach(() => {
  vi.stubGlobal('WebSocket', RoomSocket)
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  RoomSocket.instances = []
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
    fireEvent.change(box, { target: { value: 'hello' } })
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
    expect(socket.sent[0]).toBe('{"t":"join","name":"小潔","token":null}')
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
      JSON.stringify({ t: 'join', name: 'Gene', token: TOKEN }),
    )
  })

  it('leaves on purpose: tells the room, forgets the session and goes home', async () => {
    stubApi()
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    visit(`/r/${ROOM_ID}`)
    await screen.findByText('目前 2 人在線')
    const socket = RoomSocket.instances.at(-1)!
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '離開' })))
    expect(socket.sent.at(-1)).toBe('{"t":"leave"}')
    expect(sessionStorage.getItem(`longtalk.session.${ROOM_ID}`)).toBeNull()
    expect(window.location.pathname).toBe('/')
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
    visit('/r/abc123')
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
    fireEvent.click(screen.getByRole('button', { name: '打開聊天，看 Wei 的訊息' }))
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

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ClientMessage, type MemberTrack } from '../../shared/protocol.ts'
import type { UsageState } from '../../shared/usage.ts'
import { App } from '../../src/App.tsx'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import type { MediaDevicesLike } from '../../src/media/devices.ts'
import { MediaDevicesContext } from '../../src/room/devicesContext.ts'
import { TransportContext } from '../../src/room/transportContext.ts'
import { fakeMediaDevices } from './media/fakeMedia.ts'

// The room page with its media on a FakeSfu (e2-t03, e2-t04): the page publishes through the
// transport the context gives it, reports its tracks to the room and shows a tile per member
// with what it receives. jsdom has no getUserMedia, so this member joins without devices.

const ROOM_ID = 'abcdefghij'
const TOKEN = 'A'.repeat(43)
// The room page is a lazy chunk: its first load in a busy test run can take a while
const SLOW = { timeout: 5000 }

let sfu: FakeSfu
let weiTracks: MemberTrack[]
let usage: UsageState
const sockets: RoomSocket[] = []

/** The room's WebSocket: welcomes with Wei already in the room, publishing `weiTracks` */
class RoomSocket {
  readyState = 0
  sent: ClientMessage[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor() {
    sockets.push(this)
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
      room: { id: ROOM_ID, createdAt: 1 },
      members: {
        w: { id: 'w', name: 'Wei', joinedAt: 1, reconnecting: false, tracks: weiTracks },
        a: { id: 'a', name: 'Gene', joinedAt: 2, reconnecting: false, tracks: [] },
      },
      usage,
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
}

async function publishWei(kinds: ('mic' | 'cam')[]) {
  const wei = sfu.createTransport()
  await wei.connect()
  weiTracks = []
  for (const kind of kinds) {
    const track = { kind: kind === 'mic' ? 'audio' : 'video' } as MediaStreamTrack
    const published = await wei.publish(track, { kind })
    weiTracks.push({ ...published, muted: false })
  }
  return wei
}

function visitRoom(mediaDevices: MediaDevicesLike | null = null) {
  // A tab that joined before goes straight in (no pre-join screen)
  localStorage.setItem('longtalk.name', 'Gene')
  sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
  window.history.pushState({}, '', `/r/${ROOM_ID}`)
  const tokens: (string | null)[] = []
  render(
    <StrictMode>
      <TransportContext.Provider
        value={(roomId, token) => {
          expect(roomId).toBe(ROOM_ID)
          tokens.push(token())
          return sfu.createTransport()
        }}
      >
        <MediaDevicesContext.Provider value={mediaDevices}>
          <App />
        </MediaDevicesContext.Provider>
      </TransportContext.Provider>
    </StrictMode>,
  )
  return { tokens }
}

beforeEach(() => {
  sfu = new FakeSfu()
  weiTracks = []
  usage = 'normal'
  sockets.length = 0
  vi.stubGlobal('WebSocket', RoomSocket)
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('room page media', () => {
  it("receives another member's camera and microphone and shows them on their tile", async () => {
    const wei = await publishWei(['mic', 'cam'])
    visitRoom()
    const grid = await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    const tile = within(grid).getByRole('figure', { name: 'Wei' })
    await waitFor(() => expect(within(tile).getByLabelText('Wei 的畫面')).toBeInTheDocument(), SLOW)
    // Their sound plays apart from the tile, so layouts can move tiles (e4-t07)
    expect(document.querySelector('audio[data-member="Wei"]')).not.toBeNull()
    // Our own tile, with no camera in jsdom, shows the initial instead
    expect(within(grid).getByRole('figure', { name: 'Gene（你）' })).toHaveTextContent('G')
    // Subscribed exactly once, by the one live transport (StrictMode mounted twice)
    const live = [...sfu.transports].filter((t) => t !== wei)
    expect(live).toHaveLength(1)
    expect(live[0].subscriptions.size).toBe(2)
  })

  it('opens exactly one SFU session under StrictMode, with the session token', async () => {
    const { tokens } = visitRoom()
    await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    await waitFor(() => expect(sfu.transports.size).toBe(1), SLOW)
    expect(tokens.every((t) => t === TOKEN)).toBe(true)
  })

  it.each([
    ['low', '視訊先改成低畫質'],
    ['audioOnly', '只保留聲音'],
  ] as const)('tells the member when the month is %s', async (state, text) => {
    usage = state
    visitRoom()
    expect(await screen.findByText(new RegExp(text), {}, SLOW)).toBeInTheDocument()
  })
})

describe('room page: toggles, devices and problems (e2-t05, e2-t06, e2-t09)', () => {
  /** The `tracks` messages this page sent to the room */
  const reports = () => sockets.flatMap((s) => s.sent).filter((m) => m.t === 'tracks')
  const lastMuted = () =>
    Object.fromEntries((reports().at(-1)?.tracks ?? []).map((t) => [t.kind, t.muted]))
  /** Our one live transport (StrictMode mounted twice, one was closed) */
  const ours = () => [...sfu.transports].at(-1)!

  async function enterWithDevices(options: Parameters<typeof fakeMediaDevices>[0] = {}) {
    const fake = fakeMediaDevices(options)
    visitRoom(fake.devices)
    const toolbar = await screen.findByRole('toolbar', { name: '會議控制' }, SLOW)
    return { fake, toolbar }
  }

  it('mutes the microphone and turns the camera off, telling the room', async () => {
    const { toolbar } = await enterWithDevices()
    await waitFor(() => expect(lastMuted()).toEqual({ mic: false, cam: false }), SLOW)
    fireEvent.click(within(toolbar).getByRole('button', { name: '靜音' }))
    await waitFor(() => expect(lastMuted()).toEqual({ mic: true, cam: false }))
    const own = screen.getByRole('figure', { name: 'Gene（你）' })
    expect(within(own).getByRole('img', { name: '麥克風已關' })).toBeInTheDocument()
    fireEvent.click(within(toolbar).getByRole('button', { name: '關閉視訊' }))
    await waitFor(() => expect(lastMuted()).toEqual({ mic: true, cam: true }))
    expect(within(own).queryByLabelText('Gene 的畫面')).toBeNull()
    expect(within(toolbar).getByRole('button', { name: '開啟視訊' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    // Back on: the same published tracks, nothing published again
    fireEvent.click(within(toolbar).getByRole('button', { name: '解除靜音' }))
    fireEvent.click(within(toolbar).getByRole('button', { name: '開啟視訊' }))
    await waitFor(() => expect(lastMuted()).toEqual({ mic: false, cam: false }))
    expect(new Set(reports().flatMap((r) => r.tracks.map((t) => t.trackName))).size).toBe(2)
  })

  it("shows another member's muted microphone and camera", async () => {
    await publishWei(['mic', 'cam'])
    weiTracks = weiTracks.map((track) => ({ ...track, muted: true }))
    visitRoom()
    const grid = await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    const tile = within(grid).getByRole('figure', { name: 'Wei' })
    await waitFor(() => expect(ours().subscriptions.size).toBe(2), SLOW)
    expect(within(tile).queryByLabelText('Wei 的畫面')).toBeNull()
    expect(within(tile).getByRole('img', { name: '麥克風已關' })).toBeInTheDocument()
  })

  it('switches the microphone from the menu without a new session, and remembers it', async () => {
    const { fake, toolbar } = await enterWithDevices()
    await waitFor(() => expect(reports().length).toBeGreaterThan(0), SLOW)
    fireEvent.click(within(toolbar).getByRole('button', { name: '選擇麥克風與喇叭' }))
    const menu = screen.getByRole('menu', { name: '選擇麥克風與喇叭' })
    expect(
      within(menu).getByRole('menuitemradio', { name: /Built-in Microphone/ }),
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /USB Headset/ }))
    await waitFor(() => {
      const mic = ours().sending.get(reports()[0].tracks[0].trackName)
      expect(mic?.getSettings().deviceId).toBe('mic-2')
    })
    expect(sfu.transports.size).toBe(1)
    expect(JSON.parse(localStorage.getItem('longtalk.devices')!)).toMatchObject({ mic: 'mic-2' })
    expect(fake.tracks().find((t) => t.deviceId === 'mic-1')?.stopped).toBe(true)
  })

  it('moves to another microphone when the one in use is unplugged', async () => {
    const { fake } = await enterWithDevices()
    await waitFor(() => expect(reports().length).toBeGreaterThan(0), SLOW)
    fake.unplug('mic-1')
    expect(await screen.findByText('麥克風中斷了，已改用「USB Headset」。')).toBeInTheDocument()
    await waitFor(() => {
      const mic = ours().sending.get(reports()[0].tracks[0].trackName)
      expect(mic?.getSettings().deviceId).toBe('mic-2')
    })
  })

  it('explains a refusal and retries', async () => {
    const { fake } = await enterWithDevices({ denyAll: true })
    const alert = await screen.findByText(/瀏覽器沒有麥克風或鏡頭的權限/, {}, SLOW)
    const calls = fake.getUserMedia.mock.calls.length
    fireEvent.click(within(alert.parentElement!).getByRole('button', { name: '重試' }))
    await waitFor(() => expect(fake.getUserMedia.mock.calls.length).toBe(calls + 2))
  })

  it('explains a camera held by another program', async () => {
    await enterWithDevices({ fail: { video: 'NotReadableError' } })
    expect(await screen.findByText(/鏡頭正被其他程式使用/, {}, SLOW)).toBeInTheDocument()
  })

  it('keeps the camera off once the month is audio-only, and says why', async () => {
    usage = 'audioOnly'
    const { fake, toolbar } = await enterWithDevices()
    await waitFor(() => expect(screen.getByText(/你的鏡頭先不送出/)).toBeInTheDocument(), SLOW)
    fireEvent.click(within(toolbar).getByRole('button', { name: '關閉視訊' }))
    const opened = fake.getUserMedia.mock.calls.length
    fireEvent.click(await within(toolbar).findByRole('button', { name: '開啟視訊' }))
    await waitFor(() => expect(screen.getAllByText(/你的鏡頭先不送出/).length).toBeGreaterThan(0))
    expect(fake.getUserMedia.mock.calls.length).toBe(opened)
  })

  it('tells a browser without WebRTC to use another one', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined)
    visitRoom()
    expect(await screen.findByText(/請改用最新版的 Chrome/, {}, SLOW)).toBeInTheDocument()
  })
})

describe('room page: reconnecting (e2-t08)', () => {
  it('shows that it is reconnecting, keeps the media session, and reports again on rejoin', async () => {
    const fake = fakeMediaDevices()
    visitRoom(fake.devices)
    await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    await waitFor(
      () => expect(sockets.flatMap((s) => s.sent).some((m) => m.t === 'tracks')).toBe(true),
      SLOW,
    )
    const before = sockets.length
    // The network drops the socket
    sockets.at(-1)!.onclose?.({ code: 1006 })
    expect(await screen.findByText('連線中斷，正在重新連線…')).toBeInTheDocument()
    const own = screen.getByRole('figure', { name: 'Gene（你）' })
    expect(own).toHaveTextContent('重新連線中')
    // The backoff's first try (about a second) gets through and the room welcomes us back
    await waitFor(() => expect(sockets.length).toBe(before + 1), { timeout: 3000 })
    await waitFor(() => expect(screen.getByText('目前 2 人在線')).toBeInTheDocument())
    expect(screen.getByRole('figure', { name: 'Gene（你）' })).not.toHaveTextContent('重新連線中')
    // Still the one SFU session; what it publishes is reported on the new socket
    expect(sfu.transports.size).toBe(1)
    await waitFor(() => expect(sockets.at(-1)!.sent.some((m) => m.t === 'tracks')).toBe(true))
  })
})

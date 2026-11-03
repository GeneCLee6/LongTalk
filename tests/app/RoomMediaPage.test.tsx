import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

// The room page with its media on a FakeSfu (e2-t03, e2-t04): the page publishes through the
// transport the context gives it, reports its tracks to the room and shows a tile per member
// with what it receives. jsdom has no getUserMedia, so this member joins without devices.

const ROOM_ID = 'abcdefghij'
const TOKEN = 'A'.repeat(43)
// The room page is a lazy chunk: its first load in a busy test run can take a while
const SLOW = { timeout: 5000 }

let sfu: FakeSfu
let weiTracks: MemberTrack[]
/** Wei's connection as Wei's browser reported it (H2) */
let weiSignal: 'good' | 'fair' | 'poor' | null
let usage: UsageState
/** Who shares when we join (D1) */
/** The room's shares at join, by member id (H5: several at once) */
let roomShares: Record<string, { memberId: string; since: number }>
/** Members besides Wei and us at join (a second sharer, H5) */
let extraMembers: Record<string, unknown>
const sockets: RoomSocket[] = []

/** The room's WebSocket: welcomes with Wei already in the room, publishing `weiTracks` */
class RoomSocket {
  readyState = 0
  sent: ClientMessage[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  rev = 1
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
      room: { id: ROOM_ID, createdAt: 1, shares: roomShares },
      members: {
        w: {
          id: 'w',
          name: 'Wei',
          joinedAt: 1,
          reconnecting: false,
          tracks: weiTracks,
          signal: weiSignal,
        },
        a: { id: 'a', name: 'Gene', joinedAt: 2, reconnecting: false, tracks: [] },
        ...extraMembers,
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
  /** The room changed: the next numbered patch */
  patch(ops: unknown[]) {
    this.rev += 1
    this.onmessage?.({ data: JSON.stringify({ t: 'patch', rev: this.rev, ops }) })
  }
}

async function publishWei(kinds: ('mic' | 'cam' | 'screen')[]) {
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
  weiSignal = null
  usage = 'normal'
  roomShares = {}
  extraMembers = {}
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

describe('room page screen sharing (D1)', () => {
  /** getDisplayMedia, as the toolbar's share button needs it; returns what it captured */
  function stubDisplayMedia() {
    const captured: { stopped: boolean }[] = []
    const getDisplayMedia = vi.fn(async () => {
      const track = { kind: 'video', stopped: false, contentHint: '' } as {
        kind: string
        stopped: boolean
        contentHint: string
        stop?: () => void
        addEventListener?: () => void
        removeEventListener?: () => void
      }
      track.stop = () => (track.stopped = true)
      track.addEventListener = () => {}
      track.removeEventListener = () => {}
      captured.push(track)
      return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    })
    return { getDisplayMedia, captured }
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices')
  })

  it("shows someone's share in the main area with their name, everyone in the strip", async () => {
    await publishWei(['mic', 'cam', 'screen'])
    roomShares = { w: { memberId: 'w', since: 5 } }
    visitRoom()
    const stage = await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    await waitFor(() => expect(stage).toHaveAttribute('data-mode', 'share'), SLOW)
    const share = within(stage).getByRole('figure', { name: 'Wei 分享的畫面' })
    expect(share).toHaveTextContent('Wei 的畫面')
    await waitFor(
      () => expect(within(share).getByLabelText('Wei 分享的畫面')).toBeInTheDocument(),
      SLOW,
    )
    const strip = within(stage).getByRole('group', { name: '其他參與者' })
    expect(within(strip).getByRole('figure', { name: 'Wei' })).toBeInTheDocument()
    expect(within(strip).getByRole('figure', { name: 'Gene（你）' })).toBeInTheDocument()
    // The share ends: back to the gallery
    sockets.at(-1)!.patch([{ op: 'del', path: ['room', 'shares', 'w'] }])
    await waitFor(() =>
      expect(screen.getByRole('region', { name: '會議室畫面' })).toHaveAttribute(
        'data-mode',
        'grid',
      ),
    )
  })

  it('shares: picks, claims, publishes once granted, shows the bar, and stops from the bar', async () => {
    const display = stubDisplayMedia()
    visitRoom()
    await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    const toolbar = screen.getByRole('toolbar', { name: '會議控制' })
    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    const room = sockets.at(-1)!
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }))
    expect(display.getDisplayMedia).toHaveBeenCalledTimes(1)
    // Not published before the room grants it
    expect(
      room.sent.some((m) => m.t === 'tracks' && m.tracks.some((t) => t.kind === 'screen')),
    ).toBe(false)
    room.patch([{ op: 'set', path: ['room', 'shares', 'a'], value: { memberId: 'a', since: 9 } }])
    const bar = await screen.findByRole('region', { name: '你正在分享畫面' })
    await waitFor(() =>
      expect(
        room.sent.some((m) => m.t === 'tracks' && m.tracks.some((t) => t.kind === 'screen')),
      ).toBe(true),
    )
    // Our own share is not shown back to us: the gallery stays
    expect(screen.getByRole('region', { name: '會議室畫面' })).not.toHaveAttribute(
      'data-mode',
      'share',
    )
    expect(within(toolbar).getByRole('button', { name: '停止分享' })).toBeInTheDocument()
    fireEvent.click(within(bar).getByRole('button', { name: '停止分享' }))
    expect(room.sent.at(-1)).toEqual({ t: 'unshare' })
    expect(display.captured[0].stopped).toBe(true)
    await waitFor(() => expect(screen.queryByRole('region', { name: '你正在分享畫面' })).toBeNull())
    await waitFor(() =>
      expect(
        room.sent.filter((m) => m.t === 'tracks').at(-1)?.t === 'tracks' &&
          (room.sent.filter((m) => m.t === 'tracks').at(-1) as { tracks: { kind: string }[] })
            .tracks.length,
      ).toBe(0),
    )
  })

  it('shares while someone else shares: no question, and both stay (H5)', async () => {
    const display = stubDisplayMedia()
    await publishWei(['mic', 'screen'])
    roomShares = { w: { memberId: 'w', since: 5 } }
    visitRoom()
    await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    fireEvent.click(screen.getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(sockets.at(-1)!.sent).toContainEqual({ t: 'share' }))
    expect(display.getDisplayMedia).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    const room = sockets.at(-1)!
    room.patch([{ op: 'set', path: ['room', 'shares', 'a'], value: { memberId: 'a', since: 9 } }])
    // We share, and Wei's share stays in our main area; the bar has the 文字／動態 switch
    const bar = await screen.findByRole('region', { name: '你正在分享畫面' })
    const modes = within(bar).getByRole('group', { name: '分享模式' })
    expect(within(modes).getByRole('button', { name: '文字' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(within(modes).getByRole('button', { name: '動態' }))
    expect(within(modes).getByRole('button', { name: '動態' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const stage = screen.getByRole('region', { name: '會議室畫面' })
    expect(stage).toHaveAttribute('data-mode', 'share')
    expect(within(stage).getByRole('figure', { name: 'Wei 分享的畫面' })).toBeInTheDocument()
    // The host stopping our share: back to only Wei's, we are told
    room.patch([{ op: 'del', path: ['room', 'shares', 'a'] }])
    await waitFor(() => expect(screen.queryByRole('region', { name: '你正在分享畫面' })).toBeNull())
    expect(display.captured[0].stopped).toBe(true)
  })

  it('says so when MAX_SHARES already share (share_full)', async () => {
    stubDisplayMedia()
    visitRoom()
    await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    fireEvent.click(screen.getByRole('button', { name: '分享螢幕' }))
    const room = sockets.at(-1)!
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }))
    act(() => room.onmessage?.({ data: JSON.stringify({ t: 'error', code: 'share_full' }) }))
    expect(
      await screen.findByText('已經有 3 個人在分享畫面，等其中一人停止後再試一次。'),
    ).toBeInTheDocument()
  })

  it('shows two shares: the latest big, the other in the strip; the viewer picks (e3-t07)', async () => {
    await publishWei(['mic', 'screen'])
    // Lin shares too, after Wei
    const lin = sfu.createTransport()
    await lin.connect()
    const linScreen = await lin.publish({ kind: 'video' } as MediaStreamTrack, { kind: 'screen' })
    extraMembers = {
      l: {
        id: 'l',
        name: 'Lin',
        joinedAt: 3,
        reconnecting: false,
        tracks: [{ ...linScreen, muted: false }],
      },
    }
    roomShares = { w: { memberId: 'w', since: 5 }, l: { memberId: 'l', since: 7 } }
    visitRoom()
    const stage = await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    await waitFor(() => expect(stage).toHaveAttribute('data-mode', 'share'), SLOW)
    const main = () => stage.querySelector('[data-share]') as HTMLElement
    // The latest share is big
    expect(within(main()).getByRole('figure', { name: 'Lin 分享的畫面' })).toBeInTheDocument()
    const picker = within(main()).getByRole('group', { name: '選擇主畫面要看誰的分享' })
    expect(within(picker).getByRole('button', { name: 'Lin 的畫面' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // Wei's is first in the strip, and brings itself to the main area
    const strip = within(stage).getByRole('group', { name: '其他參與者' })
    const weiShare = within(strip).getByRole('figure', { name: 'Wei 分享的畫面' })
    fireEvent.click(within(weiShare).getByRole('button', { name: '在主畫面看 Wei 的畫面' }))
    await waitFor(() =>
      expect(within(main()).getByRole('figure', { name: 'Wei 分享的畫面' })).toBeInTheDocument(),
    )
    expect(
      within(within(stage).getByRole('group', { name: '其他參與者' })).getByRole('figure', {
        name: 'Lin 分享的畫面',
      }),
    ).toBeInTheDocument()
    // Remembered for the session
    expect(sessionStorage.getItem(`longtalk:mainShare:${ROOM_ID}`)).toBe('w')
    // And from the picker back to Lin
    fireEvent.click(
      within(within(main()).getByRole('group', { name: '選擇主畫面要看誰的分享' })).getByRole(
        'button',
        { name: 'Lin 的畫面' },
      ),
    )
    await waitFor(() =>
      expect(within(main()).getByRole('figure', { name: 'Lin 分享的畫面' })).toBeInTheDocument(),
    )
    // Both shares are received: the main one asks for the screen's top layer once drawn big
    const ours = [...sfu.transports].at(-1)!
    await waitFor(() => expect(ours.subscriptions.size).toBeGreaterThanOrEqual(2), SLOW)
  })
})

describe('room page: signal and connection stats (H2, e2-t13, e2-t14)', () => {
  it('shows the level another member reports on their nameplate', async () => {
    await publishWei(['mic'])
    weiSignal = 'poor'
    visitRoom()
    const grid = await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    const tile = within(grid).getByRole('figure', { name: 'Wei' })
    expect(within(tile).getByRole('img', { name: '訊號差' })).toBeInTheDocument()
  })

  it('opens 連線統計 from 更多 beside the stage, and closes it', async () => {
    await publishWei(['mic'])
    visitRoom()
    await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '連線統計' }))
    const panel = await screen.findByRole('complementary', { name: '連線統計' })
    // The panel is its own chunk; then it shows the first sample, or that it is collecting
    await waitFor(() => expect(panel).toHaveTextContent(/正在收集連線資料|你的連線/), SLOW)
    fireEvent.click(within(panel).getByRole('button', { name: '關閉連線統計' }))
    expect(screen.queryByRole('complementary', { name: '連線統計' })).toBeNull()
  })
})

describe('room page: 純音訊模式 and 設定 (H3, e6-t04)', () => {
  it('更多 › 純音訊模式 stops receiving the others’ video and restores it', async () => {
    const wei = await publishWei(['mic', 'cam'])
    visitRoom()
    const grid = await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    const tile = within(grid).getByRole('figure', { name: 'Wei' })
    await waitFor(() => expect(within(tile).getByLabelText('Wei 的畫面')).toBeInTheDocument(), SLOW)
    const ours = () => [...sfu.transports].filter((t) => t !== wei).at(-1)!
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '純音訊模式' }))
    // Their tile shows the initial; their sound still plays
    await waitFor(() => expect(within(tile).queryByLabelText('Wei 的畫面')).toBeNull(), SLOW)
    expect(tile).toHaveTextContent('W')
    expect([...ours().subscriptions.keys()].every((key) => key.includes('/mic-'))).toBe(true)
    expect(document.querySelector('audio[data-member="Wei"]')).not.toBeNull()
    expect(screen.getByText('純音訊模式：不接收也不送出視訊')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢復視訊' }))
    await waitFor(() => expect(within(tile).getByLabelText('Wei 的畫面')).toBeInTheDocument(), SLOW)
    expect(ours().subscriptions.size).toBe(2)
  })

  it('更多 › 設定 opens the settings panel', async () => {
    visitRoom()
    await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '設定…' }))
    const dialog = await screen.findByRole('dialog', { name: '設定' })
    expect(
      within(dialog)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['音訊', '視訊', '效能'])
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '設定' })).toBeNull()
  })
})

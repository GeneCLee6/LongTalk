import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ClientMessage, type MemberTrack } from '../../shared/protocol.ts'
import type { Role } from '../../shared/roles.ts'
import { App } from '../../src/App.tsx'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import { DEFAULT_VIEW, loadView, saveView } from '../../src/room/session.ts'
import { TransportContext } from '../../src/room/transportContext.ts'
import { getLocale, strings } from '../../src/strings.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

// What the stage shows (G2, e4-t10, e4-t11): the layout switch in 更多, pinning a tile for
// ourselves, the host's spotlight (sent to the room, shown when the room says so), hiding our
// own tile (remembered) and those without video (their sound still plays).

const ROOM_ID = 'abcdefghij'
const TOKEN = 'A'.repeat(43)
const SLOW = { timeout: 5000 }

let sfu: FakeSfu
let weiTracks: MemberTrack[]
let amingTracks: MemberTrack[]
let ourRole: Role
const sockets: RoomSocket[] = []

/** The room's WebSocket: Wei (who may publish a camera) and 阿明 (no camera) are in the room */
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
      room: { id: ROOM_ID, createdAt: 1, shares: {}, spotlight: null },
      members: {
        w: { id: 'w', name: 'Wei', joinedAt: 1, reconnecting: false, tracks: weiTracks },
        m: { id: 'm', name: '阿明', joinedAt: 2, reconnecting: false, tracks: amingTracks },
        a: { id: 'a', name: 'Gene', role: ourRole, joinedAt: 3, reconnecting: false, tracks: [] },
      },
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
  patch(ops: unknown[]) {
    this.rev += 1
    this.onmessage?.({ data: JSON.stringify({ t: 'patch', rev: this.rev, ops }) })
  }
}

async function publishWeiCamera() {
  const wei = sfu.createTransport()
  await wei.connect()
  const published = await wei.publish({ kind: 'video' } as MediaStreamTrack, { kind: 'cam' })
  weiTracks = [{ ...published, muted: false }]
}

/** 阿明 speaks without a camera */
async function publishAmingMic() {
  const aming = sfu.createTransport()
  await aming.connect()
  const published = await aming.publish({ kind: 'audio' } as MediaStreamTrack, { kind: 'mic' })
  amingTracks = [{ ...published, muted: false }]
}

async function visitRoom() {
  localStorage.setItem('longtalk.name', 'Gene')
  sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
  window.history.pushState({}, '', `/r/${ROOM_ID}`)
  render(
    <TransportContext.Provider value={() => sfu.createTransport()}>
      <App />
    </TransportContext.Provider>,
  )
  const stage = await screen.findByRole('region', { name: strings.room.grid }, SLOW)
  await within(stage).findByRole('figure', { name: 'Wei' }, SLOW)
  return stage
}

const stage = () => screen.getByRole('region', { name: strings.room.grid })
/** The speaker layout's big tile */
const mainTile = () => stage().querySelector('[data-speaker]') as HTMLElement | null

function openMore() {
  fireEvent.click(screen.getByRole('button', { name: strings.toolbar.more }))
  return screen.getByRole('menu', { name: strings.toolbar.more })
}

beforeEach(() => {
  sfu = new FakeSfu()
  weiTracks = []
  amingTracks = []
  ourRole = 'participant'
  sockets.length = 0
  vi.stubGlobal('WebSocket', RoomSocket)
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('view settings (G2): remembered between meetings', () => {
  it('loads the defaults, saves the layout and 隱藏自己, ignores anything else', () => {
    expect(loadView()).toEqual(DEFAULT_VIEW)
    saveView({ layout: 'speaker', hideSelf: true })
    expect(loadView()).toEqual({ layout: 'speaker', hideSelf: true })
    localStorage.setItem('longtalk.view', '{"layout":"paged","hideSelf":"yes"}')
    expect(loadView()).toEqual(DEFAULT_VIEW)
    localStorage.setItem('longtalk.view', 'not json')
    expect(loadView()).toEqual(DEFAULT_VIEW)
  })
})

describe('stage view (G2, e4-t10, e4-t11)', () => {
  it('switches between the gallery and the speaker layout from 更多, and remembers it', async () => {
    await visitRoom()
    expect(stage()).toHaveAttribute('data-mode', 'grid')
    let menu = openMore()
    expect(within(menu).getByRole('menuitemradio', { name: strings.view.grid })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: strings.view.speaker }))
    expect(stage()).toHaveAttribute('data-mode', 'speaker')
    // Nobody spoke yet: the first other member is big, the rest in the strip under it
    expect(within(mainTile()!).getByRole('figure', { name: 'Wei' })).toBeInTheDocument()
    const strip = within(stage()).getByRole('group', { name: strings.stage.strip })
    expect(within(strip).getByRole('figure', { name: 'Gene（你）' })).toBeInTheDocument()
    expect(loadView().layout).toBe('speaker')
    menu = openMore()
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: strings.view.grid }))
    expect(stage()).toHaveAttribute('data-mode', 'grid')
    expect(loadView().layout).toBe('grid')
  })

  it('pins a tile for ourselves only: it takes the main area until unpinned', async () => {
    await visitRoom()
    // Our own tile has no pin button
    expect(screen.queryByRole('button', { name: strings.view.pin('Gene') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.view.pin('阿明') }))
    expect(stage()).toHaveAttribute('data-mode', 'speaker')
    const main = within(mainTile()!).getByRole('figure', { name: '阿明' })
    expect(main).toHaveTextContent(strings.view.pinnedBadge)
    expect(screen.getByText(strings.view.pinnedToast('阿明'))).toBeInTheDocument()
    // Nothing goes to the room: a pin is local
    expect(sockets.at(-1)!.sent.some((m) => m.t === 'spotlight')).toBe(false)
    // Unpinned from 更多 (or the tile's button): back to the chosen layout
    const menu = openMore()
    fireEvent.click(within(menu).getByRole('menuitem', { name: strings.view.unpinMenu }))
    expect(stage()).toHaveAttribute('data-mode', 'grid')
    expect(screen.queryByText(strings.view.pinnedBadge)).toBeNull()
  })

  it('lets only a host spotlight; shows the room’s spotlight to everyone, under our own pin', async () => {
    ourRole = 'host'
    await visitRoom()
    fireEvent.click(screen.getByRole('button', { name: strings.view.spotlight('Wei') }))
    expect(sockets.at(-1)!.sent.at(-1)).toEqual({ t: 'spotlight', memberId: 'w' })
    // Nothing changes until the room says so
    expect(stage()).toHaveAttribute('data-mode', 'grid')
    act(() => sockets.at(-1)!.patch([{ op: 'set', path: ['room', 'spotlight'], value: 'w' }]))
    expect(stage()).toHaveAttribute('data-mode', 'speaker')
    expect(within(mainTile()!).getByRole('figure', { name: 'Wei' })).toHaveTextContent(
      strings.view.spotlightBadge,
    )
    // Our own pin wins on our own screen
    fireEvent.click(screen.getByRole('button', { name: strings.view.pin('阿明') }))
    expect(within(mainTile()!).getByRole('figure', { name: '阿明' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: strings.view.unpin('阿明') }))
    expect(within(mainTile()!).getByRole('figure', { name: 'Wei' })).toBeInTheDocument()
    // Ended from 更多
    const menu = openMore()
    fireEvent.click(within(menu).getByRole('menuitem', { name: strings.view.unspotlightMenu }))
    expect(sockets.at(-1)!.sent.at(-1)).toEqual({ t: 'spotlight', memberId: null })
  })

  it('has no spotlight buttons for a participant, but shows a spotlight on them', async () => {
    await visitRoom()
    expect(screen.queryByRole('button', { name: strings.view.spotlight('Wei') })).toBeNull()
    act(() => sockets.at(-1)!.patch([{ op: 'set', path: ['room', 'spotlight'], value: 'a' }]))
    expect(within(mainTile()!).getByRole('figure', { name: 'Gene（你）' })).toBeInTheDocument()
    expect(screen.getByText(strings.view.spotlightOnYou)).toBeInTheDocument()
    expect(openMore()).not.toHaveTextContent(strings.view.unspotlightMenu)
  })

  it('hides our own tile, and remembers it', async () => {
    await visitRoom()
    fireEvent.click(
      within(openMore()).getByRole('menuitemcheckbox', { name: strings.view.hideSelf }),
    )
    expect(within(stage()).queryByRole('figure', { name: 'Gene（你）' })).toBeNull()
    expect(within(stage()).getByRole('figure', { name: 'Wei' })).toBeInTheDocument()
    expect(loadView().hideSelf).toBe(true)
    const item = within(openMore()).getByRole('menuitemcheckbox', { name: strings.view.hideSelf })
    expect(item).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(item)
    expect(within(stage()).getByRole('figure', { name: 'Gene（你）' })).toBeInTheDocument()
  })

  it('hides those without video, says how many, and keeps their sound', async () => {
    await publishWeiCamera()
    await publishAmingMic()
    await visitRoom()
    await waitFor(
      () => expect(within(stage()).getByLabelText('Wei 的畫面')).toBeInTheDocument(),
      SLOW,
    )
    fireEvent.click(
      within(openMore()).getByRole('menuitemcheckbox', { name: strings.view.hideNoVideo }),
    )
    expect(within(stage()).queryByRole('figure', { name: '阿明' })).toBeNull()
    expect(within(stage()).getByRole('figure', { name: 'Wei' })).toBeInTheDocument()
    // Our own tile follows 隱藏自己 only
    expect(within(stage()).getByRole('figure', { name: 'Gene（你）' })).toBeInTheDocument()
    expect(screen.getByText(strings.view.hiddenNoVideo(1))).toBeInTheDocument()
    // Their sound is apart from the tiles (MemberAudio): it plays on
    await waitFor(
      () => expect(document.querySelector('audio[data-member="阿明"]')).not.toBeNull(),
      SLOW,
    )
    fireEvent.click(screen.getByRole('button', { name: strings.view.showAll }))
    expect(within(stage()).getByRole('figure', { name: '阿明' })).toBeInTheDocument()
  })
})

describe('更多 › 語言 in the room (G1, e4-t15)', () => {
  it('switches to English without leaving the call, and remembers it', async () => {
    await visitRoom()
    const before = sockets.length
    const menu = openMore()
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'English' }))
    expect(getLocale()).toBe('en')
    expect(await screen.findByRole('region', { name: 'Meeting view' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument()
    // Nothing remounted: the same connection, still in the room
    expect(sockets.length).toBe(before)
    expect(within(stage()).getByRole('figure', { name: 'Wei' })).toBeInTheDocument()
    expect(localStorage.getItem('longtalk.locale')).toBe('en')
    const again = openMore()
    expect(within(again).getByRole('menuitemradio', { name: 'English' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.click(within(again).getByRole('menuitemradio', { name: '繁體中文' }))
    expect(await screen.findByRole('button', { name: '更多' })).toBeInTheDocument()
  })
})

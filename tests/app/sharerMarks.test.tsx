import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Stroke } from '../../shared/annotation.ts'
import { PROTOCOL_VERSION, type ClientMessage } from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'
import SharePip from '../../src/annotate/SharePip.tsx'
import { SharingBar } from '../../src/components/SharingBar.tsx'
import { ToastViewport } from '../../src/components/Toast.tsx'
import { useToasts } from '../../src/components/useToasts.ts'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import { AnnotationStore } from '../../src/room/annotationStore.ts'
import { MARK_NOTICE_MS, MarkNotices } from '../../src/room/useMarkedOnMyShareNotice.ts'
import { MediaDevicesContext } from '../../src/room/devicesContext.ts'
import { TransportContext } from '../../src/room/transportContext.ts'
import { strings } from '../../src/strings.ts'
import { FakeTrack, fakeMediaDevices } from './media/fakeMedia.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

// The sharer is told when someone draws on their share, and can see it: the toast and its buttons,
// the own view opening by itself where it cannot mirror, the floating window (Document
// Picture-in-Picture) where the browser has it. The own view itself is tests/app/j3.test.tsx.

const stroke = (id: string, by: string): Stroke => ({
  id,
  by,
  tool: 'pen',
  color: 'rose',
  width: 'medium',
  points: [
    [0.1, 0.1],
    [0.2, 0.2],
  ],
})

describe('who to tell about (MarkNotices)', () => {
  it('tells each new author once, never us, and not what was there before', () => {
    const notices = new MarkNotices('me', [stroke('old', 'bob')])
    expect(notices.take([stroke('old', 'bob')], 0)).toEqual([])
    expect(notices.take([stroke('old', 'bob'), stroke('m1', 'me')], 0)).toEqual([])
    expect(notices.take([stroke('b1', 'bob'), stroke('c1', 'carol')], 10)).toEqual(['bob', 'carol'])
    // The same stroke growing is not news
    expect(notices.take([stroke('b1', 'bob')], 20)).toEqual([])
  })

  it('tells the same author again only after MARK_NOTICE_MS', () => {
    const notices = new MarkNotices('me')
    expect(notices.take([stroke('b1', 'bob')], 1_000)).toEqual(['bob'])
    expect(notices.take([stroke('b2', 'bob')], 1_000 + MARK_NOTICE_MS - 1)).toEqual([])
    // Each author has a clock of their own
    expect(notices.take([stroke('c1', 'carol')], 1_000 + MARK_NOTICE_MS - 1)).toEqual(['carol'])
    expect(notices.take([stroke('b3', 'bob')], 1_000 + MARK_NOTICE_MS)).toEqual(['bob'])
  })
})

describe('a toast with buttons', () => {
  function Harness({ onLook }: { onLook: () => void }) {
    const { toasts, show, dismiss } = useToasts()
    return (
      <>
        <button
          type="button"
          onClick={() => show('hi', 'neutral', { actions: [{ label: 'look', onClick: onLook }] })}
        >
          go
        </button>
        <ToastViewport toasts={toasts} onDismiss={dismiss} />
      </>
    )
  }

  it('does what the button says and closes', () => {
    const onLook = vi.fn()
    render(<Harness onLook={onLook} />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    fireEvent.click(screen.getByRole('button', { name: 'look' }))
    expect(onLook).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('hi')).toBeNull()
  })
})

describe('the floating window button on the sharing bar', () => {
  it('is there when the browser has the window, and says when it is open', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<SharingBar onStop={() => {}} pip={{ open: false, onToggle }} />)
    fireEvent.click(screen.getByRole('button', { name: strings.screenShare.pipOpen }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<SharingBar onStop={() => {}} pip={{ open: true, onToggle }} />)
    expect(screen.getByRole('button', { name: strings.screenShare.pipClose })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('is not there without it', () => {
    render(<SharingBar onStop={() => {}} pip={null} />)
    expect(screen.queryByRole('button', { name: strings.screenShare.pipOpen })).toBeNull()
  })
})

/** A Document Picture-in-Picture window, as far as the floating window uses one: this page's document */
function fakePipWindow(): Window {
  return {
    document,
    devicePixelRatio: 1,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => window.cancelAnimationFrame(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    close: vi.fn(),
  } as unknown as Window
}

describe('the floating window', () => {
  const store = () => new AnnotationStore({ send: () => {}, isOpen: () => true })
  const track = new FakeTrack('video', 'screen') as unknown as MediaStreamTrack

  it('shows our share and its marks in the window it is given', () => {
    // jsdom has no second document: this page stands in for the window
    render(
      <SharePip
        pipWindow={fakePipWindow()}
        track={track}
        store={store()}
        layer="me"
        nameOf={() => null}
        mirrorRisk={false}
      />,
    )
    const view = screen.getByRole('figure', { name: strings.screenShare.ownRegion })
    expect(view).toHaveAttribute('data-share-pip')
    expect(within(view).getByText(strings.screenShare.ownLabel)).toBeInTheDocument()
    expect(within(view).getByText(strings.screenShare.pipEmpty)).toBeInTheDocument()
    expect(document.title).toBe(strings.screenShare.pipTitle)
    expect(
      within(view).queryByRole('button', { name: strings.screenShare.ownShowPicture }),
    ).toBeNull()
  })

  it('a whole screen: marks only, until the picture is asked for', () => {
    const marks = store()
    marks.receive({
      t: 'annotation',
      share: 'me',
      by: 'bob',
      ops: [{ op: 'add', stroke: stroke('b1', 'bob') }],
    })
    render(
      <SharePip
        pipWindow={fakePipWindow()}
        track={track}
        store={marks}
        layer="me"
        nameOf={() => null}
        mirrorRisk
      />,
    )
    const view = screen.getByRole('figure', { name: strings.screenShare.ownRegion })
    expect(within(view).queryByText(strings.screenShare.pipEmpty)).toBeNull()
    expect(within(view).getByText(strings.screenShare.ownHidden)).toBeInTheDocument()
    fireEvent.click(within(view).getByRole('button', { name: strings.screenShare.ownShowPicture }))
    expect(within(view).queryByText(strings.screenShare.ownHidden)).toBeNull()
  })
})

// The room page: a share, then someone else's stroke on it

const ROOM_ID = 'abcdefghij'
const TOKEN = 'A'.repeat(43)
const SLOW = { timeout: 5000 }

let sfu: FakeSfu
const sockets: RoomSocket[] = []

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
    const member = (id: string, name: string, joinedAt: number) => ({
      id,
      name,
      joinedAt,
      reconnecting: false,
      tracks: [],
    })
    const state = {
      room: { id: ROOM_ID, createdAt: 1, shares: {} },
      members: { a: member('a', 'Gene', 2), b: member('b', 'Bob', 3) },
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
  receive(message: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }))
  }
  patch(ops: unknown[]) {
    this.rev += 1
    this.receive({ t: 'patch', rev: this.rev, ops })
  }
}

/** A capture that says what it is: a window, or a whole screen */
class SurfaceTrack extends FakeTrack {
  readonly surface: string
  constructor(surface: string) {
    super('video', 'screen', `${surface}:1`)
    this.surface = surface
  }
  override getSettings() {
    return { deviceId: this.deviceId, displaySurface: this.surface }
  }
}

function stubDisplayMedia(surface: 'window' | 'monitor') {
  const getDisplayMedia = vi.fn(async () => {
    const track = new SurfaceTrack(surface)
    return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getDisplayMedia },
    configurable: true,
  })
}

async function shareInRoom(surface: 'window' | 'monitor') {
  stubDisplayMedia(surface)
  localStorage.setItem('longtalk.name', 'Gene')
  sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
  window.history.pushState({}, '', `/r/${ROOM_ID}`)
  const fake = fakeMediaDevices()
  render(
    <TransportContext.Provider value={() => sfu.createTransport()}>
      <MediaDevicesContext.Provider value={fake.devices}>
        <App />
      </MediaDevicesContext.Provider>
    </TransportContext.Provider>,
  )
  await screen.findByRole('region', { name: '會議室畫面' }, SLOW)
  const room = sockets.at(-1)!
  const toolbar = screen.getByRole('toolbar', { name: '會議控制' })
  fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
  await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }), SLOW)
  room.patch([{ op: 'set', path: ['room', 'shares', 'a'], value: { memberId: 'a', since: 9 } }])
  const bar = await screen.findByRole('region', { name: strings.screenShare.youAreSharing })
  return { room, bar }
}

const drawsOnUs = (room: RoomSocket, id: string) =>
  room.receive({
    t: 'annotation',
    share: 'a',
    by: 'b',
    ops: [{ op: 'add', stroke: stroke(id, 'b') }],
  })

const ownView = () => screen.queryByRole('figure', { name: strings.screenShare.ownRegion })
const toast = () => screen.queryByText(strings.screenShare.marking('Bob'))

function setPip(on: boolean) {
  if (on) {
    Object.defineProperty(window, 'documentPictureInPicture', {
      value: { requestWindow: vi.fn(async () => fakePipWindow()) },
      configurable: true,
    })
  } else {
    Reflect.deleteProperty(window, 'documentPictureInPicture')
  }
}

describe('the room page tells the sharer', () => {
  beforeEach(() => {
    sfu = new FakeSfu()
    sockets.length = 0
    vi.stubGlobal('WebSocket', RoomSocket)
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'mediaDevices')
    setPip(false)
  })

  it('a window: the own view opens by itself on the first stroke, with a toast', async () => {
    const { room } = await shareInRoom('window')
    expect(ownView()).toBeNull()
    drawsOnUs(room, 'b1')
    expect(ownView()).not.toBeNull()
    expect(toast()).not.toBeNull()
    // Already looking: no 看標註 to press
    expect(screen.queryByRole('button', { name: strings.screenShare.markingLook })).toBeNull()
  })

  it('closed again, it stays closed; a later stroke offers 看標註 instead', async () => {
    const { room, bar } = await shareInRoom('window')
    drawsOnUs(room, 'b1')
    fireEvent.click(within(bar).getByRole('button', { name: strings.screenShare.ownClose }))
    expect(ownView()).toBeNull()
    // Bob is told about at most every 30 s
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    drawsOnUs(room, 'b2')
    expect(ownView()).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: strings.screenShare.markingLook }))
    expect(ownView()).not.toBeNull()
    vi.restoreAllMocks()
  })

  it('a whole screen: a toast only, whose 看標註 opens the own view (marks only)', async () => {
    const { room } = await shareInRoom('monitor')
    drawsOnUs(room, 'b1')
    expect(ownView()).toBeNull()
    expect(toast()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.screenShare.markingLook }))
    expect(ownView()).not.toBeNull()
    expect(screen.getByText(strings.screenShare.ownHidden)).toBeInTheDocument()
  })

  it('our own strokes say nothing', async () => {
    const { room } = await shareInRoom('monitor')
    room.receive({
      t: 'annotation',
      share: 'a',
      by: 'a',
      ops: [{ op: 'add', stroke: stroke('m1', 'a') }],
    })
    expect(screen.queryByText(strings.screenShare.marking('Gene'))).toBeNull()
  })

  it('no floating window where the browser has none', async () => {
    setPip(false)
    const { room, bar } = await shareInRoom('monitor')
    expect(within(bar).queryByRole('button', { name: strings.screenShare.pipOpen })).toBeNull()
    drawsOnUs(room, 'b1')
    expect(screen.queryByRole('button', { name: strings.screenShare.pipOpen })).toBeNull()
  })

  it('Chrome and Edge: the bar and the toast open the floating window', async () => {
    setPip(true)
    const { room, bar } = await shareInRoom('monitor')
    drawsOnUs(room, 'b1')
    const offered = within(screen.getByRole('region', { name: strings.toast.region })).getByRole(
      'button',
      { name: strings.screenShare.pipOpen },
    )
    fireEvent.click(offered)
    const pip = await waitFor(() => {
      const found = document.querySelector('[data-share-pip]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    }, SLOW)
    expect(within(pip).getByText(strings.screenShare.ownHidden)).toBeInTheDocument()
    expect(
      within(bar).getByRole('button', { name: strings.screenShare.pipClose }),
    ).toBeInTheDocument()
    // Watching it: Bob's next strokes need no toast
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    drawsOnUs(room, 'b2')
    expect(toast()).toBeNull()
    vi.restoreAllMocks()
    // Stopping the share closes it
    fireEvent.click(within(bar).getByRole('button', { name: strings.screenShare.stop }))
    await waitFor(() => expect(document.querySelector('[data-share-pip]')).toBeNull())
  })
})

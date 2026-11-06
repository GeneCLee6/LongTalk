import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ClientMessage } from '../../shared/protocol.ts'
import type { UsageState } from '../../shared/usage.ts'
import { App } from '../../src/App.tsx'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import { MediaDevicesContext } from '../../src/room/devicesContext.ts'
import { TransportContext } from '../../src/room/transportContext.ts'
import { FakeTrack, fakeMediaDevices } from './media/fakeMedia.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

// The camera guard in the room page (`shareStopsCamera`, ADR-001): where the capability says so a
// share turns the camera off first and brings it back after; elsewhere nothing changes.

const ROOM_ID = 'abcdefghij'
const TOKEN = 'A'.repeat(43)
const SLOW = { timeout: 5000 }
const SAFARI = 'Apple Computer, Inc.'
const CHROME = 'Google Inc.'

let sfu: FakeSfu
let usage: UsageState
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
    const state = {
      room: { id: ROOM_ID, createdAt: 1, shares: {} },
      members: { a: { id: 'a', name: 'Gene', joinedAt: 2, reconnecting: false, tracks: [] } },
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
  patch(ops: unknown[]) {
    this.rev += 1
    this.onmessage?.({ data: JSON.stringify({ t: 'patch', rev: this.rev, ops }) })
  }
}

function setVendor(vendor: string) {
  Object.defineProperty(navigator, 'vendor', { value: vendor, configurable: true })
}

/** getDisplayMedia on the real navigator: what the capability and the share button look at */
function stubDisplayMedia() {
  const tracks: FakeTrack[] = []
  const getDisplayMedia = vi.fn(async () => {
    const track = new FakeTrack('video', 'screen', 'window:1')
    tracks.push(track)
    return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getDisplayMedia },
    configurable: true,
  })
  return { getDisplayMedia, tracks }
}

async function enterRoom() {
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
  const toolbar = screen.getByRole('toolbar', { name: '會議控制' })
  return { fake, toolbar, room: sockets.at(-1)! }
}

const lastTracks = (room: RoomSocket) => {
  const last = room.sent.filter((m) => m.t === 'tracks').at(-1)
  return last?.t === 'tracks' ? last.tracks : []
}
const camTrack = (room: RoomSocket) => lastTracks(room).find((t) => t.kind === 'cam')

async function cameraPublished(room: RoomSocket) {
  await waitFor(() => expect(camTrack(room)?.muted).toBe(false), SLOW)
}

function granted(room: RoomSocket) {
  act(() => {
    room.patch([{ op: 'set', path: ['room', 'shares', 'a'], value: { memberId: 'a', since: 9 } }])
  })
}

beforeEach(() => {
  sfu = new FakeSfu()
  usage = 'normal'
  sockets.length = 0
  vi.stubGlobal('WebSocket', RoomSocket)
  localStorage.clear()
  sessionStorage.clear()
  setVendor(SAFARI)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setVendor(CHROME)
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

describe('room page with the camera guard (WebKit)', () => {
  it('turns the camera off first, publishes the share after, and brings the camera back', async () => {
    stubDisplayMedia()
    const { toolbar, room } = await enterRoom()
    await cameraPublished(room)
    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }), SLOW)
    // The room was told the camera is off before it was asked for the share
    const share = room.sent.findIndex((m) => m.t === 'share')
    const muted = room.sent.findIndex(
      (m) => m.t === 'tracks' && m.tracks.some((t) => t.kind === 'cam' && t.muted),
    )
    expect(muted).toBeGreaterThanOrEqual(0)
    expect(muted).toBeLessThan(share)
    expect(await screen.findByText(/^鏡頭先關掉了/)).toBeInTheDocument()

    granted(room)
    const bar = await screen.findByRole('region', { name: '你正在分享畫面' })
    await waitFor(() => expect(lastTracks(room).some((t) => t.kind === 'screen')).toBe(true), SLOW)
    expect(camTrack(room)?.muted).toBe(true)
    // Disabled, with the reason in its tooltip and on the bar
    const button = within(toolbar).getByRole('button', { name: '開啟視訊' })
    expect(button).toBeDisabled()
    expect(button.getAttribute('title')).toMatch(/^分享時不能開鏡頭/)
    expect(within(bar).getByText(/^分享時不能開鏡頭/)).toBeInTheDocument()

    fireEvent.click(within(bar).getByRole('button', { name: '停止分享' }))
    await waitFor(() => expect(camTrack(room)?.muted).toBe(false), SLOW)
    const on = within(toolbar).getByRole('button', { name: '關閉視訊' })
    expect(on).toBeEnabled()
    expect(on.getAttribute('title')).not.toMatch(/^分享時不能開鏡頭/)
  })

  it('does not bring back a camera the person had off, and says nothing', async () => {
    stubDisplayMedia()
    const { toolbar, room } = await enterRoom()
    await cameraPublished(room)
    fireEvent.click(within(toolbar).getByRole('button', { name: '關閉視訊' }))
    await waitFor(() => expect(camTrack(room)?.muted).toBe(true), SLOW)
    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }), SLOW)
    expect(screen.queryByText(/^鏡頭先關掉了/)).toBeNull()
    granted(room)
    const bar = await screen.findByRole('region', { name: '你正在分享畫面' })
    // Still locked: turning it on here is what the guard is there to prevent
    expect(within(toolbar).getByRole('button', { name: '開啟視訊' })).toBeDisabled()
    fireEvent.click(within(bar).getByRole('button', { name: '停止分享' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: '你正在分享畫面' })).toBeNull())
    await waitFor(() =>
      expect(within(toolbar).getByRole('button', { name: '開啟視訊' })).toBeEnabled(),
    )
    expect(camTrack(room)?.muted).toBe(true)
  })

  it('changes nothing when the picker is closed', async () => {
    const display = stubDisplayMedia()
    const cancelled = new Error('closed')
    cancelled.name = 'NotAllowedError'
    display.getDisplayMedia.mockRejectedValueOnce(cancelled)
    const { toolbar, room } = await enterRoom()
    await cameraPublished(room)
    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(display.getDisplayMedia).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(camTrack(room)?.muted).toBe(false)
    expect(within(toolbar).getByRole('button', { name: '關閉視訊' })).toBeEnabled()
    expect(screen.queryByText(/^鏡頭先關掉了/)).toBeNull()
  })

  it('brings the camera back when the browser ends the capture, or the room stops the share', async () => {
    const display = stubDisplayMedia()
    const { toolbar, room } = await enterRoom()
    await cameraPublished(room)
    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }), SLOW)
    granted(room)
    await screen.findByRole('region', { name: '你正在分享畫面' })
    act(() => display.tracks[0].end())
    await waitFor(() => expect(camTrack(room)?.muted).toBe(false), SLOW)
    expect(room.sent).toContainEqual({ t: 'unshare' })

    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(room.sent.filter((m) => m.t === 'share')).toHaveLength(2), SLOW)
    granted(room)
    await screen.findByRole('region', { name: '你正在分享畫面' })
    act(() => {
      room.patch([{ op: 'del', path: ['room', 'shares', 'a'] }])
    })
    await waitFor(() => expect(camTrack(room)?.muted).toBe(false), SLOW)
  })

  it('純音訊模式 during a share: the camera comes back only when both are over', async () => {
    stubDisplayMedia()
    const { toolbar, room } = await enterRoom()
    await cameraPublished(room)
    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }), SLOW)
    granted(room)
    const bar = await screen.findByRole('region', { name: '你正在分享畫面' })
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '純音訊模式' }))
    await screen.findByRole('button', { name: '恢復視訊' })

    // The share ends first: still no camera in 純音訊模式
    fireEvent.click(within(bar).getByRole('button', { name: '停止分享' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: '你正在分享畫面' })).toBeNull())
    expect(within(toolbar).getByRole('button', { name: '開啟視訊' })).toBeInTheDocument()
    expect(camTrack(room)?.muted).toBe(true)

    // The mode ends: now it comes back
    fireEvent.click(screen.getByRole('button', { name: '恢復視訊' }))
    await waitFor(() => expect(camTrack(room)?.muted).toBe(false), SLOW)
  })

  it('純音訊模式 ending during a share: the camera waits for the share to end', async () => {
    stubDisplayMedia()
    const { toolbar, room } = await enterRoom()
    await cameraPublished(room)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '純音訊模式' }))
    const restoreVideo = await screen.findByRole('button', { name: '恢復視訊' })
    await waitFor(() => expect(camTrack(room)?.muted).toBe(true), SLOW)

    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }), SLOW)
    // Off already, because of the mode: nothing to say
    expect(screen.queryByText(/^鏡頭先關掉了/)).toBeNull()
    granted(room)
    const bar = await screen.findByRole('region', { name: '你正在分享畫面' })
    fireEvent.click(restoreVideo)
    await waitFor(() => expect(screen.queryByRole('button', { name: '恢復視訊' })).toBeNull())
    expect(within(toolbar).getByRole('button', { name: '開啟視訊' })).toBeDisabled()
    expect(camTrack(room)?.muted).toBe(true)

    fireEvent.click(within(bar).getByRole('button', { name: '停止分享' }))
    await waitFor(() => expect(camTrack(room)?.muted).toBe(false), SLOW)
  })

  it('does not reopen the camera once the month turned audio-only', async () => {
    stubDisplayMedia()
    const { toolbar, room } = await enterRoom()
    await cameraPublished(room)
    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }), SLOW)
    granted(room)
    const bar = await screen.findByRole('region', { name: '你正在分享畫面' })
    act(() => {
      room.patch([{ op: 'set', path: ['usage'], value: 'audioOnly' }])
    })
    fireEvent.click(within(bar).getByRole('button', { name: '停止分享' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: '你正在分享畫面' })).toBeNull())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(within(toolbar).getByRole('button', { name: '開啟視訊' })).toBeInTheDocument()
    expect(camTrack(room)?.muted).toBe(true)
  })
})

describe('room page without the camera guard (Chrome, Edge, Firefox)', () => {
  it('shares with the camera on: no notice, the button works, and nothing else moves', async () => {
    setVendor(CHROME)
    stubDisplayMedia()
    const { toolbar, room } = await enterRoom()
    await cameraPublished(room)
    fireEvent.click(within(toolbar).getByRole('button', { name: '分享螢幕' }))
    await waitFor(() => expect(room.sent).toContainEqual({ t: 'share' }), SLOW)
    granted(room)
    const bar = await screen.findByRole('region', { name: '你正在分享畫面' })
    await waitFor(() => expect(lastTracks(room).some((t) => t.kind === 'screen')).toBe(true), SLOW)
    expect(camTrack(room)?.muted).toBe(false)
    expect(screen.queryByText(/^鏡頭先關掉了/)).toBeNull()
    expect(within(bar).queryByText(/^分享時不能開鏡頭/)).toBeNull()
    const button = within(toolbar).getByRole('button', { name: '關閉視訊' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(camTrack(room)?.muted).toBe(true), SLOW)
    fireEvent.click(within(toolbar).getByRole('button', { name: '開啟視訊' }))
    await waitFor(() => expect(camTrack(room)?.muted).toBe(false), SLOW)
  })
})

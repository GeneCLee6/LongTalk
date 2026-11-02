import { render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ClientMessage, type MemberTrack } from '../../shared/protocol.ts'
import type { UsageState } from '../../shared/usage.ts'
import { App } from '../../src/App.tsx'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import { TransportContext } from '../../src/room/transportContext.ts'

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
  onclose: (() => void) | null = null
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
    weiTracks.push(published)
  }
  return wei
}

function visitRoom() {
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
        <App />
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
    expect(tile.querySelector('audio')).not.toBeNull()
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

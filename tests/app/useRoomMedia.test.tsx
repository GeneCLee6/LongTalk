import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, useSyncExternalStore, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ClientMessage, RoomView } from '../../shared/protocol.ts'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import type { LocalTracks } from '../../src/room/RoomMedia.ts'
import { useRoomMedia } from '../../src/room/useRoomMedia.ts'

// e2-t10: useRoomMedia, the hook the room page runs, on FakeTransport. Two members share one
// FakeSfu and a stand-in for RoomDO that turns each `tracks` message into the member's track list,
// the way the real room does; what one publishes, the other must receive. The browser-level
// version of the same check runs in e2e/interop.spec.ts against the real SFU.

/** A MediaStreamTrack as far as RoomMedia and FakeTransport care */
const fakeTrack = (kind: 'audio' | 'video') =>
  ({ kind, applyConstraints: vi.fn(async () => {}) }) as unknown as MediaStreamTrack

/** RoomDO's part: members, their tracks from `tracks` messages, and a view to subscribe to */
class FakeRoom {
  view: RoomView = {
    room: {
      id: 'abcdefghij',
      createdAt: 1,
      name: null,
      createdBy: null,
      startedAt: null,
      share: null,
      locked: false,
      waitingRoom: false,
      passwordSetAt: null,
      spotlight: null,
    },
    members: {},
    waiting: {},
    usage: 'normal',
  }
  readonly sent: Record<string, ClientMessage[]> = {}
  readonly #listeners = new Set<() => void>()

  add(id: string, name: string): void {
    this.sent[id] = []
    this.#update((members) => {
      members[id] = { id, name, role: 'participant', joinedAt: 1, reconnecting: false, tracks: [], hand: null }
    })
  }

  remove(id: string): void {
    this.#update((members) => {
      delete members[id]
    })
  }

  send = (id: string) => (message: ClientMessage) => {
    this.sent[id]?.push(message)
    if (message.t !== 'tracks') return
    this.#update((members) => {
      const member = members[id]
      if (member) {
        member.tracks = message.tracks.map((t) => ({ sessionId: message.sessionId, ...t }))
      }
    })
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getView = () => this.view

  #update(change: (members: RoomView['members']) => void): void {
    const members = structuredClone(this.view.members)
    change(members)
    this.view = { ...this.view, members }
    for (const listener of this.#listeners) listener()
  }
}

interface Props {
  id: string
  local: LocalTracks | null
  enabled?: boolean
  welcomes?: number
}

/** Renders one member's useRoomMedia, as the room page does, against the room and the SFU */
function renderMember(room: FakeRoom, sfu: FakeSfu, props: Props, strict = false) {
  const createTransport = vi.fn(() => sfu.createTransport())
  const wrapper = strict
    ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    : undefined
  const hook = renderHook(
    ({ id, local, enabled = true, welcomes = 1 }: Props) => {
      const view = useSyncExternalStore(room.subscribe, room.getView)
      return useRoomMedia({
        enabled,
        createTransport,
        local,
        send: room.send(id),
        you: id,
        view,
        welcomes,
      })
    },
    { initialProps: props, wrapper },
  )
  return { ...hook, createTransport }
}

function setUp() {
  const room = new FakeRoom()
  const sfu = new FakeSfu()
  room.add('a', 'Alice')
  room.add('b', 'Bob')
  const alice = { mic: fakeTrack('audio'), cam: fakeTrack('video') }
  const bob = { mic: fakeTrack('audio'), cam: fakeTrack('video') }
  return { room, sfu, alice, bob }
}

const receivedTracks = (state: { received: Record<string, { track: MediaStreamTrack }> }) =>
  Object.values(state.received).map((r) => r.track)

describe('useRoomMedia on FakeTransport (e2-t10)', () => {
  it('two members receive each other’s microphone and camera', async () => {
    const { room, sfu, alice, bob } = setUp()
    const a = renderMember(room, sfu, { id: 'a', local: alice })
    const b = renderMember(room, sfu, { id: 'b', local: bob })

    await waitFor(() => expect(receivedTracks(a.result.current)).toHaveLength(2))
    await waitFor(() => expect(receivedTracks(b.result.current)).toHaveLength(2))
    expect(receivedTracks(a.result.current)).toEqual(expect.arrayContaining([bob.mic, bob.cam]))
    expect(receivedTracks(b.result.current)).toEqual(expect.arrayContaining([alice.mic, alice.cam]))
    expect(a.result.current.status).toBe('connected')
    // Nobody receives their own tracks
    expect(receivedTracks(a.result.current)).not.toContain(alice.mic)
    expect(room.view.members.a?.tracks.map((t) => [t.kind, t.muted])).toEqual([
      ['mic', false],
      ['cam', false],
    ])
  })

  it('keeps exactly one session per member under StrictMode', async () => {
    const { room, sfu, alice, bob } = setUp()
    const a = renderMember(room, sfu, { id: 'a', local: alice }, true)
    const b = renderMember(room, sfu, { id: 'b', local: bob }, true)
    await waitFor(() => expect(receivedTracks(b.result.current)).toHaveLength(2))
    await waitFor(() => expect(receivedTracks(a.result.current)).toHaveLength(2))
    expect(sfu.transports.size).toBe(2)
    expect(sfu.published.size).toBe(4)
  })

  it('waits for the room’s welcome and for the devices before opening a session', async () => {
    const { room, sfu, alice } = setUp()
    const a = renderMember(room, sfu, { id: 'a', local: null, enabled: false })
    a.rerender({ id: 'a', local: null, enabled: true })
    a.rerender({ id: 'a', local: alice, enabled: false })
    await act(async () => {})
    expect(a.createTransport).not.toHaveBeenCalled()
    a.rerender({ id: 'a', local: alice, enabled: true })
    await waitFor(() => expect(a.result.current.published).toHaveLength(2))
    expect(a.createTransport).toHaveBeenCalledTimes(1)
  })

  it('mutes and turns the camera off in the same session; the other member sees it', async () => {
    const { room, sfu, alice, bob } = setUp()
    const a = renderMember(room, sfu, { id: 'a', local: alice })
    const b = renderMember(room, sfu, { id: 'b', local: bob })
    await waitFor(() => expect(receivedTracks(b.result.current)).toHaveLength(2))

    a.rerender({ id: 'a', local: { mic: null, cam: null } })
    await waitFor(() =>
      expect(room.view.members.a?.tracks.map((t) => t.muted)).toEqual([true, true]),
    )
    const [transport] = a.createTransport.mock.results.map((r) => r.value)
    expect([...transport.sending.values()]).toEqual([null, null])
    // Still published, so Bob keeps both tracks (showing them as muted is the page's job)
    expect(receivedTracks(b.result.current)).toHaveLength(2)

    a.rerender({ id: 'a', local: alice })
    await waitFor(() =>
      expect(room.view.members.a?.tracks.map((t) => t.muted)).toEqual([false, false]),
    )
    expect([...transport.sending.values()]).toEqual([alice.mic, alice.cam])
    expect(a.createTransport).toHaveBeenCalledTimes(1)
  })

  it('a member who leaves takes their tracks away from the other', async () => {
    const { room, sfu, alice, bob } = setUp()
    const a = renderMember(room, sfu, { id: 'a', local: alice })
    const b = renderMember(room, sfu, { id: 'b', local: bob })
    await waitFor(() => expect(receivedTracks(a.result.current)).toHaveLength(2))

    b.unmount()
    room.remove('b')
    await waitFor(() => expect(receivedTracks(a.result.current)).toHaveLength(0))
    expect(sfu.transports.size).toBe(1)
    expect(sfu.published.size).toBe(2)
  })

  it('reports its tracks again when the room welcomes it back', async () => {
    const { room, sfu, alice } = setUp()
    const a = renderMember(room, sfu, { id: 'a', local: alice })
    await waitFor(() => expect(a.result.current.published).toHaveLength(2))
    const reports = () => room.sent.a?.filter((m) => m.t === 'tracks').length ?? 0
    const before = reports()
    a.rerender({ id: 'a', local: alice, welcomes: 2 })
    await waitFor(() => expect(reports()).toBe(before + 1))
    expect(a.createTransport).toHaveBeenCalledTimes(1)
  })

  it('starts a new session as a new member when the room forgot this one', async () => {
    const { room, sfu, alice } = setUp()
    room.add('c', 'Alice')
    const a = renderMember(room, sfu, { id: 'a', local: alice })
    await waitFor(() => expect(a.result.current.published).toHaveLength(2))
    a.rerender({ id: 'c', local: alice })
    await waitFor(() => expect(a.createTransport).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(room.view.members.c?.tracks).toHaveLength(2))
    expect(sfu.transports.size).toBe(1)
  })
})

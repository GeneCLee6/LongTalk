import { act, renderHook, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scopeView, type BreakoutView } from '../../shared/breakout.ts'
import type { ClientMessage, MemberTrack, RoomView } from '../../shared/protocol.ts'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import { MediaTransportError, trackKey } from '../../src/media/MediaTransport.ts'
import { RoomMedia, type LocalTracks } from '../../src/room/RoomMedia.ts'
import { useRoomMedia } from '../../src/room/useRoomMedia.ts'

// L3 (e10-t04, AC-10.4), the browser's half: a member moved to another breakout room leaves this
// member's scoped view (shared/breakout.ts scopeView), so their microphone and camera are
// unsubscribed; back in the same room they are subscribed again; someone in the same room stays.
// The room's half (the SFU proxy refusing a pull across rooms) is in tests/worker.

const fakeTrack = (kind: 'audio' | 'video') =>
  ({ kind, applyConstraints: vi.fn(async () => {}) }) as unknown as MediaStreamTrack

const BREAKOUT: BreakoutView = {
  groups: [
    { id: 'g1', name: '第一組' },
    { id: 'g2', name: '第二組' },
  ],
  openedAt: 1,
  endsAt: null,
  closesAt: null,
  broadcast: null,
}

/** RoomDO's part: members, their tracks from `tracks` messages, who is in which room */
class FakeRoom {
  view: RoomView = {
    room: {
      id: 'abcdefghij',
      createdAt: 1,
      name: null,
      createdBy: null,
      startedAt: null,
      shares: {},
      locked: false,
      waitingRoom: false,
      passwordSetAt: null,
      spotlight: null,
      recordings: {},
      annotationPolicy: 'everyone' as const,
      whiteboard: null,
    },
    members: {},
    waiting: {},
    usage: 'normal',
  }
  readonly #listeners = new Set<() => void>()

  add(id: string): void {
    this.#update((members) => {
      members[id] = {
        id,
        name: id,
        role: 'participant',
        joinedAt: 1,
        reconnecting: false,
        tracks: [],
        hand: null,
        signal: null,
        mayRecord: false,
      }
    })
  }

  /** breakoutOpen / breakoutMove / the end of a recall, as far as the view goes */
  move(id: string, group: string | null): void {
    this.#update((members) => {
      members[id]!.group = group
    })
    const anyone = Object.values(this.view.members).some((m) => (m.group ?? null) !== null)
    this.view = { ...this.view, breakout: anyone ? BREAKOUT : null }
    this.#emit()
  }

  send = (id: string) => (message: ClientMessage) => {
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
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

/**
 * One member's useRoomMedia as the room page runs it: with the view scoped to its own room, as
 * useRoomConnection's `state.view` is (or, `whole`, the unscoped one)
 */
function renderMember(room: FakeRoom, sfu: FakeSfu, id: string, local: LocalTracks, whole = false) {
  const createTransport = vi.fn(() => sfu.createTransport())
  return renderHook(() => {
    const full = useSyncExternalStore(room.subscribe, room.getView)
    const view = useMemo(() => (whole ? full : scopeView(full, id)), [full])
    return useRoomMedia({
      enabled: true,
      createTransport,
      local,
      send: room.send(id),
      you: id,
      view,
      welcomes: 1,
    })
  })
}

const received = (state: { received: Record<string, { track: MediaStreamTrack }> }) =>
  Object.values(state.received).map((r) => r.track)

function setUp() {
  const room = new FakeRoom()
  const sfu = new FakeSfu()
  const tracks = {
    a: { mic: fakeTrack('audio'), cam: fakeTrack('video') },
    b: { mic: fakeTrack('audio'), cam: fakeTrack('video') },
    c: { mic: fakeTrack('audio'), cam: fakeTrack('video') },
  }
  for (const id of ['a', 'b', 'c']) room.add(id)
  return { room, sfu, tracks }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('breakout rooms and the media (L3, AC-10.4)', () => {
  it('a member moved to another room is unsubscribed, mic and camera, and back again on return', async () => {
    const { room, sfu, tracks } = setUp()
    const a = renderMember(room, sfu, 'a', tracks.a)
    const b = renderMember(room, sfu, 'b', tracks.b)
    const c = renderMember(room, sfu, 'c', tracks.c)
    await waitFor(() => expect(received(a.result.current)).toHaveLength(4))
    await waitFor(() => expect(received(c.result.current)).toHaveLength(4))

    // c goes to 第一組; a and b stay in the main room
    act(() => room.move('c', 'g1'))
    await waitFor(() => expect(received(a.result.current)).toHaveLength(2))
    expect(received(a.result.current)).toEqual(expect.arrayContaining([tracks.b.mic, tracks.b.cam]))
    expect(received(a.result.current)).not.toContain(tracks.c.mic)
    expect(received(a.result.current)).not.toContain(tracks.c.cam)
    await waitFor(() => expect(received(b.result.current)).toHaveLength(2))
    expect(received(b.result.current)).not.toContain(tracks.c.mic)
    // And c, alone in its room, hears and sees nobody from the main room
    await waitFor(() => expect(received(c.result.current)).toHaveLength(0))
    // Nobody holds a subscription to a track across rooms on the SFU either
    const cKeys = new Set(room.view.members.c!.tracks.map((t: MemberTrack) => trackKey(t)))
    for (const transport of sfu.transports.values()) {
      if (transport.sessionId === room.view.members.c!.tracks[0]!.sessionId) {
        expect(transport.subscriptions.size).toBe(0)
      } else {
        expect([...transport.subscriptions.keys()].some((key) => cKeys.has(key))).toBe(false)
      }
    }
    expect(a.result.current.status).toBe('connected')
    expect(a.result.current.error).toBeNull()

    // b joins c in 第一組: a is alone now, b and c have each other
    act(() => room.move('b', 'g1'))
    await waitFor(() => expect(received(a.result.current)).toHaveLength(0))
    await waitFor(() => expect(received(c.result.current)).toHaveLength(2))
    expect(received(c.result.current)).toEqual(expect.arrayContaining([tracks.b.mic, tracks.b.cam]))

    // Back in the main room (the recall): everyone again, in the same sessions
    act(() => {
      room.move('b', null)
      room.move('c', null)
    })
    await waitFor(() => expect(received(a.result.current)).toHaveLength(4))
    await waitFor(() => expect(received(c.result.current)).toHaveLength(4))
    expect(received(a.result.current)).toEqual(
      expect.arrayContaining([tracks.b.mic, tracks.b.cam, tracks.c.mic, tracks.c.cam]),
    )
    expect(sfu.transports.size).toBe(3)
  })

  it('subscribes only within its own room even when handed the whole view', async () => {
    const { room, sfu, tracks } = setUp()
    renderMember(room, sfu, 'b', tracks.b)
    renderMember(room, sfu, 'c', tracks.c)
    const a = renderMember(room, sfu, 'a', tracks.a, true)
    await waitFor(() => expect(received(a.result.current)).toHaveLength(4))
    act(() => room.move('c', 'g2'))
    await waitFor(() => expect(received(a.result.current)).toHaveLength(2))
    expect(received(a.result.current)).not.toContain(tracks.c.mic)
    act(() => room.move('a', 'g2'))
    await waitFor(() =>
      expect(received(a.result.current)).toEqual(
        expect.arrayContaining([tracks.c.mic, tracks.c.cam]),
      ),
    )
    expect(received(a.result.current)).toHaveLength(2)
  })
})

describe('a pull the room refuses across rooms (L3)', () => {
  /** One member's RoomMedia on the shared FakeSfu, and what it reported */
  function member(sfu: FakeSfu) {
    const transport = sfu.createTransport()
    const sent: ClientMessage[] = []
    const media = new RoomMedia({
      transport,
      send: (m) => sent.push(m),
      retryDelayMs: 1000,
      retryMaxMs: 4000,
    })
    const listed = (): MemberTrack[] => {
      const last = sent.filter((s) => s.t === 'tracks').at(-1)
      if (last?.t !== 'tracks') return []
      return last.tracks.map((t) => ({ sessionId: last.sessionId, ...t }))
    }
    return { transport, media, listed }
  }

  it('drops one no longer wanted without an error or a retry', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu)
    const c = member(sfu)
    await a.media.start({ mic: null, cam: null })
    await c.media.start({ mic: fakeTrack('audio'), cam: fakeTrack('video') })
    const subscribe = vi.spyOn(a.transport, 'subscribeMany')
    // The proxy answers track_not_in_room: c was moved while we asked
    subscribe.mockImplementationOnce(async (requests) =>
      requests.map(() => ({
        status: 'rejected' as const,
        reason: new MediaTransportError('not_found', 'track_not_in_room'),
      })),
    )
    a.media.setDesired(c.listed())
    await vi.advanceTimersByTimeAsync(0)
    // Then the view without c arrives
    a.media.setDesired([])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(a.media.getState()).toMatchObject({ status: 'connected', error: null, received: {} })
    await a.media.close()
    await c.media.close()
  })

  it('tries one still wanted again with backoff, quietly, and takes it once the room allows', async () => {
    vi.useFakeTimers()
    const sfu = new FakeSfu()
    const a = member(sfu)
    const c = member(sfu)
    await a.media.start({ mic: null, cam: null })
    await c.media.start({ mic: fakeTrack('audio'), cam: null })
    const subscribe = vi.spyOn(a.transport, 'subscribeMany')
    const refuse = async (requests: readonly unknown[]) =>
      requests.map(() => ({
        status: 'rejected' as const,
        reason: new MediaTransportError('not_found', 'track_not_in_room'),
      }))
    subscribe.mockImplementationOnce(refuse).mockImplementationOnce(refuse)
    a.media.setDesired(c.listed())
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(a.media.getState().error).toBeNull()
    // Waits about retryDelayMs, then twice that: not a loop
    await vi.advanceTimersByTimeAsync(500)
    expect(subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(800)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(subscribe).toHaveBeenCalledTimes(3)
    expect(Object.keys(a.media.getState().received)).toHaveLength(1)
    expect(a.media.getState()).toMatchObject({ status: 'connected', error: null })
    await a.media.close()
    await c.media.close()
  })
})

// G3 in the browser (e5-t03, e5-t04, e4-t16): the reactions picker and the floats, hiding them,
// prefers-reduced-motion; raising a hand, the host's toast and lowering it; the sounds and when
// they stay quiet
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type Member } from '../../shared/protocol.ts'
import {
  MAX_FLOATING_PER_TILE,
  REACTION_BADGE_MS,
  REACTION_FLOAT_MS,
  REACTION_MERGE_MS,
  REACTION_RATE,
} from '../../shared/reactions.ts'
import { App } from '../../src/App.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { ReactionsButton } from '../../src/components/ReactionsButton.tsx'
import { Tile } from '../../src/components/Tile.tsx'
import { OffStageReactions, TileReactions } from '../../src/components/TileReactions.tsx'
import { Toolbar } from '../../src/components/Toolbar.tsx'
import { PhoneLayoutContext } from '../../src/components/layoutContext.ts'
import { addReaction, liveReactions } from '../../src/room/floatingReactions.ts'
import { RoomConnection, type SocketLike } from '../../src/room/RoomConnection.ts'
import { memberChanges } from '../../src/room/roomEvents.ts'
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../../src/room/session.ts'
import {
  SOUND_CROWD_LIMIT,
  SOUND_GAP_MS,
  Sounds,
  crowdAllowsSound,
  type AudioContextLike,
} from '../../src/room/sounds.ts'
import { useReactions } from '../../src/room/useReactions.ts'
import { media } from '../../src/styles/tokens.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

const ROOM_ID = 'abcdefghij'
const TOKEN = 'S'.repeat(43)

type Frame = Record<string, unknown>

class RoomSocket {
  static instances: RoomSocket[] = []
  static onJoin: (socket: RoomSocket) => void = () => {}
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  constructor() {
    RoomSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(data: string) {
    this.sent.push(data)
    if ((JSON.parse(data) as Frame).t === 'join') RoomSocket.onJoin(this)
  }
  close() {}
  receive(frame: Frame) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const member = (
  id: string,
  name: string,
  role: Member['role'] = 'participant',
  hand: number | null = null,
): Member => ({ id, name, role, joinedAt: id.charCodeAt(0), reconnecting: false, tracks: [], hand })

function welcome(members: Member[]): Frame {
  return {
    t: 'welcome',
    v: PROTOCOL_VERSION,
    you: 'a',
    token: TOKEN,
    rev: 1,
    state: {
      room: { id: ROOM_ID, createdAt: 1, passwordSetAt: null, spotlight: null },
      members: Object.fromEntries(members.map((m) => [m.id, m])),
      waiting: {},
      usage: 'normal',
    },
  }
}

/** A matchMedia that answers yes to `matching` */
function stubMedia(matching: string[]) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matching.includes(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', RoomSocket)
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('longtalk.name', 'Gene')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  RoomSocket.instances = []
  RoomSocket.onJoin = () => {}
  window.history.replaceState(null, '', '/')
})

async function enter(members: Member[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === `/api/rooms/${ROOM_ID}`
        ? Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 1 })
        : Response.json({ error: 'not_found' }, { status: 404 }),
    ),
  )
  sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
  RoomSocket.onJoin = (socket) => queueMicrotask(() => socket.receive(welcome(members)))
  window.history.replaceState(null, '', `/r/${ROOM_ID}`)
  render(<App />)
  await screen.findByText(`目前 ${members.length} 人在線`)
  return RoomSocket.instances.at(-1)!
}

const sentFrames = (socket: RoomSocket) =>
  socket.sent.flatMap((raw) => {
    try {
      return [JSON.parse(raw) as Frame]
    } catch {
      return []
    }
  })
const lastSent = (socket: RoomSocket) => sentFrames(socket).at(-1)
const tile = (name: string) => screen.getByRole('figure', { name })

describe('reactions in the room (e5-t03)', () => {
  it('sends a reaction from the toolbar and floats everyone’s over their tile', async () => {
    const socket = await enter([member('a', 'Gene', 'host'), member('b', 'Bob')])
    fireEvent.click(screen.getByRole('button', { name: '反應' }))
    const picker = screen.getByRole('dialog', { name: '表情反應與舉手' })
    fireEvent.click(within(picker).getByRole('button', { name: '送出「讚」' }))
    expect(lastSent(socket)).toEqual({ t: 'react', emoji: '👍' })
    // A desktop's picker stays open for another
    expect(screen.getByRole('dialog', { name: '表情反應與舉手' })).toBeInTheDocument()
    await act(async () => socket.receive({ t: 'reaction', from: 'b', emoji: '👏' }))
    await act(async () => socket.receive({ t: 'reaction', from: 'b', emoji: '👏' }))
    expect(within(tile('Bob')).getByRole('img', { name: 'Bob：拍手 ×2' })).toBeInTheDocument()
    await act(async () => socket.receive({ t: 'reaction', from: 'a', emoji: '👍' }))
    expect(within(tile('Gene（你）')).getByRole('img', { name: 'Gene：讚' })).toBeInTheDocument()
    // Escape closes the picker
    fireEvent.keyDown(screen.getByRole('dialog', { name: '表情反應與舉手' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '表情反應與舉手' })).toBeNull()
  })

  it('says so instead of sending more than REACTION_RATE', async () => {
    const socket = await enter([member('a', 'Gene', 'host')])
    fireEvent.click(screen.getByRole('button', { name: '反應' }))
    const send = screen.getByRole('button', { name: '送出「慶祝」' })
    for (let i = 0; i < REACTION_RATE.count + 1; i++) fireEvent.click(send)
    expect(sentFrames(socket).filter((frame) => frame.t === 'react')).toHaveLength(
      REACTION_RATE.count,
    )
    expect(screen.getByText('反應送得太快了，稍等一下再送')).toBeInTheDocument()
  })

  it('hides everyone’s reactions from 更多, remembered', async () => {
    const socket = await enter([member('a', 'Gene', 'host'), member('b', 'Bob')])
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '隱藏表情反應' }))
    expect(loadPrefs().hideReactions).toBe(true)
    await act(async () => socket.receive({ t: 'reaction', from: 'b', emoji: '🎉' }))
    expect(within(tile('Bob')).queryByRole('img', { name: /慶祝/ })).toBeNull()
  })
})

describe('raised hands in the room (e5-t04)', () => {
  it('raises and lowers our own hand from 反應', async () => {
    const socket = await enter([member('a', 'Bob'), member('h', 'Gene', 'host')])
    fireEvent.click(screen.getByRole('button', { name: '反應' }))
    fireEvent.click(screen.getByRole('button', { name: '舉手', pressed: false }))
    expect(lastSent(socket)).toEqual({ t: 'hand', up: true })
    expect(screen.getByText('你舉手了，主持人會看到')).toBeInTheDocument()
    await act(async () =>
      socket.receive({
        t: 'patch',
        rev: 2,
        ops: [{ op: 'set', path: ['members', 'a', 'hand'], value: 5 }],
      }),
    )
    expect(
      within(tile('Bob（你）')).getByRole('img', { name: '舉手，第 1 位' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '反應（你已舉手）' }))
    fireEvent.click(screen.getByRole('button', { name: '放下手', pressed: true }))
    expect(lastSent(socket)).toEqual({ t: 'hand', up: false })
    // The host lowered it: we are told by whom
    await act(async () => socket.receive({ t: 'notice', notice: 'handLowered', by: 'h' }))
    expect(screen.getByText('主持人 Gene 放下了你的手。')).toBeInTheDocument()
  })

  it('tells the host who raised a hand, lists them first in order, and lowers it', async () => {
    const socket = await enter([
      member('a', 'Gene', 'host'),
      member('b', 'Bob'),
      member('c', 'Carol'),
    ])
    await act(async () =>
      socket.receive({
        t: 'patch',
        rev: 2,
        ops: [
          { op: 'set', path: ['members', 'c', 'hand'], value: 3 },
          { op: 'set', path: ['members', 'b', 'hand'], value: 4 },
        ],
      }),
    )
    expect(screen.getByText('Carol 舉手了')).toBeInTheDocument()
    expect(screen.getByText('Bob 舉手了')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^參與者/ }))
    const list = screen.getByRole('list', { name: '參與者名單' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['Carol', 'Bob', 'Gene'])
    expect(
      within(within(list).getByRole('listitem', { name: 'Bob' })).getByRole('img', {
        name: '舉手，第 2 位',
      }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '對 Carol 的動作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '放下手' }))
    expect(lastSent(socket)).toEqual({ t: 'host', action: 'lowerHand', memberId: 'c' })
    expect(screen.getByText('已放下 Carol 的手')).toBeInTheDocument()
  })

  it('does not toast a participant about someone else’s hand', async () => {
    const socket = await enter([member('a', 'Bob'), member('h', 'Gene', 'host')])
    await act(async () =>
      socket.receive({
        t: 'patch',
        rev: 2,
        ops: [{ op: 'set', path: ['members', 'h', 'hand'], value: 3 }],
      }),
    )
    expect(screen.queryByText('Gene 舉手了')).toBeNull()
    expect(within(tile('Gene')).getByRole('img', { name: '舉手，第 1 位' })).toBeInTheDocument()
  })

  it('offers no one but a host or co-host 放下手 for someone else', () => {
    render(
      <ParticipantsPanel
        members={[
          member('a', 'Bob'),
          member('c', 'Carol', 'participant', 2),
          member('h', 'Gene', 'host'),
        ]}
        you="a"
        sharerId={null}
        onAction={vi.fn()}
        onMuteAll={vi.fn()}
        onEndMeeting={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: '對 Carol 的動作' })).toBeNull()
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-label', 'Carol')
  })
})

describe('the 反應 button', () => {
  it('opens a bottom sheet on a phone, which closes after a reaction', () => {
    const onReact = vi.fn()
    render(
      <PhoneLayoutContext.Provider value="portrait">
        <ReactionsButton handUp={false} onReact={onReact} onToggleHand={vi.fn()} />
      </PhoneLayoutContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '反應' }))
    const sheet = screen.getByRole('dialog', { name: '表情反應與舉手' })
    fireEvent.click(within(sheet).getByRole('button', { name: '送出「愛心」' }))
    expect(onReact).toHaveBeenCalledWith('❤️')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves along the row with the arrow keys', () => {
    render(<ReactionsButton handUp={false} onReact={vi.fn()} onToggleHand={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '反應' }))
    const first = screen.getByRole('button', { name: '送出「讚」' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(screen.getByRole('button', { name: '送出「慶祝」' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(first).toHaveFocus()
  })

  it('takes participants’ key on a phone: participants moves into 更多 with the waiting badge', () => {
    const onToggleParticipants = vi.fn()
    render(
      <PhoneLayoutContext.Provider value="portrait">
        <Toolbar
          memberCount={3}
          waitingCount={2}
          canShareScreen={false}
          onToggleShare={vi.fn()}
          onToggleChat={vi.fn()}
          onToggleParticipants={onToggleParticipants}
          moreItems={[]}
          onLeave={vi.fn()}
          micOn
          camOn
          onToggleMic={vi.fn()}
          onToggleCam={vi.fn()}
          devices={{ audioinput: [], videoinput: [], audiooutput: [] }}
          selected={{ mic: null, cam: null, speaker: null }}
          onSelect={vi.fn()}
          speakerSupported={false}
          reactions={{ handUp: false, onReact: vi.fn(), onToggleHand: vi.fn() }}
        />
      </PhoneLayoutContext.Provider>,
    )
    expect(screen.queryByRole('button', { name: /^參與者/ })).toBeNull()
    expect(screen.getByRole('button', { name: '反應' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '更多（2 人在等候室）' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '參與者（3 人，2 人在等候室）' }))
    expect(onToggleParticipants).toHaveBeenCalled()
  })
})

describe('floating reactions', () => {
  it('merges a burst of the same reaction and caps the bubbles per tile', () => {
    let list = addReaction([], '👏', 0, 1, 0)
    list = addReaction(list, '👏', REACTION_MERGE_MS - 1, 2, 0)
    expect(list).toEqual([{ key: 1, emoji: '👏', count: 2, at: 0, drift: 0 }])
    list = addReaction(list, '👏', REACTION_MERGE_MS, 3, 0)
    expect(list.map((b) => b.count)).toEqual([2, 1])
    for (let i = 0; i < MAX_FLOATING_PER_TILE; i++)
      list = addReaction(list, '😂', 10_000 + i * 2_000, 10 + i, 0)
    expect(list).toHaveLength(MAX_FLOATING_PER_TILE)
    expect(list.every((b) => b.emoji === '😂')).toBe(true)
    expect(liveReactions(list, 10_000 + REACTION_FLOAT_MS, REACTION_FLOAT_MS)).toHaveLength(
      MAX_FLOATING_PER_TILE - 1,
    )
  })

  it('lasts REACTION_FLOAT_MS, or REACTION_BADGE_MS with reduced motion', () => {
    vi.useFakeTimers()
    let emit: (r: { t: 'reaction'; from: string; emoji: '👍' }) => void = () => {}
    const subscribe = (listener: typeof emit) => {
      emit = listener
      return () => {}
    }
    const { result, rerender } = renderHook(
      ({ reducedMotion }) => useReactions(subscribe, { hidden: false, reducedMotion }),
      { initialProps: { reducedMotion: false } },
    )
    act(() => emit({ t: 'reaction', from: 'b', emoji: '👍' }))
    expect(result.current.b).toHaveLength(1)
    act(() => vi.advanceTimersByTime(REACTION_FLOAT_MS - 100))
    expect(result.current.b).toHaveLength(1)
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.b).toBeUndefined()
    rerender({ reducedMotion: true })
    act(() => emit({ t: 'reaction', from: 'b', emoji: '👍' }))
    act(() => vi.advanceTimersByTime(REACTION_BADGE_MS + 100))
    expect(result.current.b).toBeUndefined()
  })

  it('floats every bubble, or shows only the newest still with reduced motion', () => {
    const bubbles = [
      { key: 1, emoji: '👍' as const, count: 1, at: 0, drift: 0.5 },
      { key: 2, emoji: '🎉' as const, count: 3, at: 1, drift: -0.5 },
    ]
    const { unmount } = render(<TileReactions name="Bob" reactions={bubbles} />)
    expect(screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Bob：讚',
      'Bob：慶祝 ×3',
    ])
    unmount()
    stubMedia([media.reducedMotion])
    render(<TileReactions name="Bob" reactions={bubbles} />)
    expect(screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Bob：慶祝 ×3',
    ])
  })

  it('shows reactions from someone off the stage beside it', () => {
    render(
      <OffStageReactions
        entries={[{ name: '你', bubble: { key: 1, emoji: '😮', count: 1, at: 0, drift: 0 } }]}
      />,
    )
    expect(screen.getByRole('img', { name: '你：驚訝' })).toBeInTheDocument()
  })

  it('puts the hand on the tile in amber with its place', () => {
    render(<Tile name="Bob" video={null} hand={2} />)
    expect(screen.getByRole('img', { name: '舉手，第 2 位' })).toHaveTextContent('舉手')
  })
})

describe('RoomConnection reactions', () => {
  function connect() {
    const sockets: (SocketLike & { sent: string[]; receive: (f: Frame) => void })[] = []
    const connection = new RoomConnection(
      ROOM_ID,
      { name: 'Gene', token: null, client: null },
      {
        origin: 'ws://x',
        createSocket: () => {
          const socket = {
            readyState: 1,
            sent: [] as string[],
            send(data: string) {
              this.sent.push(data)
            },
            close() {},
            onopen: null,
            onmessage: null,
            onclose: null,
            receive(frame: Frame) {
              this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
            },
          } as SocketLike & { sent: string[]; receive: (f: Frame) => void }
          sockets.push(socket)
          return socket
        },
      },
    )
    connection.start()
    const socket = sockets[0]
    socket.onopen?.(new Event('open'))
    return { connection, socket }
  }

  it('hears reactions only after the welcome, and rate-limits its own', () => {
    const { connection, socket } = connect()
    const heard = vi.fn()
    connection.onReaction(heard)
    socket.receive({ t: 'reaction', from: 'b', emoji: '👍' })
    expect(heard).not.toHaveBeenCalled()
    expect(connection.sendReaction('👍')).toBe('offline')
    socket.receive(welcome([member('a', 'Gene', 'host')]))
    socket.receive({ t: 'reaction', from: 'b', emoji: '👍' })
    expect(heard).toHaveBeenCalledWith({ t: 'reaction', from: 'b', emoji: '👍' })
    for (let i = 0; i < REACTION_RATE.count; i++)
      expect(connection.sendReaction('🎉', 0)).toBe('sent')
    expect(connection.sendReaction('🎉', 1)).toBe('rateLimited')
    expect(connection.sendReaction('🎉', REACTION_RATE.windowMs)).toBe('sent')
    connection.stop()
  })
})

/** A Web Audio stand-in that records what was played */
function fakeAudio() {
  const played: { type: string; freq: number }[] = []
  const sinks: string[] = []
  const param = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() })
  const context = {
    currentTime: 0,
    state: 'running',
    destination: {} as AudioNode,
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    setSinkId: vi.fn(async (id: string) => {
      sinks.push(id)
    }),
    createGain: () => ({ gain: param(), connect: vi.fn() }) as unknown as GainNode,
    createOscillator: () => {
      const oscillator = {
        type: 'sine',
        frequency: {
          setValueAtTime: (freq: number) => played.push({ type: oscillator.type, freq }),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      return oscillator as unknown as OscillatorNode
    },
  } satisfies AudioContextLike
  return { context, played, sinks }
}

describe('sounds (e4-t16)', () => {
  it('stay quiet until the person has interacted with the page', () => {
    const audio = fakeAudio()
    let activated = false
    const create = vi.fn(() => audio.context)
    const sounds = new Sounds({ createContext: create, activated: () => activated, now: () => 0 })
    expect(sounds.play('join')).toBe(false)
    // No audio context before the gesture: the browser would refuse it anyway
    expect(create).not.toHaveBeenCalled()
    activated = true
    expect(sounds.play('join')).toBe(true)
    expect(audio.played.length).toBeGreaterThan(0)
  })

  it('stay quiet while 音效 is off, and the same sound twice within SOUND_GAP_MS', () => {
    const audio = fakeAudio()
    let now = 0
    const sounds = new Sounds({
      createContext: () => audio.context,
      activated: () => true,
      now: () => now,
    })
    sounds.setEnabled(false)
    expect(sounds.play('hand')).toBe(false)
    sounds.setEnabled(true)
    expect(sounds.play('hand')).toBe(true)
    now = SOUND_GAP_MS - 1
    expect(sounds.play('hand')).toBe(false)
    // Another sound is not held back
    expect(sounds.play('chat')).toBe(true)
    now = SOUND_GAP_MS
    expect(sounds.play('hand')).toBe(true)
  })

  it('stay quiet without Web Audio, and follow the room’s speaker where they can', () => {
    expect(new Sounds({ createContext: () => null, activated: () => true }).play('chat')).toBe(
      false,
    )
    const audio = fakeAudio()
    const sounds = new Sounds({ createContext: () => audio.context, activated: () => true })
    sounds.setSpeaker('speaker-2')
    expect(audio.sinks).toEqual([])
    sounds.play('leave')
    expect(audio.sinks).toEqual(['speaker-2'])
    sounds.setSpeaker('speaker-3')
    expect(audio.sinks).toEqual(['speaker-2', 'speaker-3'])
    sounds.close()
    expect(audio.context.close).toHaveBeenCalled()
  })

  it('play join and leave only while the room has at most SOUND_CROWD_LIMIT people', () => {
    expect(SOUND_CROWD_LIMIT).toBe(8)
    expect(crowdAllowsSound(8)).toBe(true)
    expect(crowdAllowsSound(9)).toBe(false)
  })

  it('come from who joined, left or raised a hand, never from us or the first view', () => {
    const before = { a: member('a', 'Gene'), b: member('b', 'Bob'), c: member('c', 'Carol') }
    const after = {
      a: { ...before.a, hand: 4 },
      b: { ...before.b, hand: 5 },
      d: member('d', 'Dave'),
    }
    expect(memberChanges(before, after, 'a')).toEqual({ joined: ['d'], left: ['c'], raised: ['b'] })
    expect(memberChanges(null, after, 'a')).toEqual({ joined: [], left: [], raised: [] })
  })

  it('is switched in 更多 › 通知 › 音效, remembered', async () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
    await enter([member('a', 'Gene', 'host')])
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    const toggle = screen.getByRole('menuitemcheckbox', { name: '音效' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(loadPrefs()).toEqual({ sounds: false, hideReactions: false })
    savePrefs({ sounds: true, hideReactions: true })
    expect(loadPrefs()).toEqual({ sounds: true, hideReactions: true })
    localStorage.setItem('longtalk.prefs', '{"sounds":"no"}')
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
  })
})

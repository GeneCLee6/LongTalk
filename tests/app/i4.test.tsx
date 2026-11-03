// I4 in the browser (e8-t02, AC-8.2): the room decides and everyone is told. The recorder starts
// only once RoomDO lists us; it stops and saves when the room ends it; the red light in the top
// bar for everyone; the notice with 離開會議 for everyone else; the pre-join notice; the host's
// controls; 錄影設定.
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type Member,
  type RecordingInfo,
} from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'
import { PreJoin, type PreJoinProps } from '../../src/components/PreJoin.tsx'
import RecordDialog from '../../src/components/RecordDialog.tsx'
import { TopBar } from '../../src/components/TopBar.tsx'
import { canRecordLocally } from '../../src/media/capabilities.ts'
import { DEFAULT_RECORDING_SETTINGS } from '../../src/record/format.ts'
import type { RecordingHandle } from '../../src/record/recorder.ts'
import { EMPTY_SCENE } from '../../src/record/scene.ts'
import {
  loadRecordingSettings,
  saveRecordingSettings,
  useLocalRecording,
  type LocalRecordingOptions,
  type RecorderModule,
} from '../../src/room/useLocalRecording.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

const ROOM_ID = 'abcdefghij'
const TOKEN = 'S'.repeat(43)

describe('useLocalRecording: the room decides (e8-t02)', () => {
  function setup() {
    const sent: ClientMessage[] = []
    const errors = new Set<(code: ErrorCode) => void>()
    const events: string[] = []
    const stop = vi.fn(async () => ({ fileName: 'f.webm', bytes: 42 }))
    const handle: RecordingHandle = { id: 'r', fileName: 'f.webm', mimeType: 'video/webm', stop }
    let resolveStart: (h: RecordingHandle) => void = () => {}
    const startRecording = vi.fn(
      () =>
        new Promise<RecordingHandle>((resolve) => {
          resolveStart = resolve
        }),
    )
    const module: RecorderModule = { startRecording }
    const base: LocalRecordingOptions = {
      roomId: ROOM_ID,
      roomName: 'Room',
      you: 'a',
      recordings: {},
      send: (message) => sent.push(message),
      onError: (listener) => {
        errors.add(listener)
        return () => errors.delete(listener)
      },
      getScene: () => EMPTY_SCENE,
      powerSaving: false,
      notify: (event) => events.push(event.type),
      load: async () => module,
    }
    const hook = renderHook((props: Partial<LocalRecordingOptions>) =>
      useLocalRecording({ ...base, ...props }),
    )
    const listed = (on: boolean): Record<string, RecordingInfo> =>
      on ? { a: { memberId: 'a', since: 1 } } : {}
    return {
      ...hook,
      sent,
      events,
      stop,
      startRecording,
      started: () => act(async () => resolveStart(handle)),
      error: (code: ErrorCode) => act(() => errors.forEach((listener) => listener(code))),
      listed,
    }
  }
  const settle = () => act(async () => vi.advanceTimersByTimeAsync(1))

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the room first and loads the recorder only once it is listed', async () => {
    const t = setup()
    act(() => t.result.current.start(DEFAULT_RECORDING_SETTINGS))
    expect(t.sent).toEqual([{ t: 'record', on: true }])
    expect(t.result.current.phase).toBe('claiming')
    await settle()
    expect(t.startRecording).not.toHaveBeenCalled()
    t.rerender({ recordings: t.listed(true) })
    await settle()
    expect(t.result.current.phase).toBe('starting')
    expect(t.startRecording).toHaveBeenCalledTimes(1)
    await t.started()
    expect(t.result.current.phase).toBe('recording')
    expect(t.events).toEqual(['started'])
    // We stop: saved, then the room is told
    await act(async () => t.result.current.stop())
    expect(t.sent.at(-1)).toEqual({ t: 'record', on: false })
    expect(t.stop).toHaveBeenCalledTimes(1)
    await settle()
    expect(t.result.current.phase).toBe('idle')
    expect(t.events).toEqual(['started', 'saved'])
  })

  it('stops and saves when the room ends it (the host stopped it, or it left)', async () => {
    const t = setup()
    act(() => t.result.current.start(DEFAULT_RECORDING_SETTINGS))
    t.rerender({ recordings: t.listed(true) })
    await settle()
    await t.started()
    const sentBefore = t.sent.length
    t.rerender({ recordings: t.listed(false) })
    await settle()
    expect(t.stop).toHaveBeenCalledTimes(1)
    // Not told again: the room already ended it
    expect(t.sent).toHaveLength(sentBefore)
    expect(t.result.current.phase).toBe('idle')
    expect(t.events).toEqual(['started', 'saved'])
  })

  it('gives up when the room refuses or never answers', async () => {
    const t = setup()
    act(() => t.result.current.start(DEFAULT_RECORDING_SETTINGS))
    t.error('forbidden')
    expect(t.result.current.phase).toBe('idle')
    expect(t.events).toEqual(['forbidden'])
    act(() => t.result.current.start(DEFAULT_RECORDING_SETTINGS))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(t.result.current.phase).toBe('idle')
    expect(t.sent.at(-1)).toEqual({ t: 'record', on: false })
    expect(t.events).toEqual(['forbidden', 'startFailed'])
    expect(t.startRecording).not.toHaveBeenCalled()
  })

  it('tells the room it is not recording when it finds itself listed without a recorder (a reload)', async () => {
    const t = setup()
    t.rerender({ recordings: t.listed(true) })
    await settle()
    expect(t.sent).toEqual([{ t: 'record', on: false }])
    expect(t.startRecording).not.toHaveBeenCalled()
  })

  it('saves the recording when the room page goes (leaving)', async () => {
    const t = setup()
    act(() => t.result.current.start(DEFAULT_RECORDING_SETTINGS))
    t.rerender({ recordings: t.listed(true) })
    await settle()
    await t.started()
    t.unmount()
    expect(t.stop).toHaveBeenCalledTimes(1)
  })

  it('remembers 錄影設定', () => {
    localStorage.clear()
    expect(loadRecordingSettings()).toEqual(DEFAULT_RECORDING_SETTINGS)
    saveRecordingSettings({ audioOnly: true, includeSelf: false, resolution: '1080p' })
    expect(loadRecordingSettings()).toEqual({
      audioOnly: true,
      includeSelf: false,
      resolution: '1080p',
    })
    localStorage.setItem('longtalk.recording.settings', '{"resolution":"4k","audioOnly":1}')
    expect(loadRecordingSettings()).toEqual(DEFAULT_RECORDING_SETTINGS)
  })
})

describe('the red light and the notices (e8-t02, AC-8.2)', () => {
  it('shows who records in the top bar; for the recorder it is 停止錄影', () => {
    const { rerender } = render(
      <TopBar
        title="Room"
        startedAt={null}
        status="x"
        warn={false}
        recording={{ label: 'Bob 正在錄影' }}
        onCopyLink={() => {}}
      />,
    )
    expect(screen.getByRole('img', { name: 'Bob 正在錄影' })).toBeInTheDocument()
    const onStop = vi.fn()
    rerender(
      <TopBar
        title="Room"
        startedAt={null}
        status="x"
        warn={false}
        recording={{ label: '你正在錄影', onStop }}
        onCopyLink={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '停止錄影（你正在錄影）' }))
    expect(onStop).toHaveBeenCalled()
  })

  it('tells someone about to join that the meeting is being recorded, with a way not to join', () => {
    const onHome = vi.fn()
    const props: PreJoinProps = {
      roomId: ROOM_ID,
      memberCount: 2,
      name: 'Ada',
      onNameChange: () => {},
      mic: false,
      cam: false,
      onToggleMic: () => {},
      onToggleCam: () => {},
      stream: null,
      opening: false,
      level: 0,
      devices: { audioinput: [], videoinput: [], audiooutput: [] },
      selected: { mic: null, cam: null, speaker: null },
      onSelect: () => {},
      speakerSupported: false,
      micProblem: null,
      camProblem: null,
      onRetry: () => {},
      onJoin: () => {},
    }
    const { rerender } = render(<PreJoin {...props} />)
    expect(screen.queryByText('這場會議正在錄影')).toBeNull()
    rerender(<PreJoin {...props} recording onHome={onHome} />)
    expect(screen.getByText('這場會議正在錄影')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '不加入，回首頁' }))
    expect(onHome).toHaveBeenCalled()
  })

  it('錄影設定: sound only, resolution, our own camera, and what everyone will see', () => {
    const onStart = vi.fn()
    render(
      <RecordDialog
        initial={DEFAULT_RECORDING_SETTINGS}
        formats={{ video: 'video/webm;codecs=vp9,opus', audio: 'audio/webm;codecs=opus' }}
        onStart={onStart}
        onCancel={() => {}}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: '開始錄影' })
    expect(within(dialog).getByText(/所有人都會看到「錄影中」/)).toBeInTheDocument()
    expect(within(dialog).getByText('檔案格式：video/webm')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByLabelText('1080p（畫質較好，較耗電）'))
    fireEvent.click(within(dialog).getByLabelText('包含我的鏡頭'))
    fireEvent.click(within(dialog).getByRole('button', { name: '開始錄影' }))
    expect(onStart).toHaveBeenCalledWith({
      audioOnly: false,
      includeSelf: false,
      resolution: '1080p',
    })
    fireEvent.click(within(dialog).getByLabelText('只錄聲音'))
    expect(within(dialog).getByText('檔案格式：audio/webm')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('包含我的鏡頭')).toBeDisabled()
  })
})

type Frame = Record<string, unknown>

/** A WebSocket stand-in whose answers each test scripts */
class RoomSocket {
  static instances: RoomSocket[] = []
  static onJoin: (socket: RoomSocket) => void = () => {}
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
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
    if ((JSON.parse(data) as Frame).t === 'join') RoomSocket.onJoin(this)
  }
  close() {}
  receive(frame: Frame) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const member = (id: string, name: string, role: Member['role'], extra: Partial<Member> = {}) => ({
  id,
  name,
  role,
  joinedAt: 1,
  reconnecting: false,
  tracks: [],
  hand: null,
  signal: null,
  mayRecord: false,
  ...extra,
})

describe('recording in the room (e8-t02, AC-8.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', RoomSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 1 })),
    )
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('longtalk.name', 'Gene')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    RoomSocket.instances = []
    window.history.replaceState(null, '', '/')
  })

  async function enter(members: Member[], recordings: Record<string, RecordingInfo> = {}) {
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
    RoomSocket.onJoin = (socket) =>
      queueMicrotask(() =>
        socket.receive({
          t: 'welcome',
          v: PROTOCOL_VERSION,
          you: 'a',
          token: TOKEN,
          rev: 1,
          state: {
            room: { id: ROOM_ID, createdAt: 1, passwordSetAt: null, shares: {}, recordings },
            members: Object.fromEntries(members.map((m) => [m.id, m])),
            waiting: {},
            usage: 'normal',
          },
        }),
      )
    window.history.replaceState(null, '', `/r/${ROOM_ID}`)
    render(<App />)
    await screen.findByText(`目前 ${members.length} 人在線`)
    return RoomSocket.instances.at(-1)!
  }

  it('tells everyone else, with 離開會議, and shows who records in the top bar', async () => {
    // Back after a reload: the pre-join screen did not say it, so the room does
    const socket = await enter([member('a', 'Gene', 'participant'), member('b', 'Bob', 'host')], {
      b: { memberId: 'b', since: 5 },
    })
    expect(screen.getByRole('img', { name: 'Bob 正在錄影' })).toBeInTheDocument()
    const consent = () => screen.getByText(/錄影這場會議/).closest('[role="alert"]') as HTMLElement
    const notice = consent()
    expect(notice).toHaveTextContent('Bob 正在錄影這場會議。留在會議中，表示你知道正在錄影。')
    fireEvent.click(within(notice).getByRole('button', { name: '知道了' }))
    expect(screen.queryByText(/正在錄影這場會議/)).toBeNull()
    // Someone else starts: told again, that they started
    await act(async () =>
      socket.receive({
        t: 'patch',
        rev: 2,
        ops: [
          { op: 'set', path: ['members', 'c'], value: member('c', 'Cleo', 'participant') },
          { op: 'set', path: ['room', 'recordings', 'c'], value: { memberId: 'c', since: 9 } },
        ],
      }),
    )
    expect(screen.getByRole('img', { name: '2 人正在錄影' })).toBeInTheDocument()
    expect(consent()).toHaveTextContent('Cleo 開始錄影這場會議')
    // A participant may not record: no 開始錄影
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.queryByRole('menuitem', { name: /開始錄影/ })).toBeNull()
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' })
    // 離開會議 leaves
    fireEvent.click(within(consent()).getByRole('button', { name: '離開會議' }))
    expect(socket.sent.at(-1)).toBe('{"t":"leave"}')
  })

  it('lets the host start recording from 更多 (asking the room), or explains why the browser cannot', async () => {
    const socket = await enter([member('a', 'Gene', 'host'), member('b', 'Bob', 'participant')])
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    const item = screen.getByRole('menuitem', { name: /開始錄影/ })
    // jsdom has no MediaRecorder: grey, with the reason
    expect(canRecordLocally()).toBe(false)
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('這個瀏覽器不能錄影')
    fireEvent.keyDown(item, { key: 'Escape' })
    // The host may allow Bob; the room decides
    fireEvent.click(screen.getByRole('button', { name: /^參與者/ }))
    fireEvent.click(screen.getByRole('button', { name: '對 Bob 的動作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '允許錄影' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"allowRecord","memberId":"b","on":true}')
    expect(screen.getByText('已允許 Bob 錄影')).toBeInTheDocument()
    // Bob records: the host can stop it
    await act(async () =>
      socket.receive({
        t: 'patch',
        rev: 2,
        ops: [
          { op: 'set', path: ['members', 'b', 'mayRecord'], value: true },
          { op: 'set', path: ['room', 'recordings', 'b'], value: { memberId: 'b', since: 9 } },
        ],
      }),
    )
    const row = screen.getByRole('listitem', { name: 'Bob' })
    expect(within(row).getByText('錄影中')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '對 Bob 的動作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '停止錄影' }))
    expect(socket.sent.at(-1)).toBe('{"t":"host","action":"stopRecording","memberId":"b"}')
  })

  it('offers 開始錄影 to a member the host allowed, where the browser can record', async () => {
    vi.stubGlobal(
      'MediaRecorder',
      class {
        static isTypeSupported = (type: string) => type.startsWith('video/webm')
      },
    )
    HTMLCanvasElement.prototype.captureStream ??= (() => {}) as never
    vi.stubGlobal(
      'AudioContext',
      class {
        createMediaStreamDestination() {}
      },
    )
    vi.stubGlobal('indexedDB', {})
    expect(canRecordLocally()).toBe(true)
    const socket = await enter([
      member('a', 'Gene', 'participant', { mayRecord: true }),
      member('b', 'Bob', 'host'),
    ])
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '開始錄影…' }))
    const dialog = await screen.findByRole('dialog', { name: '開始錄影' })
    fireEvent.click(within(dialog).getByRole('button', { name: '開始錄影' }))
    expect(socket.sent.at(-1)).toBe('{"t":"record","on":true}')
    // Until the room lists us, 更多 offers to stop asking
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menuitem', { name: '停止錄影' })).toBeInTheDocument()
  })
})

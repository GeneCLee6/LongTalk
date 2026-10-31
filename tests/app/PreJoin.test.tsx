import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/App.tsx'
import type { AudioContextLike } from '../../src/media/levelMeter.ts'
import { MIC_LEVEL_INTERVAL_MS, useMicLevel } from '../../src/room/useMicLevel.ts'
import { FakeStream, FakeTrack, asStream, fakeMediaDevices } from './media/fakeMedia.ts'

const ROOM_ID = 'abcdefghij'

class QuietSocket {
  readyState = 0
  onopen = null
  onmessage = null
  onclose = null
  send() {}
  close() {}
}

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true })
}

async function openPreJoin(options: Parameters<typeof fakeMediaDevices>[0] = {}) {
  const fake = fakeMediaDevices(options)
  setMediaDevices(fake.devices)
  window.history.pushState({}, '', `/r/${ROOM_ID}`)
  render(<App />)
  await screen.findByRole('heading', { name: '準備加入' })
  return fake
}

const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('WebSocket', QuietSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 0 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  setMediaDevices(undefined)
})

describe('pre-join screen', () => {
  it('shows a mirrored camera preview and the device menus', async () => {
    const fake = await openPreJoin()
    expect(await screen.findByLabelText('鏡頭預覽')).toBeInTheDocument()
    expect(screen.getByText('鏡像預覽')).toBeInTheDocument()
    expect(fake.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true })
    await waitFor(() => expect(select('麥克風').options).toHaveLength(2))
    expect(select('麥克風').value).toBe('mic-1')
    expect([...select('鏡頭').options].map((o) => o.text)).toEqual(['FaceTime HD Camera', '鏡頭 2'])
    expect(screen.getByRole('meter', { name: '麥克風音量' })).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText('目前還沒有人在裡面', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('進房後麥克風開、鏡頭開')).toBeInTheDocument()
  })

  it('reopens the devices when the camera is switched off, and stops the old tracks', async () => {
    const fake = await openPreJoin()
    await screen.findByLabelText('鏡頭預覽')
    fireEvent.click(screen.getByRole('button', { name: '關閉鏡頭' }))
    expect(await screen.findByText('鏡頭已關閉')).toBeInTheDocument()
    await waitFor(() =>
      expect(fake.getUserMedia).toHaveBeenLastCalledWith({ audio: true, video: false }),
    )
    expect(fake.streams[0].tracks.every((track) => track.stopped)).toBe(true)
    expect(screen.getByRole('button', { name: '開啟鏡頭' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByText('進房後麥克風開、鏡頭關')).toBeInTheDocument()
  })

  it('switches to the camera chosen in the menu', async () => {
    const fake = await openPreJoin()
    await waitFor(() => expect(select('鏡頭').options).toHaveLength(2))
    fireEvent.change(select('鏡頭'), { target: { value: 'cam-2' } })
    await waitFor(() =>
      expect(fake.getUserMedia).toHaveBeenLastCalledWith({
        audio: true,
        video: { deviceId: { exact: 'cam-2' } },
      }),
    )
    await waitFor(() => expect(select('鏡頭').value).toBe('cam-2'))
  })

  it('picks up a device plugged in later', async () => {
    const fake = await openPreJoin()
    await waitFor(() => expect(select('麥克風').options).toHaveLength(2))
    const calls = fake.enumerateDevices.mock.calls.length
    await act(async () => fake.fireDeviceChange())
    expect(fake.enumerateDevices.mock.calls.length).toBe(calls + 1)
  })

  it('explains a refusal, offers to retry, and still lets the person join', async () => {
    const fake = await openPreJoin({ denyAll: true, hidden: true })
    expect(await screen.findByRole('alert')).toHaveTextContent('瀏覽器沒有麥克風或鏡頭的權限')
    expect(screen.getByText('鏡頭已關閉')).toBeInTheDocument()
    expect(select('麥克風')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重試' }))
    await waitFor(() => expect(fake.getUserMedia).toHaveBeenCalledTimes(2))
    fireEvent.change(screen.getByRole('textbox', { name: '你的名字' }), {
      target: { value: 'Gene' },
    })
    expect(screen.getByRole('button', { name: '加入' })).toBeEnabled()
  })

  it('says which device is missing', async () => {
    vi.stubGlobal('MediaStream', FakeStream)
    await openPreJoin({ fail: { video: 'NotFoundError' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到鏡頭。')
  })

  it('works without device support at all (an http: page)', async () => {
    setMediaDevices(undefined)
    window.history.pushState({}, '', `/r/${ROOM_ID}`)
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('網頁需要 HTTPS')
  })

  it('offers the speaker menu where the browser can choose one', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      value: () => Promise.resolve(),
      configurable: true,
    })
    try {
      await openPreJoin()
      await waitFor(() => expect(select('喇叭').options).toHaveLength(1))
    } finally {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId
    }
  })

  it('stops the preview when the person joins; the room opens the devices for itself', async () => {
    const fake = await openPreJoin()
    await screen.findByLabelText('鏡頭預覽')
    fireEvent.change(screen.getByRole('textbox', { name: '你的名字' }), {
      target: { value: 'Gene' },
    })
    const preview = fake.streams.length
    fireEvent.click(screen.getByRole('button', { name: '加入' }))
    expect(await screen.findByRole('heading', { name: `會議室 ${ROOM_ID}` })).toBeInTheDocument()
    const previewTracks = fake.streams.slice(0, preview).flatMap((s) => s.tracks)
    expect(previewTracks.every((track) => track.stopped)).toBe(true)
    await waitFor(() => expect(fake.streams.length).toBeGreaterThan(preview))
  })
})

describe('useMicLevel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads the level ten times a second and drops to 0 without a stream', () => {
    let value = 0
    const close = vi.fn(async () => {})
    const context: AudioContextLike = {
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => {} }),
      createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData: (array) => array.fill(value) }),
      close,
    }
    const createContext = () => context
    const stream = asStream(new FakeStream([new FakeTrack('audio', 'mic-1')]))
    const { result, rerender } = renderHook(
      ({ s }: { s: MediaStream | null }) => useMicLevel(s, createContext),
      { initialProps: { s: stream as MediaStream | null } },
    )
    expect(result.current).toBe(0)
    value = 1
    act(() => vi.advanceTimersByTime(MIC_LEVEL_INTERVAL_MS))
    expect(result.current).toBe(1)
    rerender({ s: null })
    expect(result.current).toBe(0)
    expect(close).toHaveBeenCalled()
  })
})

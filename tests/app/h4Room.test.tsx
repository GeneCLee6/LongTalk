import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ClientMessage } from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import type { MediaDevicesLike } from '../../src/media/devices.ts'
import type { NoiseEvent, NoiseSuppressor } from '../../src/media/noiseSuppression.ts'
import { OVERLOAD_SECONDS } from '../../src/media/noiseLoad.ts'
import { MediaDevicesContext } from '../../src/room/devicesContext.ts'
import { loadMediaPrefs } from '../../src/room/session.ts'
import { TransportContext } from '../../src/room/transportContext.ts'
import { fakeMediaDevices, type FakeTrack } from './media/fakeMedia.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

// H4 in the room page: 進階噪音抑制 (e6-t02) sends RNNoise's track in place of the microphone
// (replaceTrack on the same published track), pauses the browser's own noise suppression, and
// turns itself off with a notice when the CPU threshold is crossed; 省電模式 (e6-t05) holds it
// off and turns motion off. jsdom has no AudioWorklet: the capability is said to be there and the
// lazy pipeline module is replaced by a fake.

const pipelines: FakePipeline[] = []

interface FakePipeline extends NoiseSuppressor {
  inputs: (MediaStreamTrack | null)[]
  emit: (event: NoiseEvent) => void
}

vi.mock('../../src/media/capabilities.ts', async (original) => ({
  ...(await original<typeof import('../../src/media/capabilities.ts')>()),
  canSuppressNoise: () => true,
}))
vi.mock('../../src/media/noiseAssets.ts', () => ({
  NOISE_ASSETS: { worklet: '/w.js', wasm: '/r.wasm', wasmSimd: '/rs.wasm' },
}))
vi.mock('../../src/media/noiseSuppression.ts', () => ({
  startNoiseSuppression: async () => {
    const listeners = new Set<(event: NoiseEvent) => void>()
    const inputs: (MediaStreamTrack | null)[] = []
    const pipeline: FakePipeline = {
      track: { kind: 'audio', id: 'rnnoise-out' } as unknown as MediaStreamTrack,
      latencyMs: 12,
      running: () => true,
      setInput: (track) => inputs.push(track),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      close: async () => {},
      inputs,
      emit: (event) => listeners.forEach((listener) => listener(event)),
    }
    pipelines.push(pipeline)
    return pipeline
  },
}))

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
      room: { id: ROOM_ID, createdAt: 1, share: null },
      members: { a: { id: 'a', name: 'Gene', joinedAt: 2, reconnecting: false, tracks: [] } },
      usage: 'normal',
    }
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION, you: 'a', token: TOKEN, rev: 1, state }),
      }),
    )
  }
  close() {}
}

function visitRoom(mediaDevices: MediaDevicesLike) {
  localStorage.setItem('longtalk.name', 'Gene')
  sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
  window.history.pushState({}, '', `/r/${ROOM_ID}`)
  render(
    <StrictMode>
      <TransportContext.Provider value={() => sfu.createTransport()}>
        <MediaDevicesContext.Provider value={mediaDevices}>
          <App />
        </MediaDevicesContext.Provider>
      </TransportContext.Provider>
    </StrictMode>,
  )
}

/** What the published microphone sends now, on the one live transport */
const micSending = () => {
  const transport = [...sfu.transports].at(-1)!
  const name = [...transport.sending.keys()].find((key) => key.includes('mic'))
  return name ? transport.sending.get(name) : undefined
}

beforeEach(() => {
  sfu = new FakeSfu()
  sockets.length = 0
  pipelines.length = 0
  vi.stubGlobal('WebSocket', RoomSocket)
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.motion
})

async function openSettings(toolbar: HTMLElement) {
  fireEvent.click(within(toolbar).getByRole('button', { name: '更多' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '設定…' }))
  return screen.findByRole('dialog', { name: '設定' })
}

describe('進階噪音抑制 in the room (e6-t02)', () => {
  it('sends RNNoise’s track instead of the microphone, then the microphone again', async () => {
    const fake = fakeMediaDevices()
    visitRoom(fake.devices)
    const toolbar = await screen.findByRole('toolbar', { name: '會議控制' }, SLOW)
    await waitFor(() => expect(micSending()).toMatchObject({ kind: 'audio' }), SLOW)
    const mic = micSending()
    expect(pipelines).toHaveLength(0)

    const dialog = await openSettings(toolbar)
    fireEvent.click(within(dialog).getByRole('switch', { name: '進階噪音抑制' }))
    await waitFor(() => expect(micSending()).toMatchObject({ id: 'rnnoise-out' }), SLOW)
    expect(loadMediaPrefs().advancedNoise).toBe(true)
    // The browser's own noise suppression is paused on the open microphone (applyConstraints;
    // a browser that will not change it live gets the microphone opened again, H3)
    const raw = mic as unknown as FakeTrack
    await waitFor(() =>
      expect(raw.applyConstraints).toHaveBeenLastCalledWith(
        expect.objectContaining({ noiseSuppression: false }),
      ),
    )
    // The pipeline has the microphone now open (it was opened again for the change)
    const pipeline = pipelines.at(-1)!
    await waitFor(() => expect(pipeline.inputs.at(-1)).toBe(mic))

    // Muted: nothing is sent, whichever track
    fireEvent.click(within(toolbar).getByRole('button', { name: '靜音' }))
    await waitFor(() => expect(micSending()).toBeNull())
    fireEvent.click(within(toolbar).getByRole('button', { name: '解除靜音' }))
    await waitFor(() => expect(micSending()).toMatchObject({ id: 'rnnoise-out' }))

    fireEvent.click(within(dialog).getByRole('switch', { name: '進階噪音抑制' }))
    await waitFor(() => expect(micSending()).toMatchObject({ kind: 'audio' }))
    expect(micSending()).toBe(mic)
  })

  it('turns itself off with a notice when the device cannot keep up', async () => {
    localStorage.setItem(
      'longtalk.media',
      JSON.stringify({ processing: {}, hd: null, advancedNoise: true, powerSaving: false }),
    )
    const fake = fakeMediaDevices()
    visitRoom(fake.devices)
    await screen.findByRole('toolbar', { name: '會議控制' }, SLOW)
    // Opened with the browser's noise suppression off from the start
    await waitFor(() =>
      expect(fake.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({ audio: expect.objectContaining({ noiseSuppression: false }) }),
      ),
    )
    await waitFor(() => expect(micSending()).toMatchObject({ id: 'rnnoise-out' }), SLOW)
    const pipeline = pipelines.at(-1)!
    act(() => {
      for (let i = 0; i < OVERLOAD_SECONDS; i++) {
        pipeline.emit({ type: 'load', report: { load: 0.9, maxMs: 6 } })
      }
    })
    expect(await screen.findByText('你的裝置忙不過來，已關閉進階噪音抑制')).toBeInTheDocument()
    await waitFor(() => expect(micSending()).not.toMatchObject({ id: 'rnnoise-out' }))
    expect(loadMediaPrefs().advancedNoise).toBe(false)
  })
})

describe('省電模式 in the room (e6-t05)', () => {
  it('holds the advanced suppression off, gives the browser’s back, and turns motion off', async () => {
    localStorage.setItem(
      'longtalk.media',
      JSON.stringify({ processing: {}, hd: null, advancedNoise: true, powerSaving: false }),
    )
    const fake = fakeMediaDevices()
    visitRoom(fake.devices)
    const toolbar = await screen.findByRole('toolbar', { name: '會議控制' }, SLOW)
    await waitFor(() => expect(micSending()).toMatchObject({ id: 'rnnoise-out' }), SLOW)
    expect(document.documentElement.dataset.motion).toBeUndefined()

    const dialog = await openSettings(toolbar)
    fireEvent.click(within(dialog).getByRole('tab', { name: '效能' }))
    fireEvent.click(within(dialog).getByRole('switch', { name: '省電模式' }))
    await waitFor(() => expect(micSending()).not.toMatchObject({ id: 'rnnoise-out' }))
    expect(document.documentElement.dataset.motion).toBe('off')
    expect(loadMediaPrefs()).toMatchObject({ advancedNoise: true, powerSaving: true })
    // The browser's noise suppression is back on the microphone
    const raw = pipelines[0].inputs.at(-1) as unknown as FakeTrack
    await waitFor(() =>
      expect(raw.applyConstraints).toHaveBeenLastCalledWith(
        expect.objectContaining({ noiseSuppression: true }),
      ),
    )
    fireEvent.click(within(dialog).getByRole('switch', { name: '省電模式' }))
    await waitFor(() => expect(micSending()).toMatchObject({ id: 'rnnoise-out' }))
    expect(document.documentElement.dataset.motion).toBeUndefined()
  })
})

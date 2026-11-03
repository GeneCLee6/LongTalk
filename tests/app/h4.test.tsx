import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, MemberTrack } from '../../shared/protocol.ts'
import { SettingsDialog, type SettingsDialogProps } from '../../src/components/SettingsDialog.tsx'
import { MotionOffContext, useReducedMotion } from '../../src/components/layoutContext.ts'
import { DEFAULT_PROCESSING } from '../../src/media/audioProcessing.ts'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import type { VideoDemand } from '../../src/media/layers.ts'
import { OVERLOAD_SECONDS, LOAD_LIMIT } from '../../src/media/noiseLoad.ts'
import {
  NoiseSuppressionError,
  startNoiseSuppression,
  type NoiseEvent,
  type NoiseSuppressionEnv,
  type NoiseSuppressor,
} from '../../src/media/noiseSuppression.ts'
import { capFrameRate, POWER_SAVING_FPS } from '../../src/media/powerSaving.ts'
import { FRAMER_DELAY, PROCESSOR_NAME } from '../../src/media/rnnoiseCore.ts'
import { RoomMedia } from '../../src/room/RoomMedia.ts'
import { batteryLow, useBatteryHint } from '../../src/room/useBatteryHint.ts'
import {
  useNoiseSuppression,
  type StartNoiseSuppression,
} from '../../src/room/useNoiseSuppression.ts'
import { VideoDemandStore } from '../../src/room/videoDemand.ts'

// H4: the advanced noise suppression's pipeline and its CPU threshold (e6-t02), and 省電模式
// (e6-t05): lowest layers, no HD, a lower camera frame rate, no animation, no RNNoise.

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

// ---------------------------------------------------------------------------------------------
// The pipeline, on fake Web Audio nodes

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  readonly postMessage = vi.fn()
  /** What the worklet would post */
  emit(data: unknown) {
    this.onmessage?.({ data })
  }
}

class FakeNode {
  readonly port = new FakePort()
  onprocessorerror: (() => void) | null = null
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
  readonly options: AudioWorkletNodeOptions
  constructor(options: AudioWorkletNodeOptions) {
    this.options = options
  }
}

const outputTrack = () => ({ kind: 'audio', stop: vi.fn() }) as unknown as MediaStreamTrack

class FakeContext extends EventTarget {
  state: AudioContextState = 'running'
  baseLatency = 0.005
  readonly sources: { track: MediaStreamTrack; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
  readonly output = outputTrack()
  readonly destination = {
    channelCount: 2,
    stream: { getAudioTracks: () => [this.output], getTracks: () => [this.output] },
  }
  audioWorklet: { addModule: ReturnType<typeof vi.fn> } | undefined = {
    addModule: vi.fn(async () => {}),
  }
  readonly createMediaStreamSource = vi.fn((stream: { track: MediaStreamTrack }) => {
    const source = { track: stream.track, connect: vi.fn(), disconnect: vi.fn() }
    this.sources.push(source)
    return source
  })
  readonly createMediaStreamDestination = vi.fn(() => this.destination)
  readonly resume = vi.fn(async () => {
    this.setState('running')
  })
  readonly close = vi.fn(async () => {
    this.state = 'closed'
  })
  setState(state: AudioContextState) {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

function fakeEnv(answer: unknown = { type: 'ready', sampleRate: 48_000, preciseClock: false }) {
  const context = new FakeContext()
  const nodes: FakeNode[] = []
  const gestures = new EventTarget()
  const fetched: string[] = []
  const env: NoiseSuppressionEnv = {
    createContext: () => context as unknown as AudioContext,
    createNode: (_context, options) => {
      const node = new FakeNode(options)
      nodes.push(node)
      if (answer) queueMicrotask(() => node.port.emit(answer))
      return node as unknown as AudioWorkletNode
    },
    stream: (track) => ({ track }) as unknown as MediaStream,
    fetchWasm: async (url) => {
      fetched.push(url)
      return new ArrayBuffer(8)
    },
    simd: () => true,
    gestures,
  }
  return { env, context, nodes, gestures, fetched }
}

const ASSETS = { worklet: '/assets/w.js', wasm: '/assets/r.wasm', wasmSimd: '/assets/rs.wasm' }
const micTrack = (id = 'mic') => ({ kind: 'audio', id }) as unknown as MediaStreamTrack

describe('the noise suppression pipeline (e6-t02)', () => {
  it('wires the microphone → RNNoise worklet → a stream destination, mono, from our assets', async () => {
    const t = fakeEnv()
    const mic = micTrack()
    const pipeline = await startNoiseSuppression(mic, ASSETS, t.env)
    expect(t.context.audioWorklet!.addModule).toHaveBeenCalledWith('/assets/w.js')
    expect(t.fetched).toEqual(['/assets/rs.wasm'])
    const [node] = t.nodes
    expect(node.options).toMatchObject({
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    })
    expect(node.options.processorOptions.wasm).toBeInstanceOf(ArrayBuffer)
    expect(node.connect).toHaveBeenCalledWith(t.context.destination)
    expect(t.context.destination.channelCount).toBe(1)
    expect(t.context.sources[0].track).toBe(mic)
    expect(t.context.sources[0].connect).toHaveBeenCalledWith(node)
    expect(pipeline.track).toBe(t.context.output)
    expect(pipeline.running()).toBe(true)
    // The framing's delay plus the context's own: within the 10–20 ms the batch allows
    expect(pipeline.latencyMs).toBeCloseTo((FRAMER_DELAY / 48) + 5, 5)
    expect(pipeline.latencyMs).toBeLessThan(20)
    expect(PROCESSOR_NAME).toBe('longtalk-rnnoise')
  })

  it('takes the plain wasm without SIMD', async () => {
    const t = fakeEnv()
    t.env.simd = () => false
    await startNoiseSuppression(null, ASSETS, t.env)
    expect(t.fetched).toEqual(['/assets/r.wasm'])
  })

  it('swaps the microphone under it, keeping the same output track', async () => {
    const t = fakeEnv()
    const pipeline = await startNoiseSuppression(micTrack('a'), ASSETS, t.env)
    const before = pipeline.track
    pipeline.setInput(micTrack('b'))
    expect(t.context.sources[0].disconnect).toHaveBeenCalled()
    expect(t.context.sources[1].track).toMatchObject({ id: 'b' })
    pipeline.setInput(null)
    expect(t.context.sources[1].disconnect).toHaveBeenCalled()
    expect(t.context.sources).toHaveLength(2)
    expect(pipeline.track).toBe(before)
  })

  it('passes the worklet’s load reports on', async () => {
    const t = fakeEnv()
    const pipeline = await startNoiseSuppression(null, ASSETS, t.env)
    const events: NoiseEvent[] = []
    pipeline.subscribe((event) => events.push(event))
    t.nodes[0].port.emit({ type: 'load', load: 0.02, maxMs: 0.4, frames: 100 })
    expect(events).toEqual([{ type: 'load', report: { load: 0.02, maxMs: 0.4 } }])
  })

  it('fails, releasing everything, when the worklet cannot load RNNoise', async () => {
    const t = fakeEnv({ type: 'error', message: 'sampleRate 44100' })
    await expect(startNoiseSuppression(micTrack(), ASSETS, t.env)).rejects.toBeInstanceOf(
      NoiseSuppressionError,
    )
    expect(t.context.close).toHaveBeenCalled()
  })

  it('fails without an AudioWorklet, and when the worklet never answers', async () => {
    const t = fakeEnv()
    t.context.audioWorklet = undefined
    await expect(startNoiseSuppression(null, ASSETS, t.env)).rejects.toBeInstanceOf(
      NoiseSuppressionError,
    )
    const silent = fakeEnv(null)
    await expect(startNoiseSuppression(null, ASSETS, silent.env, 10)).rejects.toThrow('timeout')
    expect(silent.context.close).toHaveBeenCalled()
  })

  it('fails when the microphone will not connect (Firefox at another sample rate)', async () => {
    const t = fakeEnv()
    t.context.createMediaStreamSource.mockImplementationOnce(() => {
      throw new Error('NotSupportedError')
    })
    await expect(startNoiseSuppression(micTrack(), ASSETS, t.env)).rejects.toBeInstanceOf(
      NoiseSuppressionError,
    )
  })

  it('is not running while the context is suspended, and a tap resumes it', async () => {
    const t = fakeEnv()
    t.context.state = 'suspended'
    t.context.resume.mockImplementation(async () => {})
    const pipeline = await startNoiseSuppression(null, ASSETS, t.env)
    expect(pipeline.running()).toBe(false)
    t.context.resume.mockImplementation(async () => t.context.setState('running'))
    t.gestures.dispatchEvent(new Event('pointerdown'))
    await waitFor(() => expect(pipeline.running()).toBe(true))
    await pipeline.close()
    expect(pipeline.running()).toBe(false)
    expect(t.nodes[0].port.postMessage).toHaveBeenCalledWith('close')
    expect(t.context.output.stop).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------
// The room's hook: what is sent, and the CPU threshold

function fakePipeline(running = true) {
  const listeners = new Set<(event: NoiseEvent) => void>()
  let isRunning = running
  const inputs: (MediaStreamTrack | null)[] = []
  const pipeline: NoiseSuppressor & {
    emit: (event: NoiseEvent) => void
    setRunning: (on: boolean) => void
    inputs: typeof inputs
  } = {
    track: { kind: 'audio', id: 'rnnoise' } as unknown as MediaStreamTrack,
    latencyMs: 14,
    running: () => isRunning,
    setInput: (track) => inputs.push(track),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: vi.fn(async () => {}),
    emit: (event) => listeners.forEach((listener) => listener(event)),
    setRunning: (on) => {
      isRunning = on
      listeners.forEach((listener) => listener({ type: 'state' }))
    },
    inputs,
  }
  return pipeline
}

describe('useNoiseSuppression (e6-t02)', () => {
  it('loads only when turned on; sends RNNoise’s track once it runs', async () => {
    const pipeline = fakePipeline()
    const start = vi.fn<StartNoiseSuppression>(async () => pipeline)
    const load = vi.fn(async () => start)
    const mic = micTrack()
    const onStop = vi.fn()
    const { result, rerender } = renderHook(
      ({ on }) => useNoiseSuppression({ mic, on, onStop, load }),
      { initialProps: { on: false } },
    )
    expect(result.current).toMatchObject({ track: null, status: 'off' })
    expect(load).not.toHaveBeenCalled()
    rerender({ on: true })
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('on'))
    expect(result.current.track).toBe(pipeline.track)
    expect(pipeline.inputs).toEqual([mic])
    // The context stops (a phone call): the microphone itself is sent meanwhile
    act(() => pipeline.setRunning(false))
    expect(result.current).toMatchObject({ track: null, status: 'paused' })
    act(() => pipeline.setRunning(true))
    expect(result.current.track).toBe(pipeline.track)
    // Off: the pipeline goes, the microphone is sent again
    rerender({ on: false })
    expect(result.current).toMatchObject({ track: null, status: 'off' })
    expect(pipeline.close).toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('gives the pipeline every new microphone (a switch, a reopening)', async () => {
    const pipeline = fakePipeline()
    const load = async () => async () => pipeline
    const first = micTrack('1')
    const { result, rerender } = renderHook(
      ({ mic }) => useNoiseSuppression({ mic, on: true, onStop: () => {}, load }),
      { initialProps: { mic: first } },
    )
    await waitFor(() => expect(result.current.status).toBe('on'))
    const second = micTrack('2')
    rerender({ mic: second })
    expect(pipeline.inputs).toEqual([first, second])
    expect(result.current.track).toBe(pipeline.track)
  })

  it('stops after OVERLOAD_SECONDS over the CPU threshold, and reports the load meanwhile', async () => {
    const pipeline = fakePipeline()
    const onStop = vi.fn()
    const { result } = renderHook(() =>
      useNoiseSuppression({ mic: micTrack(), on: true, onStop, load: async () => async () => pipeline }),
    )
    await waitFor(() => expect(result.current.status).toBe('on'))
    const busy = { load: LOAD_LIMIT * 2, maxMs: 1 }
    for (let i = 0; i < OVERLOAD_SECONDS - 1; i++) {
      act(() => pipeline.emit({ type: 'load', report: busy }))
    }
    expect(onStop).not.toHaveBeenCalled()
    expect(result.current.load.get()).toEqual({ ...busy, latencyMs: 14 })
    act(() => pipeline.emit({ type: 'load', report: busy }))
    expect(onStop).toHaveBeenCalledWith('overloaded')
  })

  it('says it failed when it cannot start, or the worklet breaks', async () => {
    const onStop = vi.fn()
    renderHook(() =>
      useNoiseSuppression({
        mic: null,
        on: true,
        onStop,
        load: async () => async () => {
          throw new NoiseSuppressionError('no AudioWorklet')
        },
      }),
    )
    await waitFor(() => expect(onStop).toHaveBeenCalledWith('failed'))
    const pipeline = fakePipeline()
    const broken = vi.fn()
    const { result } = renderHook(() =>
      useNoiseSuppression({ mic: null, on: true, onStop: broken, load: async () => async () => pipeline }),
    )
    await waitFor(() => expect(result.current.status).toBe('on'))
    act(() => pipeline.emit({ type: 'error' }))
    expect(broken).toHaveBeenCalledWith('failed')
  })
})

// ---------------------------------------------------------------------------------------------
// 省電模式 in RoomMedia

const fakeTrack = (kind: 'audio' | 'video') =>
  ({
    kind,
    applyConstraints: vi.fn(async () => {}),
    getConstraints: () => ({ width: { ideal: 1280 }, height: { ideal: 720 } }),
  }) as unknown as MediaStreamTrack & { applyConstraints: ReturnType<typeof vi.fn> }

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const DEBOUNCE = 20

function listed(sent: ClientMessage[]): MemberTrack[] {
  const last = sent.filter((s) => s.t === 'tracks').at(-1)
  if (last?.t !== 'tracks') return []
  return last.tracks.map((t) => ({ sessionId: last.sessionId, ...t }))
}

const big: VideoDemand = { width: 1280, height: 720, visible: true, aspect: 16 / 9 }

describe('RoomMedia: 省電模式 (e6-t05)', () => {
  it('asks for every received video’s lowest layer, and back to what the tiles need', async () => {
    const sfu = new FakeSfu()
    const aliceSent: ClientMessage[] = []
    const alice = new RoomMedia({ transport: sfu.createTransport(), send: (m) => aliceSent.push(m) })
    const cam = fakeTrack('video')
    const screenTrack = fakeTrack('video')
    await alice.start({ mic: fakeTrack('audio'), cam })
    await alice.setScreen(screenTrack)
    const demand = new VideoDemandStore()
    const bobTransport = sfu.createTransport()
    const bob = new RoomMedia({
      transport: bobTransport,
      send: () => {},
      demand,
      layerDebounceMs: DEBOUNCE,
    })
    await bob.start({ mic: null, cam: null })
    bob.setDesired(listed(aliceSent))
    await settle()
    const keys = Object.keys(bob.getState().received)
    const camKey = keys.find((k) => k.includes('/cam-'))!
    const screenKey = keys.find((k) => k.includes('/screen-'))!
    // The share big, the camera a grid tile: above their lowest layers
    const tile = { ...big, width: 640, height: 360 }
    const camView = {}
    const screenView = {}
    demand.report(bob.getState().received[camKey].track, camView, tile)
    demand.report(bob.getState().received[screenKey].track, screenView, { ...big, width: 1920, height: 1080 })
    await settle(DEBOUNCE * 3)
    expect(bobTransport.preferredLayers.get(camKey)).toBe('medium')
    expect(bobTransport.preferredLayers.get(screenKey)).toBe('high')

    await bob.setPowerSaving(true)
    expect(bob.getState().powerSaving).toBe(true)
    expect(bobTransport.preferredLayers.get(camKey)).toBe('low')
    // The screen's lowest is its half-size layer
    expect(bobTransport.preferredLayers.get(screenKey)).toBe('medium')
    // A layout change meanwhile keeps them there
    demand.report(bob.getState().received[camKey].track, camView, { ...tile, width: 641 })
    await settle(DEBOUNCE * 3)
    expect(bobTransport.preferredLayers.get(camKey)).toBe('low')

    await bob.setPowerSaving(false)
    expect(bobTransport.preferredLayers.get(screenKey)).toBe('high')
    // Stepping back up needs headroom like any upgrade (layers.ts UPGRADE_HEADROOM): next to the
    // share's 2.5 Mbps the camera's 360p does not fit yet; alone, it comes back at once
    expect(bobTransport.preferredLayers.get(camKey)).toBe('low')
    demand.report(bob.getState().received[screenKey].track, screenView, { ...big, visible: false })
    await settle(DEBOUNCE * 3)
    expect(bobTransport.preferredLayers.get(camKey)).toBe('medium')
    await alice.close()
    await bob.close()
  })

  it('never sends HD and captures the camera at 15 fps; restores both after', async () => {
    const sfu = new FakeSfu()
    const transport = sfu.createTransport()
    const alice = new RoomMedia({ transport, send: () => {} })
    const cam = fakeTrack('video')
    await alice.start({ mic: null, cam })
    const name = alice.getState().published.find((t) => t.kind === 'cam')!.trackName
    expect(transport.topLayers.get(name)).toBe('high')

    await alice.setPowerSaving(true)
    expect(transport.topLayers.get(name)).toBe('medium')
    expect(cam.applyConstraints).toHaveBeenLastCalledWith({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { max: POWER_SAVING_FPS },
    })
    // A camera switched to meanwhile is capped too
    const other = fakeTrack('video')
    await alice.setLocal({ mic: null, cam: other })
    expect(other.applyConstraints).toHaveBeenLastCalledWith(
      expect.objectContaining({ frameRate: { max: POWER_SAVING_FPS } }),
    )
    // HD stays wanted: off again, it is sent again
    expect(alice.getState().hd).toBe(true)
    await alice.setPowerSaving(false)
    expect(transport.topLayers.get(name)).toBe('high')
    expect(other.applyConstraints).toHaveBeenLastCalledWith({
      width: { ideal: 1280 },
      height: { ideal: 720 },
    })
    await alice.close()
  })

  it('starts in it when asked to', async () => {
    const sfu = new FakeSfu()
    const transport = sfu.createTransport()
    const alice = new RoomMedia({ transport, send: () => {}, powerSaving: true })
    await alice.start({ mic: null, cam: fakeTrack('video') })
    const name = alice.getState().published.find((t) => t.kind === 'cam')!.trackName
    expect(transport.topLayers.get(name)).toBe('medium')
    await alice.close()
  })

  it('capFrameRate keeps the other constraints, and survives a refusal', async () => {
    const track = fakeTrack('video')
    expect(await capFrameRate(track, 15)).toBe(true)
    track.applyConstraints.mockRejectedValueOnce(new Error('OverconstrainedError'))
    expect(await capFrameRate(track, null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// The settings panel

function settings(overrides: Partial<SettingsDialogProps> = {}) {
  const props: SettingsDialogProps = {
    phone: false,
    onClose: vi.fn(),
    devices: { audioinput: [], videoinput: [], audiooutput: [] },
    selected: { mic: null, cam: null, speaker: null },
    onSelect: vi.fn(),
    speakerSupported: false,
    processing: DEFAULT_PROCESSING,
    processingSupported: ['noiseSuppression', 'echoCancellation', 'autoGainControl'],
    onProcessing: vi.fn(),
    hd: true,
    onHd: vi.fn(),
    audioOnly: false,
    onAudioOnly: vi.fn(),
    advancedNoiseSupported: true,
    advancedNoise: false,
    onAdvancedNoise: vi.fn(),
    powerSaving: false,
    onPowerSaving: vi.fn(),
    ...overrides,
  }
  render(<SettingsDialog {...props} />)
  return props
}

const browserNs = () => screen.getByRole('switch', { name: '噪音抑制' })

describe('the settings panel (H4)', () => {
  it('音訊 has 進階噪音抑制, off by default; on, the browser’s own pauses', () => {
    const props = settings()
    const advanced = screen.getByRole('switch', { name: '進階噪音抑制' })
    expect(advanced).not.toBeChecked()
    expect(browserNs()).toBeEnabled()
    fireEvent.click(advanced)
    expect(props.onAdvancedNoise).toHaveBeenCalledWith(true)
  })

  it('pauses the browser’s noise suppression switch while it runs, and says why', () => {
    settings({ advancedNoise: true, advancedNoiseNote: '正在載入進階噪音抑制…' })
    expect(browserNs()).toBeDisabled()
    expect(browserNs()).toHaveAccessibleDescription(/由它處理噪音/)
    expect(screen.getByText('正在載入進階噪音抑制…')).toBeInTheDocument()
  })

  it('is not there where the browser cannot run it', () => {
    settings({ advancedNoiseSupported: false })
    expect(screen.queryByRole('switch', { name: '進階噪音抑制' })).toBeNull()
    expect(browserNs()).toBeEnabled()
  })

  it('效能 has 省電模式; with it on, HD and the advanced suppression say they are held off', () => {
    const props = settings({ advancedNoise: true, powerSaving: true })
    expect(screen.getByText('省電模式開著，進階噪音抑制暫停。')).toBeInTheDocument()
    // Held off: the browser's own is back
    expect(browserNs()).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: '視訊' }))
    expect(screen.getByText('省電模式開著，不送 HD。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '效能' }))
    const panel = screen.getByRole('tabpanel', { name: '效能' })
    const power = within(panel).getByRole('switch', { name: '省電模式' })
    expect(power).toBeChecked()
    fireEvent.click(power)
    expect(props.onPowerSaving).toHaveBeenCalledWith(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Motion and the battery

describe('省電模式 turns motion off (e6-t05)', () => {
  it('useReducedMotion follows MotionOffContext as well as the system', () => {
    const off = renderHook(() => useReducedMotion())
    expect(off.result.current).toBe(false)
    const on = renderHook(() => [useReducedMotion(), useContext(MotionOffContext)], {
      wrapper: ({ children }) => (
        <MotionOffContext.Provider value={true}>{children}</MotionOffContext.Provider>
      ),
    })
    expect(on.result.current).toEqual([true, true])
  })
})

class FakeBattery extends EventTarget {
  level = 0.5
  charging = false
  set(level: number, charging = false) {
    this.level = level
    this.charging = charging
    this.dispatchEvent(new Event('levelchange'))
  }
}

describe('the low-battery hint (e6-t05)', () => {
  it('suggests 省電模式 once when the battery runs low and is not charging', async () => {
    expect(batteryLow({ level: 0.2, charging: false })).toBe(true)
    expect(batteryLow({ level: 0.1, charging: true })).toBe(false)
    const battery = new FakeBattery()
    const suggest = vi.fn()
    const getBattery = () => Promise.resolve(battery)
    renderHook(() => useBatteryHint(true, suggest, getBattery))
    await settle()
    expect(suggest).not.toHaveBeenCalled()
    act(() => battery.set(0.15))
    expect(suggest).toHaveBeenCalledTimes(1)
    act(() => battery.set(0.1))
    expect(suggest).toHaveBeenCalledTimes(1)
  })

  it('says nothing while 省電模式 is on, or where there is no battery API', async () => {
    const battery = new FakeBattery()
    battery.level = 0.05
    const suggest = vi.fn()
    const getBattery = () => Promise.resolve(battery)
    renderHook(() => useBatteryHint(false, suggest, getBattery))
    await settle()
    expect(suggest).not.toHaveBeenCalled()
    const none = () => null
    renderHook(() => useBatteryHint(true, suggest, none))
    await settle()
    expect(suggest).not.toHaveBeenCalled()
  })
})

// The advanced noise suppression's pipeline on the page (e6-t02, AC-6.2; ADR-001 「進階噪音抑制」):
// the microphone's track → an AudioContext at 48 kHz → the RNNoise AudioWorklet
// (rnnoise.worklet.ts) → a MediaStreamDestination, whose track is what the room sends instead
// of the microphone (RoomMedia.setLocal → MediaTransport.replaceTrack: no renegotiation).
//
// - Loaded lazily (useNoiseSuppression.ts imports this and noiseAssets.ts only when it is turned
//   on); the wasm is fetched from our own assets and handed to the worklet, which compiles it.
// - `setInput` swaps the microphone under it (a device switch, the microphone opened again for
//   new processing switches) while the output track stays the same, so the sender is not
//   touched. A muted microphone (track.enabled = false) gives silence; the room sends null for
//   it anyway.
// - The output only carries sound while the context runs: a context made without a user gesture
//   (a reload straight back into the room) starts suspended, and Safari suspends one on a phone
//   call. `running` says so, and the page sends the plain microphone meanwhile. The next tap or
//   key press resumes it.
// - Added delay: the framing's 448 samples (9.3 ms, rnnoiseCore.ts) plus the context's own
//   baseLatency (a few ms), reported as `latencyMs`.
// No React and no interface text here.
import { PROCESSOR_NAME, RNNOISE_SAMPLE_RATE, FRAMER_DELAY, type WorkletMessage } from './rnnoiseCore.ts'
import type { LoadReport } from './noiseLoad.ts'

export interface NoiseAssets {
  worklet: string
  wasm: string
  wasmSimd: string
}

/** What the pipeline needs from the browser; the tests pass fakes */
export interface NoiseSuppressionEnv {
  createContext: () => AudioContext
  createNode: (context: AudioContext, options: AudioWorkletNodeOptions) => AudioWorkletNode
  stream: (track: MediaStreamTrack) => MediaStream
  fetchWasm: (url: string) => Promise<ArrayBuffer>
  /** WebAssembly SIMD (the faster build) */
  simd: () => boolean
  /** Where a tap or key press resumes a suspended context; null: nowhere */
  gestures: EventTarget | null
}

export type NoiseEvent =
  | { type: 'load'; report: LoadReport }
  /** The context started or stopped running (`running` changed) */
  | { type: 'state' }
  /** The worklet failed while running (processorerror): the pipeline is no use any more */
  | { type: 'error' }

export interface NoiseSuppressor {
  /** What to send instead of the microphone, while `running()` */
  readonly track: MediaStreamTrack
  /** Delay added to the microphone, ms */
  readonly latencyMs: number
  running(): boolean
  setInput(track: MediaStreamTrack | null): void
  subscribe(listener: (event: NoiseEvent) => void): () => void
  close(): Promise<void>
}

export class NoiseSuppressionError extends Error {}

/** How long the worklet may take to load the wasm */
export const READY_TIMEOUT_MS = 8_000

// A module using a SIMD instruction (wasm-feature-detect's test)
const SIMD_TEST = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
])

export function browserNoiseEnv(): NoiseSuppressionEnv {
  return {
    createContext: () =>
      new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE, latencyHint: 'interactive' }),
    createNode: (context, options) => new AudioWorkletNode(context, PROCESSOR_NAME, options),
    stream: (track) => new MediaStream([track]),
    fetchWasm: async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new NoiseSuppressionError(`wasm ${response.status}`)
      return response.arrayBuffer()
    },
    simd: () => {
      try {
        return WebAssembly.validate(SIMD_TEST)
      } catch {
        return false
      }
    },
    gestures: typeof window === 'undefined' ? null : window,
  }
}

/**
 * Builds the pipeline on `input` and resolves once RNNoise is ready in the worklet; rejects
 * (NoiseSuppressionError) when anything is missing or fails, having released what it made.
 */
export async function startNoiseSuppression(
  input: MediaStreamTrack | null,
  assets: NoiseAssets,
  env: NoiseSuppressionEnv = browserNoiseEnv(),
  readyTimeoutMs: number = READY_TIMEOUT_MS,
): Promise<NoiseSuppressor> {
  let context: AudioContext
  try {
    context = env.createContext()
  } catch (error) {
    throw new NoiseSuppressionError(String(error))
  }
  const listeners = new Set<(event: NoiseEvent) => void>()
  const emit = (event: NoiseEvent) => listeners.forEach((listener) => listener(event))
  let node: AudioWorkletNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let destination: MediaStreamAudioDestinationNode | null = null
  let closed = false
  const resume = () => {
    if (context.state !== 'running' && context.state !== 'closed') void context.resume().catch(() => {})
  }
  const GESTURES = ['pointerdown', 'keydown'] as const
  const stopGestures = () => GESTURES.forEach((type) => env.gestures?.removeEventListener(type, resume))
  const close = async () => {
    if (closed) return
    closed = true
    stopGestures()
    context.removeEventListener('statechange', onState)
    try {
      source?.disconnect()
      node?.port.postMessage('close')
      node?.disconnect()
    } catch {
      // Already disconnected
    }
    destination?.stream.getTracks().forEach((track) => track.stop())
    await context.close().catch(() => {})
  }
  const onState = () => {
    if (closed) return
    if (context.state === 'running') stopGestures()
    else GESTURES.forEach((type) => env.gestures?.addEventListener(type, resume))
    emit({ type: 'state' })
  }
  try {
    if (!context.audioWorklet) throw new NoiseSuppressionError('no AudioWorklet')
    const [, wasm] = await Promise.all([
      context.audioWorklet.addModule(assets.worklet),
      env.fetchWasm(env.simd() ? assets.wasmSimd : assets.wasm),
    ])
    const created = env.createNode(context, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [1],
      processorOptions: { wasm },
    })
    node = created
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new NoiseSuppressionError('worklet timeout')),
        readyTimeoutMs,
      )
      created.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
        const message = event.data
        if (message.type === 'ready') {
          clearTimeout(timer)
          resolve()
        } else if (message.type === 'error') {
          clearTimeout(timer)
          reject(new NoiseSuppressionError(message.message))
        } else if (message.type === 'load') {
          emit({ type: 'load', report: { load: message.load, maxMs: message.maxMs } })
        }
      }
      created.onprocessorerror = () => {
        clearTimeout(timer)
        reject(new NoiseSuppressionError('processor error'))
        emit({ type: 'error' })
      }
    })
    destination = context.createMediaStreamDestination()
    destination.channelCount = 1
    created.connect(destination)
  } catch (error) {
    await close()
    throw error instanceof NoiseSuppressionError ? error : new NoiseSuppressionError(String(error))
  }
  const output = destination.stream.getAudioTracks()[0]
  if (!output) {
    await close()
    throw new NoiseSuppressionError('no output track')
  }
  const worklet = node
  const setInput = (track: MediaStreamTrack | null) => {
    if (closed) return
    source?.disconnect()
    source = null
    if (!track) return
    // Firefox refuses a microphone at another rate than the context's: that is a failure here
    source = context.createMediaStreamSource(env.stream(track))
    source.connect(worklet)
  }
  try {
    setInput(input)
  } catch (error) {
    await close()
    throw new NoiseSuppressionError(String(error))
  }
  context.addEventListener('statechange', onState)
  onState()
  resume()
  const baseLatency = typeof context.baseLatency === 'number' ? context.baseLatency : 0
  return {
    track: output,
    latencyMs: (FRAMER_DELAY / RNNOISE_SAMPLE_RATE) * 1000 + baseLatency * 1000,
    running: () => !closed && context.state === 'running',
    setInput,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close,
  }
}

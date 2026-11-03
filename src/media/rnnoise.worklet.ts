// The AudioWorkletProcessor of the advanced noise suppression (e6-t02): runs on the audio thread,
// built on its own by Vite (`?worker&url`, noiseAssets.ts) and loaded with audioWorklet.addModule
// only when the suppression is turned on. The wasm's bytes come in processorOptions (fetched by
// the page from our own assets); RNNoise and the framing are in rnnoiseCore.ts.
//
// Mono in, mono out. Until the wasm is ready it outputs silence (the page sends the microphone
// itself meanwhile). Every second it posts how long the frames took (`load`), which the page
// watches (noiseLoad.ts).
import {
  createRnnoise,
  Framer,
  LoadMeter,
  PROCESSOR_NAME,
  RNNOISE_SAMPLE_RATE,
  type Rnnoise,
  type WorkletMessage,
} from './rnnoiseCore.ts'

// AudioWorkletGlobalScope: not in TypeScript's DOM library
declare const sampleRate: number
declare function registerProcessor(name: string, processor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

interface Options {
  processorOptions?: { wasm?: ArrayBuffer }
}

const clock = (globalThis as { performance?: { now(): number } }).performance
const now = clock && typeof clock.now === 'function' ? () => clock.now() : () => Date.now()

class RnnoiseProcessor extends AudioWorkletProcessor {
  private rnnoise: Rnnoise | null = null
  private framer: Framer | null = null
  private readonly meter = new LoadMeter(sampleRate)
  private closed = false

  constructor(options: Options) {
    super()
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data === 'close') this.close()
    }
    const wasm = options.processorOptions?.wasm
    if (!wasm || sampleRate !== RNNOISE_SAMPLE_RATE) {
      this.post({ type: 'error', message: wasm ? `sampleRate ${sampleRate}` : 'no wasm' })
      return
    }
    createRnnoise(wasm).then(
      (rnnoise) => {
        if (this.closed) {
          rnnoise.destroy()
          return
        }
        this.rnnoise = rnnoise
        this.framer = new Framer((frame) => {
          const start = now()
          rnnoise.process(frame)
          const report = this.meter.add(now() - start)
          if (report) this.post({ type: 'load', ...report })
        })
        this.post({ type: 'ready', sampleRate, preciseClock: clock !== undefined })
      },
      (error: unknown) => this.post({ type: 'error', message: String(error) }),
    )
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.closed) return false
    const output = outputs[0]?.[0]
    if (!output) return true
    if (!this.framer) {
      output.fill(0)
      return true
    }
    const input = inputs[0]?.[0]
    this.framer.push(input && input.length === output.length ? input : null, output)
    return true
  }

  private post(message: WorkletMessage): void {
    this.port.postMessage(message)
  }

  private close(): void {
    this.closed = true
    this.rnnoise?.destroy()
    this.rnnoise = null
    this.framer = null
  }
}

registerProcessor(PROCESSOR_NAME, RnnoiseProcessor)

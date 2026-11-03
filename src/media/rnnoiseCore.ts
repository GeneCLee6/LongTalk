// The RNNoise side of the advanced noise suppression (e6-t02, AC-6.2; ADR-001 「進階噪音抑制」):
// what runs inside the AudioWorklet (rnnoise.worklet.ts), kept free of the worklet's globals so
// the tests run it in Node against the real wasm.
//
// - The wasm is xiph/rnnoise compiled by shiguredo/rnnoise-wasm, as shipped in
//   @sapphi-red/web-noise-suppressor (THIRD_PARTY_NOTICES.md). Its emscripten glue is not used:
//   the module only imports three functions (copy within memory, grow memory, assert), given
//   here, so the worklet needs no other script.
// - RNNoise works on 480-sample frames at 48 kHz (10 ms), as floats on the 16-bit scale; the
//   audio thread hands over 128-sample render quanta. `Framer` collects 480, processes them, and
//   plays them out FRAMER_DELAY samples later: 448 (9.3 ms) is the smallest delay that never runs
//   dry (the largest 128·k mod 480 over the 15 quanta before the pattern repeats).
// - `LoadMeter` adds up how long the frames took against the audio they hold, so the page can
//   turn the suppression off on a computer too slow for it (noiseLoad.ts).
// No DOM, no React and no interface text here.

/** The AudioWorkletProcessor's registered name */
export const PROCESSOR_NAME = 'longtalk-rnnoise'
/** RNNoise's frame: 10 ms at 48 kHz */
export const RNNOISE_FRAME = 480
export const RNNOISE_SAMPLE_RATE = 48_000
/** The Web Audio render quantum */
export const QUANTUM = 128
/** Output delay in samples: the least that never underruns with 128-sample quanta (9.3 ms) */
export const FRAMER_DELAY = 448
/** Frames per load report: one second of audio */
export const REPORT_FRAMES = 100
/** RNNoise's float scale (it was trained on 16-bit samples) */
const SCALE = 32_768

/** What the worklet tells the page */
export type WorkletMessage =
  | { type: 'ready'; sampleRate: number; preciseClock: boolean }
  | { type: 'error'; message: string }
  /** Every REPORT_FRAMES frames: the share of real time spent processing, the slowest frame */
  | { type: 'load'; load: number; maxMs: number; frames: number }

interface RnnoiseExports {
  memory: WebAssembly.Memory
  malloc(size: number): number
  free(pointer: number): void
  rnnoise_create(model: number): number
  rnnoise_destroy(state: number): void
  rnnoise_get_frame_size(): number
  rnnoise_process_frame(state: number, out: number, input: number): number
  __wasm_call_ctors?: () => void
  emscripten_stack_init?: () => void
}

/** One RNNoise denoiser on its own wasm instance */
export interface Rnnoise {
  /** Denoises a 480-sample frame of floats in -1..1, in place; returns the voice probability */
  process(frame: Float32Array): number
  destroy(): void
}

/** Instantiates the wasm (its bytes, or a compiled module) and creates a denoiser */
export async function createRnnoise(source: BufferSource | WebAssembly.Module): Promise<Rnnoise> {
  let memory: WebAssembly.Memory | null = null
  const imports = {
    env: {
      emscripten_memcpy_big: (dest: number, src: number, count: number) => {
        if (memory) new Uint8Array(memory.buffer).copyWithin(dest, src, src + count)
      },
      emscripten_resize_heap: (requested: number) => {
        if (!memory) return 0
        const pages = Math.ceil((requested - memory.buffer.byteLength) / 65_536)
        try {
          if (pages > 0) memory.grow(pages)
          return 1
        } catch {
          return 0
        }
      },
      __assert_fail: () => {
        throw new Error('rnnoise: assertion failed')
      },
    },
  }
  const instance =
    source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, imports)
      : (await WebAssembly.instantiate(source, imports)).instance
  const wasm = instance.exports as unknown as RnnoiseExports
  memory = wasm.memory
  wasm.emscripten_stack_init?.()
  wasm.__wasm_call_ctors?.()
  const size = wasm.rnnoise_get_frame_size()
  if (size !== RNNOISE_FRAME) throw new Error(`rnnoise: frame size ${size}`)
  const state = wasm.rnnoise_create(0)
  const input = wasm.malloc(RNNOISE_FRAME * 4)
  const output = wasm.malloc(RNNOISE_FRAME * 4)
  if (!state || !input || !output) throw new Error('rnnoise: out of memory')
  let destroyed = false
  return {
    process(frame) {
      if (destroyed) return 0
      // A view per call: growing the memory detaches the old buffer
      const heap = new Float32Array(wasm.memory.buffer)
      const at = input >> 2
      for (let i = 0; i < RNNOISE_FRAME; i++) heap[at + i] = frame[i] * SCALE
      const voice = wasm.rnnoise_process_frame(state, output, input)
      const out = new Float32Array(wasm.memory.buffer, output, RNNOISE_FRAME)
      for (let i = 0; i < RNNOISE_FRAME; i++) frame[i] = out[i] / SCALE
      return voice
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      wasm.rnnoise_destroy(state)
      wasm.free(input)
      wasm.free(output)
    },
  }
}

/**
 * Turns render quanta into RNNoise frames and back: `push` takes a quantum in and gives the
 * quantum FRAMER_DELAY samples older out. Each full frame goes through `processFrame` in place.
 */
export class Framer {
  private readonly frame = new Float32Array(RNNOISE_FRAME)
  private filled = 0
  /** Processed samples waiting to go out: a ring, FRAMER_DELAY of silence to start with */
  private readonly ring = new Float32Array(2048)
  private read = 0
  private write = FRAMER_DELAY
  private readonly processFrame: (frame: Float32Array) => void

  constructor(processFrame: (frame: Float32Array) => void) {
    this.processFrame = processFrame
  }

  /** How many processed samples wait to go out */
  get queued(): number {
    return (this.write - this.read + this.ring.length) % this.ring.length
  }

  /** One quantum in (null: silence) and one out, of the same length */
  push(input: Float32Array | null, output: Float32Array): void {
    const n = output.length
    const mask = this.ring.length - 1
    for (let i = 0; i < n; i++) {
      this.frame[this.filled++] = input ? input[i] : 0
      if (this.filled === RNNOISE_FRAME) {
        this.processFrame(this.frame)
        for (let j = 0; j < RNNOISE_FRAME; j++) {
          this.ring[this.write] = this.frame[j]
          this.write = (this.write + 1) & mask
        }
        this.filled = 0
      }
    }
    for (let i = 0; i < n; i++) {
      if (this.read === this.write) {
        // Never with 128-sample quanta (FRAMER_DELAY); silence rather than old samples
        output[i] = 0
        continue
      }
      output[i] = this.ring[this.read]
      this.read = (this.read + 1) & mask
    }
  }
}

/** Adds up processing time per frame and reports every REPORT_FRAMES frames */
export class LoadMeter {
  private busyMs = 0
  private maxMs = 0
  private frames = 0
  private readonly frameMs: number

  constructor(sampleRate: number = RNNOISE_SAMPLE_RATE) {
    this.frameMs = (RNNOISE_FRAME / sampleRate) * 1000
  }

  /** One frame took `ms`; a report once there are REPORT_FRAMES of them */
  add(ms: number): { load: number; maxMs: number; frames: number } | null {
    const spent = Math.max(0, ms)
    this.busyMs += spent
    this.maxMs = Math.max(this.maxMs, spent)
    this.frames += 1
    if (this.frames < REPORT_FRAMES) return null
    const report = {
      load: this.busyMs / (this.frames * this.frameMs),
      maxMs: this.maxMs,
      frames: this.frames,
    }
    this.busyMs = 0
    this.maxMs = 0
    this.frames = 0
    return report
  }
}

import {
  createRnnoise,
  Framer,
  FRAMER_DELAY,
  LoadMeter,
  QUANTUM,
  REPORT_FRAMES,
  RNNOISE_FRAME,
} from '../../../src/media/rnnoiseCore.ts'
import {
  LOAD_LIMIT,
  OVERLOAD_SECONDS,
  OverloadWatch,
  overBudget,
  SPIKE_MS,
} from '../../../src/media/noiseLoad.ts'

// Node's fs without @types/node in this tsconfig: the shipped wasm files, read as bytes
const node = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: string): unknown; cwd(): string }
  }
).process
const fs = node.getBuiltinModule('node:fs') as { readFileSync(path: string): Uint8Array<ArrayBuffer> }
const readWasm = (name: string) =>
  fs.readFileSync(`${node.cwd()}/node_modules/@sapphi-red/web-noise-suppressor/dist/${name}`)

/** Deterministic white noise in -1..1 (mulberry32) */
function noise(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2_147_483_648 - 1
  }
}

const energy = (samples: Float32Array) =>
  Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length)

describe('Framer (e6-t02)', () => {
  it('turns 128-sample quanta into 480-sample frames and never runs dry', () => {
    const sizes: number[] = []
    const framer = new Framer((frame) => sizes.push(frame.length))
    const input = new Float32Array(QUANTUM)
    const output = new Float32Array(QUANTUM)
    let n = 0
    // 3 s of quanta, an increasing ramp: what comes out is what went in FRAMER_DELAY earlier
    for (let q = 0; q < 1125; q++) {
      for (let i = 0; i < QUANTUM; i++) input[i] = ++n
      framer.push(input, output)
      for (let i = 0; i < QUANTUM; i++) {
        const sample = q * QUANTUM + i + 1
        expect(output[i]).toBe(sample > FRAMER_DELAY ? sample - FRAMER_DELAY : 0)
      }
    }
    expect(sizes.every((size) => size === RNNOISE_FRAME)).toBe(true)
    expect(sizes).toHaveLength(Math.floor((1125 * QUANTUM) / RNNOISE_FRAME))
    // 448 samples at 48 kHz: under 10 ms of added delay
    expect((FRAMER_DELAY / 48_000) * 1000).toBeLessThan(10)
  })

  it('needs every sample of its delay: one less would underrun', () => {
    const worst = Math.max(...Array.from({ length: 15 }, (_, k) => ((k + 1) * QUANTUM) % RNNOISE_FRAME))
    expect(FRAMER_DELAY).toBe(worst)
  })

  it('takes silence for a missing input', () => {
    const framer = new Framer(() => {})
    const output = new Float32Array(QUANTUM).fill(9)
    framer.push(null, output)
    expect([...output].every((s) => s === 0)).toBe(true)
  })
})

describe('LoadMeter', () => {
  it('reports the share of real time spent, and the slowest frame, every second', () => {
    const meter = new LoadMeter(48_000)
    let report = null
    for (let i = 0; i < REPORT_FRAMES; i++) report = meter.add(i === 50 ? 3 : 0.5)
    expect(report).not.toBeNull()
    // 99 frames × 0.5 ms + 3 ms over 100 × 10 ms
    expect(report!.load).toBeCloseTo((99 * 0.5 + 3) / 1000, 5)
    expect(report!.maxMs).toBe(3)
    expect(meter.add(1)).toBeNull()
  })
})

describe('OverloadWatch: the CPU threshold (AC-6.2)', () => {
  it('turns off after OVERLOAD_SECONDS over budget in a row, not for one busy second', () => {
    const watch = new OverloadWatch()
    const busy = { load: LOAD_LIMIT + 0.1, maxMs: 1 }
    const calm = { load: 0.02, maxMs: 0.3 }
    for (let i = 0; i < OVERLOAD_SECONDS - 1; i++) expect(watch.push(busy)).toBe(false)
    expect(watch.push(calm)).toBe(false)
    for (let i = 0; i < OVERLOAD_SECONDS - 1; i++) expect(watch.push(busy)).toBe(false)
    expect(watch.push(busy)).toBe(true)
  })

  it('counts a frame slow enough to miss the render quantum', () => {
    expect(overBudget({ load: 0.05, maxMs: SPIKE_MS + 0.1 })).toBe(true)
    expect(overBudget({ load: 0.05, maxMs: 1 })).toBe(false)
  })
})

describe('RNNoise wasm (the shipped build)', () => {
  for (const file of ['rnnoise.wasm', 'rnnoise_simd.wasm']) {
    it(`${file}: instantiates without emscripten's glue and suppresses steady noise`, async () => {
      let rnnoise
      try {
        rnnoise = await createRnnoise(readWasm(file))
      } catch (error) {
        // Node without SIMD cannot compile the SIMD build; the browser picks the other one
        if (file === 'rnnoise_simd.wasm') return
        throw error
      }
      const next = noise(file.length)
      const frame = new Float32Array(RNNOISE_FRAME)
      let before = 0
      let after = 0
      const frames = 300
      const start = performance.now()
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < RNNOISE_FRAME; i++) frame[i] = next() * 0.05
        if (f >= 100) before += energy(frame)
        rnnoise.process(frame)
        if (f >= 100) after += energy(frame)
      }
      const msPerFrame = (performance.now() - start) / frames
      // A steady tone (Chrome's fake microphone is one) is kept: it reads as voice
      let tone = 0
      for (let f = 0; f < 50; f++) {
        for (let i = 0; i < RNNOISE_FRAME; i++) {
          frame[i] = Math.sin((2 * Math.PI * 440 * (f * RNNOISE_FRAME + i)) / 48_000) * 0.2
        }
        rnnoise.process(frame)
        if (f >= 25) tone += energy(frame)
      }
      expect(tone / 25).toBeGreaterThan(0.1)
      rnnoise.destroy()
      // Steady white noise is what RNNoise removes: clearly less of it is left once it adapted
      expect(after).toBeLessThan(before * 0.8)
      // Far under the 10 ms a frame holds (ADR-001 records the numbers)
      expect(msPerFrame).toBeLessThan(5)
    })
  }
})

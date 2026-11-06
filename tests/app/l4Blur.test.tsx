import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BLUR_START_TIMEOUT_MS,
  BlurError,
  MASK_INTERVAL_MS,
  MASK_SIZE,
  startBackgroundBlur,
  type BackgroundBlur,
  type BlurEnv,
  type BlurEvent,
  type BlurToPage,
  type BlurToWorker,
  type CanvasLike,
  type Context2D,
  type DrawFrame,
  type FramePath,
  type PictureCanvas,
  type WorkerLike,
} from '../../src/media/backgroundBlur.ts'
import {
  BLUR_OVER_SECONDS,
  BLUR_WARMUP_SECONDS,
  BlurFpsWatch,
  MIN_BLUR_FPS,
  blurOverBudget,
  cameraToSend,
  type BlurReport,
} from '../../src/media/blurLoad.ts'
import { MASK_BLEND, writeMask } from '../../src/media/blurMask.ts'
import { useBackgroundBlur, type StartBackgroundBlur } from '../../src/room/useBackgroundBlur.ts'

// Node's fs without @types/node in this tsconfig (like tests/app/security.test.ts)
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: string): { readFileSync(p: string, e: 'utf8'): string } }
  }
).process.getBuiltinModule('node:fs')

const track = (id: string) => ({ id, kind: 'video' }) as unknown as MediaStreamTrack

// ---------------------------------------------------------------------------------------------
// The rules

const report = (changes: Partial<BlurReport> = {}): BlurReport => ({
  fps: 30,
  maskFps: 15,
  busy: 0.1,
  maskMs: 12,
  ...changes,
})

describe('when the blur turns itself off (AC-6.5)', () => {
  it('fine at the camera’s rate', () => {
    expect(blurOverBudget(report())).toBe(false)
    expect(blurOverBudget(report({ fps: MIN_BLUR_FPS, maskFps: 8 }))).toBe(false)
  })

  it('under 15 fps because drawing takes the page’s time', () => {
    expect(blurOverBudget(report({ fps: 12, maskFps: 12, busy: 0.6 }))).toBe(true)
  })

  it('masks that cannot keep up, even with a smooth video: the outline trails the person', () => {
    expect(blurOverBudget(report({ fps: 30, maskFps: 3 }))).toBe(true)
    expect(blurOverBudget(report({ fps: 12, maskFps: 5 }))).toBe(true)
  })

  it('a slow camera with the pipeline keeping up stays on: off would win nothing back', () => {
    expect(blurOverBudget(report({ fps: 12, maskFps: 12, busy: 0.05 }))).toBe(false)
    expect(blurOverBudget(report({ fps: 4, maskFps: 4, busy: 0.02 }))).toBe(false)
  })

  it('only after a warm-up and several seconds in a row', () => {
    const watch = new BlurFpsWatch()
    const over = report({ fps: 8, maskFps: 1, busy: 0.7 })
    for (let i = 0; i < BLUR_WARMUP_SECONDS; i++) expect(watch.push(over)).toBe(false)
    for (let i = 0; i < BLUR_OVER_SECONDS - 1; i++) expect(watch.push(over)).toBe(false)
    // A good second starts the count again
    expect(watch.push(report())).toBe(false)
    for (let i = 0; i < BLUR_OVER_SECONDS - 1; i++) expect(watch.push(over)).toBe(false)
    expect(watch.push(over)).toBe(true)
    watch.reset()
    expect(watch.push(over)).toBe(false)
  })
})

describe('what the room sends for the camera', () => {
  const camera = track('camera')
  const blurred = track('blurred')
  const send = (changes: Partial<Parameters<typeof cameraToSend>[0]>) =>
    cameraToSend({
      camera,
      blurWanted: true,
      blurTrack: null,
      rawWhileLoading: false,
      ...changes,
    })

  it('off: the original track; no camera: nothing', () => {
    expect(send({ blurWanted: false, blurTrack: blurred })).toBe(camera)
    expect(send({ camera: null, blurTrack: blurred })).toBeNull()
  })

  it('ready: the blurred track', () => {
    expect(send({ blurTrack: blurred })).toBe(blurred)
    expect(send({ blurTrack: blurred, rawWhileLoading: true })).toBe(blurred)
  })

  it('loading: goes on if it was already out, and otherwise shows nothing yet', () => {
    expect(send({ rawWhileLoading: true })).toBe(camera)
    expect(send({ rawWhileLoading: false })).toBeNull()
  })
})

describe('the mask', () => {
  it('is 0 for the background, 255 for the person, a ramp between', () => {
    const smoothed = new Float32Array(3)
    const rgba = new Uint8ClampedArray(12)
    writeMask([0.1, 0.55, 0.95], smoothed, rgba, true)
    expect(rgba[3]).toBe(0)
    expect(rgba[7]).toBeGreaterThan(100)
    expect(rgba[7]).toBeLessThan(155)
    expect(rgba[11]).toBe(255)
  })

  it('moves part of the way to each new mask', () => {
    const smoothed = new Float32Array([0])
    writeMask([1], smoothed, new Uint8ClampedArray(4), false)
    expect(smoothed[0]).toBeCloseTo(MASK_BLEND)
  })
})

// ---------------------------------------------------------------------------------------------
// The pipeline, on fakes

class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: BlurToPage }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  sent: BlurToWorker[] = []
  terminated = false
  postMessage(message: BlurToWorker) {
    this.sent.push(message)
  }
  terminate() {
    this.terminated = true
  }
  answer(data: BlurToPage) {
    this.onmessage?.({ data })
  }
  pictures = () => this.sent.filter((message) => message.type === 'picture')
}

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap

interface FakeContext extends Context2D {
  calls: { op: string; source: unknown }[]
}

function fakeCanvas(width = 1, height = 1): PictureCanvas & { context: FakeContext } {
  const context: FakeContext = {
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    filter: 'none',
    calls: [],
    drawImage(source) {
      this.calls.push({ op: this.globalCompositeOperation, source })
    },
  }
  return {
    width,
    height,
    context,
    getContext: () => context,
    transferToImageBitmap: bitmap,
  }
}

function fakeEnv(path: 'insertable' | 'canvas' = 'insertable') {
  const worker = new FakeWorker()
  const output = track('output')
  const out = fakeCanvas()
  let now = 1000
  let draw: DrawFrame = () => false
  const inputs: (MediaStreamTrack | null)[] = []
  const pathClosed = vi.fn()
  const timers: (() => void)[] = []
  const env: BlurEnv = {
    path,
    createWorker: () => worker,
    createPicture: (width, height) => fakeCanvas(width, height),
    createPath: (_, given): FramePath => {
      draw = given
      return {
        output,
        canvas: out as CanvasLike,
        setInput: (camera) => inputs.push(camera),
        close: pathClosed,
        ...(path === 'canvas' ? { tick: () => draw('video', 1280, 720) } : {}),
      }
    },
    now: () => now,
    setTimeout: (callback) => {
      timers.push(callback)
      return timers.length
    },
    clearTimeout: () => undefined,
  }
  return {
    env,
    worker,
    output,
    out,
    inputs,
    pathClosed,
    timers,
    frame: (name: unknown = 'frame', width = 1280, height = 720) => draw(name, width, height),
    advance: (ms: number) => {
      now += ms
    },
  }
}

const ASSETS = { worker: '/w.js', loader: '/l.js', wasm: '/m.wasm', model: '/s.tflite' }

async function started(path: 'insertable' | 'canvas' = 'insertable') {
  const fake = fakeEnv(path)
  const starting = startBackgroundBlur(ASSETS, fake.env)
  fake.worker.answer({ type: 'ready' })
  const blur = await starting
  const events: BlurEvent[] = []
  blur.subscribe((event) => events.push(event))
  return { ...fake, blur, events }
}

describe('the pipeline', () => {
  it('asks the worker for our own assets only, and a failure to load is an error', async () => {
    const fake = fakeEnv()
    const starting = startBackgroundBlur(ASSETS, fake.env)
    expect(fake.worker.sent[0]).toEqual({ type: 'init', loader: '/l.js', wasm: '/m.wasm', model: '/s.tflite' })
    fake.worker.answer({ type: 'error', message: 'no WebGL' })
    await expect(starting).rejects.toBeInstanceOf(BlurError)
    expect(fake.pathClosed).toHaveBeenCalled()
  })

  it('a model that never loads times out', async () => {
    const fake = fakeEnv()
    const starting = startBackgroundBlur(ASSETS, fake.env)
    expect(BLUR_START_TIMEOUT_MS).toBeGreaterThan(10_000)
    fake.timers[0]()
    await expect(starting).rejects.toBeInstanceOf(BlurError)
  })

  it('sends no frame before the first mask: an unblurred picture never goes out', async () => {
    const { blur, frame, worker, events, advance } = await started()
    expect(blur.ready()).toBe(false)
    expect(frame()).toBe(false)
    expect(worker.pictures()).toHaveLength(1)
    worker.answer({ type: 'mask', bitmap: bitmap(), ms: 10 })
    expect(blur.ready()).toBe(true)
    expect(events).toEqual([{ type: 'state' }])
    advance(1)
    expect(frame()).toBe(true)
  })

  it('draws mask, person, blurred background, at the frame’s size', async () => {
    const { frame, worker, out } = await started()
    frame('first')
    const mask = bitmap()
    worker.answer({ type: 'mask', bitmap: mask, ms: 10 })
    frame('second', 640, 360)
    expect([out.width, out.height]).toEqual([640, 360])
    expect(out.context.calls.map((call) => call.op)).toEqual([
      'copy',
      'source-in',
      'destination-over',
    ])
    expect(out.context.calls[0].source).toBe(mask)
    expect(out.context.calls[1].source).toBe('second')
  })

  it('never has two pictures at the model, and at most one every MASK_INTERVAL_MS', async () => {
    const { frame, worker, advance } = await started()
    frame()
    advance(MASK_INTERVAL_MS * 3)
    frame()
    expect(worker.pictures()).toHaveLength(1)
    worker.answer({ type: 'mask', bitmap: bitmap(), ms: 10 })
    frame()
    expect(worker.pictures()).toHaveLength(2)
    worker.answer({ type: 'mask', bitmap: bitmap(), ms: 10 })
    advance(MASK_INTERVAL_MS - 1)
    frame()
    expect(worker.pictures()).toHaveLength(2)
    advance(1)
    frame()
    expect(worker.pictures()).toHaveLength(3)
    expect(MASK_SIZE).toBe(256)
  })

  it('closes the mask it replaced', async () => {
    const { worker } = await started()
    const first = bitmap()
    worker.answer({ type: 'mask', bitmap: first, ms: 10 })
    worker.answer({ type: 'mask', bitmap: bitmap(), ms: 10 })
    expect(first.close).toHaveBeenCalled()
  })

  it('reports each second', async () => {
    const { frame, worker, advance, events } = await started()
    frame()
    worker.answer({ type: 'mask', bitmap: bitmap(), ms: 12 })
    for (let i = 0; i < 20; i++) {
      advance(50)
      frame()
    }
    const reports = events.flatMap((event) => (event.type === 'report' ? [event.report] : []))
    expect(reports).toHaveLength(1)
    expect(reports[0].fps).toBeCloseTo(20, 0)
    expect(reports[0].maskFps).toBeCloseTo(1, 0)
    expect(reports[0].maskMs).toBe(12)
  })

  it('a new camera goes under the same output; the mask carries over', async () => {
    const { blur, inputs, worker, output } = await started()
    worker.answer({ type: 'mask', bitmap: bitmap(), ms: 10 })
    const before = blur.track
    blur.setInput(track('a'))
    blur.setInput(null)
    blur.setInput(track('b'))
    expect(inputs.map((input) => input?.id ?? null)).toEqual(['a', null, 'b'])
    expect(blur.track).toBe(before)
    expect(blur.track).toBe(output)
    expect(blur.ready()).toBe(true)
  })

  it('the canvas path draws on the worker’s clock', async () => {
    const { worker, out } = await started('canvas')
    expect(worker.sent).toContainEqual({ type: 'clock', ms: 33 })
    worker.answer({ type: 'tick' })
    worker.answer({ type: 'mask', bitmap: bitmap(), ms: 10 })
    worker.answer({ type: 'tick' })
    expect(out.context.calls.length).toBe(3)
  })

  it('a worker failing while it runs is an error; closing stops everything', async () => {
    const { blur, worker, events, pathClosed, timers } = await started()
    worker.answer({ type: 'error', message: 'oops' })
    expect(events).toEqual([{ type: 'error' }])
    blur.close()
    expect(pathClosed).toHaveBeenCalled()
    expect(worker.sent.at(-1)).toEqual({ type: 'close' })
    timers.at(-1)?.()
    expect(worker.terminated).toBe(true)
    expect(blur.ready()).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// In the room

class FakeBlur implements BackgroundBlur {
  track = track('blurred')
  path = 'insertable' as const
  inputs: (MediaStreamTrack | null)[] = []
  isReady = false
  closed = false
  private readonly listeners = new Set<(event: BlurEvent) => void>()
  ready = () => this.isReady
  setInput(camera: MediaStreamTrack | null) {
    this.inputs.push(camera)
  }
  subscribe(listener: (event: BlurEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  close() {
    this.closed = true
  }
  emit(event: BlurEvent) {
    for (const listener of this.listeners) listener(event)
  }
  becomeReady() {
    this.isReady = true
    this.emit({ type: 'state' })
  }
}

function setup(initial: { camera: MediaStreamTrack | null; on: boolean }) {
  const pipeline = new FakeBlur()
  const onStop = vi.fn()
  const load = vi.fn(async (): Promise<StartBackgroundBlur> => async () => pipeline)
  const hook = renderHook((props: { camera: MediaStreamTrack | null; on: boolean }) =>
    useBackgroundBlur({ ...props, onStop, load, hidden: () => false }), { initialProps: initial })
  return { pipeline, onStop, load, ...hook }
}

describe('useBackgroundBlur', () => {
  const camera = track('camera')

  it('loads nothing while off, or on with no camera', async () => {
    const off = setup({ camera, on: false })
    expect(off.load).not.toHaveBeenCalled()
    expect(off.result.current.send).toBe(camera)
    expect(off.result.current.status).toBe('off')
    const noCamera = setup({ camera: null, on: true })
    expect(noCamera.load).not.toHaveBeenCalled()
    expect(noCamera.result.current.send).toBeNull()
  })

  it('turned on mid-call: the camera goes on until the blur is ready, then off restores it', async () => {
    const { result, rerender, pipeline } = setup({ camera, on: false })
    rerender({ camera, on: true })
    expect(result.current.send).toBe(camera)
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(pipeline.inputs).toEqual([camera]))
    expect(result.current.send).toBe(camera)
    act(() => pipeline.becomeReady())
    expect(result.current.send).toBe(pipeline.track)
    expect(result.current.preview).toBe(pipeline.track)
    expect(result.current.status).toBe('on')
    rerender({ camera, on: false })
    expect(result.current.send).toBe(camera)
    expect(pipeline.closed).toBe(true)
  })

  it('joining with it remembered: nothing goes out until ready, though we see ourselves', async () => {
    const { result, pipeline } = setup({ camera, on: true })
    expect(result.current.send).toBeNull()
    expect(result.current.preview).toBe(camera)
    await waitFor(() => expect(pipeline.inputs).toEqual([camera]))
    expect(result.current.send).toBeNull()
    act(() => pipeline.becomeReady())
    expect(result.current.send).toBe(pipeline.track)
  })

  it('a device switch goes under the same output track', async () => {
    const { result, rerender, pipeline } = setup({ camera, on: true })
    await waitFor(() => expect(pipeline.inputs).toEqual([camera]))
    act(() => pipeline.becomeReady())
    const other = track('other')
    rerender({ camera: other, on: true })
    expect(pipeline.inputs).toEqual([camera, other])
    expect(result.current.send).toBe(pipeline.track)
    rerender({ camera: null, on: true })
    expect(result.current.send).toBeNull()
    expect(pipeline.closed).toBe(false)
  })

  it('the camera turned off for a share and restored after it (ShareCameraGuard): blurred, never plain', async () => {
    const { result, rerender, pipeline } = setup({ camera, on: true })
    await waitFor(() => expect(pipeline.inputs).toEqual([camera]))
    act(() => pipeline.becomeReady())
    // The guard stops the device: nothing goes out and the pipeline stays, idle
    rerender({ camera: null, on: true })
    expect(result.current.send).toBeNull()
    expect(pipeline.inputs.at(-1)).toBeNull()
    expect(pipeline.closed).toBe(false)
    // The share is over: a new track from the device goes straight through the pipeline
    const restored = track('restored')
    rerender({ camera: restored, on: true })
    expect(result.current.send).toBe(pipeline.track)
    expect(pipeline.inputs.at(-1)).toBe(restored)
  })

  it('the camera turned off for a share while the model loads: it comes back held, not plain', async () => {
    const { result, rerender, pipeline } = setup({ camera, on: false })
    rerender({ camera, on: true })
    expect(result.current.send).toBe(camera)
    rerender({ camera: null, on: true })
    const restored = track('restored')
    rerender({ camera: restored, on: true })
    expect(result.current.send).toBeNull()
    await waitFor(() => expect(pipeline.inputs.at(-1)).toBe(restored))
    act(() => pipeline.becomeReady())
    expect(result.current.send).toBe(pipeline.track)
  })

  it('stops after seconds over budget, with the reason', async () => {
    const { onStop, pipeline } = setup({ camera, on: true })
    await waitFor(() => expect(pipeline.inputs).toEqual([camera]))
    const over = report({ fps: 8, maskFps: 1, busy: 0.7 })
    act(() => {
      for (let i = 0; i < BLUR_WARMUP_SECONDS + BLUR_OVER_SECONDS - 1; i++) {
        pipeline.emit({ type: 'report', report: over })
      }
    })
    expect(onStop).not.toHaveBeenCalled()
    act(() => pipeline.emit({ type: 'report', report: over }))
    expect(onStop).toHaveBeenCalledWith('overloaded')
  })

  it('a hidden page is not judged', async () => {
    const pipeline = new FakeBlur()
    const onStop = vi.fn()
    renderHook(() =>
      useBackgroundBlur({
        camera,
        on: true,
        onStop,
        load: async () => async () => pipeline,
        hidden: () => true,
      }),
    )
    await waitFor(() => expect(pipeline.inputs).toEqual([camera]))
    act(() => {
      for (let i = 0; i < 40; i++) {
        pipeline.emit({ type: 'report', report: report({ fps: 1, maskFps: 0, busy: 0.9 }) })
      }
    })
    expect(onStop).not.toHaveBeenCalled()
  })

  it('failing to load or while running says so', async () => {
    const onStop = vi.fn()
    renderHook(() =>
      useBackgroundBlur({
        camera,
        on: true,
        onStop,
        load: async () => async () => {
          throw new BlurError('no')
        },
      }),
    )
    await waitFor(() => expect(onStop).toHaveBeenCalledWith('failed'))
    const running = setup({ camera, on: true })
    await waitFor(() => expect(running.pipeline.inputs).toEqual([camera]))
    act(() => running.pipeline.emit({ type: 'error' }))
    expect(running.onStop).toHaveBeenCalledWith('failed')
  })
})

afterEach(() => {
  localStorage.clear()
})

describe('the package', () => {
  it('stays a version without MediaPipe’s usage logging (from 1.0 it reports to Google)', () => {
    const bundle = fs.readFileSync('node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', 'utf8')
    expect(bundle).not.toContain('odml.pa.googleapis.com')
    const notices = fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8')
    expect(notices).toContain('MediaPipe')
    expect(notices).toContain('selfie_segmenter')
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>
    }
    // Pinned exactly: a caret would not hold it back
    expect(manifest.dependencies['@mediapipe/tasks-vision']).toBe('0.10.35')
  })
})

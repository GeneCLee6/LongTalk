// 背景模糊's pipeline on the page (e6-t06, AC-6.5; ADR-001 「背景模糊」): the camera's track goes in,
// a track with the background blurred comes out, and that is what the room sends instead of the
// camera (RoomMedia.setLocal → MediaTransport.replaceTrack: no renegotiation, and the simulcast
// layers are the sender's, so they scale this track like any other).
//
// - The model runs in a worker (blurWorker.ts) on a small picture, at most MASK_INTERVAL_MS apart
//   and never two at once. Every frame is drawn on the page with the latest mask, so the video
//   stays at the camera's rate whatever the model takes.
// - A frame: the mask, the frame kept where the mask is (`source-in`), and behind it
//   (`destination-over`) the frame shrunk and blurred. Three drawImage calls on a canvas; the
//   blur itself is cheap because it happens on BLUR_WIDTH pixels, not on 720p.
// - No frame goes out before the first mask: the output never shows an unblurred picture.
// - Two ways to take frames in and out:
//   `insertable` (Chromium): MediaStreamTrackProcessor and MediaStreamTrackGenerator. Frames come
//   whatever the tab is doing, so the video keeps going in a background tab.
//   `canvas` (Firefox, Safari, which have no such pair on the page): a hidden <video> drawn on a
//   canvas that canvas.captureStream() sends, on a clock from the worker.
// - `setInput` swaps the camera under it (a device switch, the camera turned off and on) while the
//   output stays the same track, so the sender is not touched.
// - Video frames never leave the browser other than as this track.
// No React and no interface text here.
import type { BlurReport } from './blurLoad.ts'
import { blurPath, type BlurPath } from './capabilities.ts'

export interface BlurAssets {
  worker: string
  loader: string
  wasm: string
  model: string
}

export type BlurToWorker =
  | { type: 'init'; loader: string; wasm: string; model: string }
  | { type: 'picture'; bitmap: ImageBitmap }
  /** Start the canvas path's clock */
  | { type: 'clock'; ms: number }
  | { type: 'close' }

export type BlurToPage =
  | { type: 'ready' }
  | { type: 'mask'; bitmap: ImageBitmap; ms: number }
  | { type: 'tick' }
  | { type: 'error'; message: string }

/** The model's input size */
export const MASK_SIZE = 256
/** New masks at most this often: about every other frame of a 30 fps camera */
export const MASK_INTERVAL_MS = 60
/** The background is blurred at this width; anything wider costs more and looks the same */
export const BLUR_WIDTH = 320
/** The canvas path draws at most this often */
export const CANVAS_CLOCK_MS = 33
/** How long the model may take to load (11 MB of wasm, about 3.5 MB compressed, on a slow connection) */
export const BLUR_START_TIMEOUT_MS = 60_000

export type BlurEvent =
  /** Whether it can send now (the first mask arrived) changed */
  | { type: 'state' }
  | { type: 'report'; report: BlurReport }
  | { type: 'error' }

export interface BackgroundBlur {
  /** What to send instead of the camera, once `ready()` */
  readonly track: MediaStreamTrack
  readonly path: BlurPath
  ready(): boolean
  setInput(camera: MediaStreamTrack | null): void
  subscribe(listener: (event: BlurEvent) => void): () => void
  close(): void
}

export class BlurError extends Error {}

export interface WorkerLike {
  onmessage: ((event: { data: BlurToPage }) => void) | null
  onerror: ((event: unknown) => void) | null
  postMessage(message: BlurToWorker, transfer?: Transferable[]): void
  terminate(): void
}

/** The bits of a canvas's 2D context the pipeline draws with */
export interface Context2D {
  globalCompositeOperation: string
  imageSmoothingEnabled: boolean
  filter?: string
  drawImage(source: unknown, x: number, y: number, width: number, height: number): void
}

export interface CanvasLike {
  width: number
  height: number
  getContext(kind: '2d'): Context2D | null
}

/** A canvas that can hand over what it holds without waiting (OffscreenCanvas) */
export interface PictureCanvas extends CanvasLike {
  transferToImageBitmap(): ImageBitmap
}

/**
 * Frames in and frames out. `draw` is called with each new frame and returns whether the path's
 * canvas now holds one to send.
 */
export interface FramePath {
  readonly output: MediaStreamTrack
  readonly canvas: CanvasLike
  setInput(camera: MediaStreamTrack | null): void
  /** The worker's clock (the canvas path only) */
  tick?(): void
  close(): void
}

export type DrawFrame = (frame: unknown, width: number, height: number) => boolean

/** What the pipeline needs from the browser; the tests pass fakes */
export interface BlurEnv {
  path: BlurPath
  createWorker: (url: string) => WorkerLike
  createPicture: (width: number, height: number) => PictureCanvas
  createPath: (path: BlurPath, draw: DrawFrame) => FramePath
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

// The Insertable Streams pair, which lib.dom does not know yet
interface ProcessorLike {
  readable: ReadableStream<VideoFrame>
}
interface GeneratorLike extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>
}
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => ProcessorLike
declare const MediaStreamTrackGenerator: new (init: { kind: 'video' }) => GeneratorLike

/** Chromium: frames arrive whatever the tab does, and the output is a real generator track */
function insertablePath(draw: DrawFrame): FramePath {
  const generator = new MediaStreamTrackGenerator({ kind: 'video' })
  const writer = generator.writable.getWriter()
  const canvas = new OffscreenCanvas(1, 1)
  let run = 0
  const pump = async (camera: MediaStreamTrack, id: number) => {
    const reader = new MediaStreamTrackProcessor({ track: camera }).readable.getReader()
    try {
      while (id === run) {
        const { value: frame, done } = await reader.read()
        if (done) return
        try {
          if (id === run && draw(frame, frame.displayWidth, frame.displayHeight)) {
            // The generator closes what it is given
            const out = new VideoFrame(canvas, { timestamp: frame.timestamp, alpha: 'discard' })
            await writer.write(out)
          }
        } finally {
          frame.close()
        }
      }
    } catch {
      // The camera or the output closed: nothing more to do with this one
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }
  return {
    output: generator,
    canvas: canvas as unknown as CanvasLike,
    setInput(camera) {
      run += 1
      if (camera) void pump(camera, run)
    },
    close() {
      run += 1
      void writer.close().catch(() => undefined)
      generator.stop()
    },
  }
}

/** Firefox, Safari: a hidden <video> and a captured canvas */
function canvasPath(draw: DrawFrame): FramePath {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  const canvas = document.createElement('canvas')
  // Firefox wants a context before it captures
  canvas.getContext('2d')
  const stream = canvas.captureStream(1000 / CANVAS_CLOCK_MS)
  let shownTime = -1
  return {
    output: stream.getVideoTracks()[0],
    canvas: canvas as unknown as CanvasLike,
    setInput(camera) {
      shownTime = -1
      video.srcObject = camera ? new MediaStream([camera]) : null
      if (camera) void video.play().catch(() => undefined)
    },
    tick() {
      // Only a new frame of the video: the clock runs whatever the camera does
      if (video.readyState < 2 || video.currentTime === shownTime) return
      shownTime = video.currentTime
      draw(video, video.videoWidth, video.videoHeight)
    },
    close() {
      video.srcObject = null
      for (const track of stream.getTracks()) track.stop()
    },
  }
}

export function browserBlurEnv(): BlurEnv {
  const path = blurPath()
  if (!path) throw new BlurError('not supported')
  return {
    path,
    createWorker: (url) => new Worker(url) as unknown as WorkerLike,
    createPicture: (width, height) => new OffscreenCanvas(width, height) as unknown as PictureCanvas,
    createPath: (which, draw) => (which === 'insertable' ? insertablePath(draw) : canvasPath(draw)),
    now: () => performance.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

/** Starts the worker and loads the model; resolves once it can take frames */
export async function startBackgroundBlur(
  assets: BlurAssets,
  env: BlurEnv = browserBlurEnv(),
): Promise<BackgroundBlur> {
  const worker = env.createWorker(assets.worker)
  const listeners = new Set<(event: BlurEvent) => void>()
  const emit = (event: BlurEvent) => {
    for (const listener of listeners) listener(event)
  }
  const small = env.createPicture(BLUR_WIDTH, Math.round((BLUR_WIDTH * 9) / 16))
  const smallContext = small.getContext('2d')
  const picture = env.createPicture(MASK_SIZE, MASK_SIZE)
  const pictureContext = picture.getContext('2d')
  if (!smallContext || !pictureContext) {
    worker.terminate()
    throw new BlurError('no 2D canvas')
  }
  // 2D filters are missing in Safari: there the shrinking alone softens the background
  if ('filter' in smallContext) smallContext.filter = 'blur(4px)'

  let mask: ImageBitmap | null = null
  let maskBusy = false
  let lastPicture = -Infinity
  let closed = false
  let drawing: Context2D | null = null
  // This second's counts
  let secondStart = env.now()
  let frames = 0
  let masks = 0
  let busyMs = 0
  let maskMs = 0

  const countSecond = (now: number) => {
    if (now - secondStart < 1000) return
    const seconds = (now - secondStart) / 1000
    const report: BlurReport = {
      fps: frames / seconds,
      maskFps: masks / seconds,
      busy: busyMs / (now - secondStart),
      maskMs,
    }
    secondStart = now
    frames = masks = busyMs = 0
    emit({ type: 'report', report })
  }

  const draw: DrawFrame = (frame, width, height) => {
    if (closed || width === 0 || height === 0) return false
    const started = env.now()
    if (!maskBusy && started - lastPicture >= MASK_INTERVAL_MS) {
      maskBusy = true
      lastPicture = started
      pictureContext.drawImage(frame, 0, 0, MASK_SIZE, MASK_SIZE)
      const bitmap = picture.transferToImageBitmap()
      worker.postMessage({ type: 'picture', bitmap }, [bitmap])
    }
    if (!mask || !drawing) return false
    const { canvas } = path
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    // A little past the edges: the blur fades towards them otherwise
    smallContext.drawImage(frame, -8, -8, small.width + 16, small.height + 16)
    drawing.globalCompositeOperation = 'copy'
    drawing.drawImage(mask, 0, 0, width, height)
    drawing.globalCompositeOperation = 'source-in'
    drawing.drawImage(frame, 0, 0, width, height)
    drawing.globalCompositeOperation = 'destination-over'
    drawing.drawImage(small, 0, 0, width, height)
    const now = env.now()
    frames += 1
    busyMs += now - started
    countSecond(now)
    return true
  }

  const path = env.createPath(env.path, draw)
  drawing = path.canvas.getContext('2d')
  if (!drawing) {
    path.close()
    worker.terminate()
    throw new BlurError('no 2D canvas')
  }

  const fail = () => {
    if (!closed) emit({ type: 'error' })
  }

  const close = () => {
    if (closed) return
    closed = true
    path.close()
    mask?.close()
    mask = null
    worker.postMessage({ type: 'close' })
    // In case the model is stuck: the worker has had time to clean up
    env.setTimeout(() => worker.terminate(), 1000)
    listeners.clear()
  }

  await new Promise<void>((resolve, reject) => {
    const timer = env.setTimeout(() => {
      close()
      reject(new BlurError('timed out'))
    }, BLUR_START_TIMEOUT_MS)
    worker.onerror = () => {
      env.clearTimeout(timer)
      close()
      reject(new BlurError('worker failed'))
    }
    worker.onmessage = ({ data }) => {
      env.clearTimeout(timer)
      if (data.type === 'ready') resolve()
      else {
        close()
        reject(new BlurError(data.type === 'error' ? data.message : 'unexpected message'))
      }
    }
    worker.postMessage({
      type: 'init',
      loader: assets.loader,
      wasm: assets.wasm,
      model: assets.model,
    })
  })

  worker.onerror = fail
  worker.onmessage = ({ data }) => {
    if (closed) {
      if (data.type === 'mask') data.bitmap.close()
      return
    }
    switch (data.type) {
      case 'mask': {
        const first = mask === null
        mask?.close()
        mask = data.bitmap
        maskBusy = false
        masks += 1
        maskMs = data.ms
        if (first) emit({ type: 'state' })
        return
      }
      case 'tick':
        path.tick?.()
        return
      case 'error':
        fail()
        return
      case 'ready':
        return
    }
  }
  if (path.tick) worker.postMessage({ type: 'clock', ms: CANVAS_CLOCK_MS })

  return {
    track: path.output,
    path: env.path,
    // Once it has a mask it stays ready: a new camera's first frame already goes through it
    ready: () => mask !== null && !closed,
    setInput(camera) {
      if (closed) return
      secondStart = env.now()
      frames = masks = busyMs = 0
      maskBusy = false
      path.setInput(camera)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close,
  }
}

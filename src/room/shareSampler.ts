import { frameChange } from '../media/shareMode.ts'

// A small copy of our own shared screen, once a second (H5): the presenter view's thumbnail
// (e3-t08: drawn from the local capture, never from the SFU) and the samples the dynamic-content
// hint compares (e3-t06, media/shareMode.ts frameChange). One frame a second at SAMPLE_WIDTH px
// wide costs next to nothing, and a thumbnail that slow cannot set off a visible mirror even when
// the meeting is on the shared screen.
//
// Frames come from ImageCapture.grabFrame() where the browser has it (Chromium: it keeps working
// while this tab is in the background, which is most of the time when sharing another window),
// else from a muted <video> of the track (requestVideoFrameCallback: Firefox, Safari). Neither in
// jsdom: canSampleShare() is false and nothing is sampled.

export const SAMPLE_MS = 1_000
export const SAMPLE_WIDTH = 160

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>
}

type ImageCaptureConstructor = new (track: MediaStreamTrack) => ImageCaptureLike

const imageCapture = (): ImageCaptureConstructor | null =>
  (globalThis as { ImageCapture?: ImageCaptureConstructor }).ImageCapture ?? null

/** Whether this browser can sample a captured screen (ImageCapture, or video frame callbacks) */
export function canSampleShare(): boolean {
  if (typeof document === 'undefined') return false
  if (imageCapture()) return true
  return (
    typeof HTMLVideoElement !== 'undefined' &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
  )
}

export interface ShareSample {
  /** The latest frame, SAMPLE_WIDTH wide (the source's aspect) */
  canvas: HTMLCanvasElement
  /** The share of pixels that changed since the sample before (0 for the first) */
  change: number
}

/** Samples `track` every SAMPLE_MS until stop() */
export class ShareSampler {
  readonly #track: MediaStreamTrack
  readonly #onSample: (sample: ShareSample) => void
  readonly #canvas: HTMLCanvasElement
  readonly #context: CanvasRenderingContext2D | null
  #timer: ReturnType<typeof setInterval> | null = null
  #capture: ImageCaptureLike | null = null
  #video: HTMLVideoElement | null = null
  #previous: Uint8ClampedArray | null = null
  #busy = false

  constructor(track: MediaStreamTrack, onSample: (sample: ShareSample) => void) {
    this.#track = track
    this.#onSample = onSample
    this.#canvas = document.createElement('canvas')
    this.#context = this.#canvas.getContext('2d', { willReadFrequently: true })
  }

  start(): void {
    if (this.#timer !== null || !this.#context) return
    const Capture = imageCapture()
    if (Capture) {
      try {
        this.#capture = new Capture(this.#track)
      } catch {
        this.#capture = null
      }
    }
    if (!this.#capture) {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = new MediaStream([this.#track])
      void video.play().catch(() => undefined)
      this.#video = video
    }
    this.#timer = setInterval(() => void this.#sample(), SAMPLE_MS)
    void this.#sample()
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    if (this.#video) {
      this.#video.pause()
      this.#video.srcObject = null
    }
    this.#video = null
    this.#capture = null
    this.#previous = null
  }

  async #sample(): Promise<void> {
    if (this.#busy || this.#timer === null || this.#track.readyState === 'ended') return
    this.#busy = true
    try {
      let source: CanvasImageSource | null = null
      let width = 0
      let height = 0
      let bitmap: ImageBitmap | null = null
      if (this.#capture) {
        bitmap = await this.#capture.grabFrame().catch(() => null)
        if (bitmap) {
          source = bitmap
          width = bitmap.width
          height = bitmap.height
        }
      } else if (this.#video && this.#video.readyState >= 2) {
        source = this.#video
        width = this.#video.videoWidth
        height = this.#video.videoHeight
      }
      if (!source || width <= 0 || height <= 0 || this.#timer === null) {
        bitmap?.close()
        return
      }
      this.#draw(source, width, height)
      bitmap?.close()
    } finally {
      this.#busy = false
    }
  }

  #draw(source: CanvasImageSource, width: number, height: number): void {
    const context = this.#context!
    const canvas = this.#canvas
    const w = SAMPLE_WIDTH
    const h = Math.max(1, Math.round((SAMPLE_WIDTH * height) / width))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      this.#previous = null
    }
    context.drawImage(source, 0, 0, w, h)
    const data = context.getImageData(0, 0, w, h).data
    const change = this.#previous ? frameChange(this.#previous, data) : 0
    this.#previous = data
    this.#onSample({ canvas, change })
  }
}

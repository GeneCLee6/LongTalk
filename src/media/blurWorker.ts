// The segmentation for 背景模糊 (e6-t06), in a worker of its own so that the model never holds up
// the page: MediaPipe's ImageSegmenter on the selfie model, everything from our own /assets/
// (blurAssets.ts). It gets a small picture, gives back an alpha mask, and sends nothing anywhere
// else. Frames stay in this browser (a test keeps the package free of its usage logging, which
// starts at 1.0: tests/app/l4Blur.test.tsx).
//
// CPU delegate: the same on every computer, and a 256 × 256 model with SIMD takes a few ms. The
// GPU delegate would save little here and competes with the video encoder on weak GPUs.
//
// Also the canvas path's clock (backgroundBlur.ts): a page's own timers slow to one a second in a
// background tab, a worker's do not.
import { ImageSegmenter } from '@mediapipe/tasks-vision'
import { writeMask } from './blurMask.ts'
import type { BlurToPage, BlurToWorker } from './backgroundBlur.ts'

interface WorkerScope {
  onmessage: ((event: MessageEvent<BlurToWorker>) => void) | null
  postMessage(message: BlurToPage, transfer?: Transferable[]): void
  close(): void
}
const scope = self as unknown as WorkerScope

let segmenter: ImageSegmenter | null = null
let smoothed: Float32Array | null = null
let rgba: Uint8ClampedArray<ArrayBuffer> | null = null
let clock: ReturnType<typeof setInterval> | null = null
let lastTimestamp = 0

async function init(message: Extract<BlurToWorker, { type: 'init' }>): Promise<void> {
  try {
    segmenter = await ImageSegmenter.createFromOptions(
      { wasmLoaderPath: message.loader, wasmBinaryPath: message.wasm },
      {
        baseOptions: { modelAssetPath: message.model, delegate: 'CPU' },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      },
    )
    scope.postMessage({ type: 'ready' })
  } catch (error) {
    scope.postMessage({ type: 'error', message: String(error) })
  }
}

function segment(picture: ImageBitmap): void {
  const started = performance.now()
  // The model wants strictly increasing timestamps
  lastTimestamp = Math.max(lastTimestamp + 1, Math.round(started))
  let mask: ImageBitmapSource | null = null
  let width = 0
  let height = 0
  try {
    segmenter?.segmentForVideo(picture, lastTimestamp, (result) => {
      // The selfie model's masks: background, then person; the last one is always the person
      const masks = result.confidenceMasks
      const person = masks?.[masks.length - 1]
      if (!person) return
      width = person.width
      height = person.height
      const confidence = person.getAsFloat32Array()
      const first = smoothed?.length !== confidence.length
      if (first) {
        smoothed = new Float32Array(confidence.length)
        rgba = new Uint8ClampedArray(confidence.length * 4)
      }
      writeMask(confidence, smoothed!, rgba!, first)
      mask = new ImageData(rgba!, width, height)
      for (const each of masks) each.close()
    })
  } catch (error) {
    scope.postMessage({ type: 'error', message: String(error) })
    return
  } finally {
    picture.close()
  }
  if (!mask) {
    scope.postMessage({ type: 'error', message: 'no mask' })
    return
  }
  void createImageBitmap(mask).then(
    (bitmap) =>
      scope.postMessage({ type: 'mask', bitmap, ms: performance.now() - started }, [bitmap]),
    (error: unknown) => scope.postMessage({ type: 'error', message: String(error) }),
  )
}

scope.onmessage = ({ data }) => {
  switch (data.type) {
    case 'init':
      void init(data)
      return
    case 'picture':
      segment(data.bitmap)
      return
    case 'clock':
      if (clock !== null) clearInterval(clock)
      clock = setInterval(() => scope.postMessage({ type: 'tick' }), data.ms)
      return
    case 'close':
      if (clock !== null) clearInterval(clock)
      segmenter?.close()
      scope.close()
      return
  }
}

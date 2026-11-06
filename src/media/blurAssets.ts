// Where 背景模糊's files are (e6-t06): the worker, MediaPipe's loader and SIMD wasm from npm, and the
// selfie model kept in this repository, all hashed files under our own /assets/ (no other origin,
// no network-loaded model; the licences are in THIRD_PARTY_NOTICES.md). Imported only by the lazy
// loader (useBackgroundBlur.ts), and left out of the service worker's precache (src/pwa/swRouting.ts),
// so nobody downloads any of it until they turn the blur on.
import worker from './blurWorker.ts?worker&url'
import loader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasm from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import model from './models/selfie_segmenter.tflite?url'
import type { BlurAssets } from './backgroundBlur.ts'

export const BLUR_ASSETS: BlurAssets = { worker, loader, wasm, model }

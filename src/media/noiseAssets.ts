// Where the advanced noise suppression's files are (e6-t02): the worklet, built on its own, and
// RNNoise's wasm with and without SIMD, all hashed files under our own /assets/ (no other
// origin, no network-loaded model). Imported only by the lazy loader (useNoiseSuppression.ts),
// so none of it is in the room's first JS.
import worklet from './rnnoise.worklet.ts?worker&url'
import wasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import wasmSimd from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import type { NoiseAssets } from './noiseSuppression.ts'

export const NOISE_ASSETS: NoiseAssets = { worklet, wasm, wasmSimd }

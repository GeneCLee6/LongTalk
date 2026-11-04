// Local recording (I4, e8-t01, e8-t03): the room as the recorder sees it, drawn on a canvas
// (composer.ts) with every sound mixed (mixer.ts), recorded by MediaRecorder in the best format
// this browser writes (format.ts), chunk by chunk into IndexedDB (store.ts), and downloaded when
// it stops. Loaded only when someone starts recording (CLAUDE.md rule 6): nothing here is in the
// room page's JS.
//
// Memory stays flat over an hour: the chunks go to IndexedDB as they come (timeslice) and are let
// go; one canvas and one video element per track for the whole recording; the drawing runs at a
// fixed rate from a worker's timer (a page's own timers are slowed in a background tab, a
// worker's are not), never faster than RECORDING_FPS; object URLs are revoked.
import { Composer, browserVideos, type Context2D, type VideoFactory } from './composer.ts'
import {
  AUDIO_BITS_PER_SECOND,
  RESOLUTIONS,
  containerType,
  pickMimeType,
  recordingFileName,
  type RecordingSettings,
} from './format.ts'
import { AudioMixer, type MixerContext } from './mixer.ts'
import { withoutOwnCamera, type Scene } from './scene.ts'
import {
  DOWNLOADED_KEEP_MS,
  downloadFile,
  holdRecording,
  openRecordingStore,
  type RecordingMeta,
  type RecordingStore,
} from './store.ts'

/** MediaRecorder hands over a chunk this often: at most this much is lost in a crash */
export const RECORDER_TIMESLICE_MS = 4000

/** Frames drawn per second; 省電模式 halves it */
export const RECORDING_FPS = 30
export const RECORDING_FPS_SAVING = 15

/** Why a recording stopped on its own (the file is saved either way) */
export type RecorderProblem = 'storage' | 'failed'

export interface RecorderOptions {
  roomId: string
  roomName: string
  settings: RecordingSettings
  /** The scene now: read on every frame */
  getScene: () => Scene
  /** 省電模式: fewer frames */
  powerSaving?: boolean
  /** The recording stopped on its own: storage full, or the browser's recorder failed */
  onProblem?: (problem: RecorderProblem) => void
}

/** What a stopped recording left */
export interface SavedRecording {
  fileName: string
  /** 0: nothing was recorded, nothing was downloaded */
  bytes: number
}

export interface RecordingHandle {
  readonly id: string
  readonly fileName: string
  readonly mimeType: string
  /** Stops, writes the last chunk, downloads the file. Safe to call more than once */
  stop(): Promise<SavedRecording>
}

/** A canvas the recorder draws on and captures */
export interface RecordingCanvas {
  getContext(kind: '2d'): Context2D | null
  captureStream(fps: number): MediaStream
}

/** What MediaRecorder is to the recorder (a fake in tests) */
export interface RecorderLike {
  state: 'inactive' | 'recording' | 'paused'
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror: (() => void) | null
  start(timeslice: number): void
  stop(): void
}

export interface RecorderDeps {
  isTypeSupported: (type: string) => boolean
  createRecorder: (
    stream: MediaStream,
    options: { mimeType: string; videoBitsPerSecond?: number; audioBitsPerSecond: number },
  ) => RecorderLike
  createAudioContext: () => MixerContext & { close(): Promise<void>; resume?(): Promise<void> }
  createCanvas: (width: number, height: number) => RecordingCanvas
  createStream: (tracks: MediaStreamTrack[]) => MediaStream
  /** A stream of one track, for the mixer */
  trackStream: (track: MediaStreamTrack) => MediaStream
  videos: VideoFactory
  openStore: () => Promise<RecordingStore>
  download: (blob: Blob, fileName: string) => void
  /** Calls `tick` every `ms` until the returned function is called */
  ticker: (ms: number, tick: () => void) => () => void
  newId: () => string
  now: () => number
  /** Runs `work` later (cleaning up downloaded chunks) */
  later: (work: () => void, ms: number) => void
  /** Marks the recording as being made in this tab until the returned function is called */
  hold: (id: string) => () => void
}

export class RecorderError extends Error {
  readonly code: 'unsupported' | 'storage'
  constructor(code: 'unsupported' | 'storage') {
    super(`recording ${code}`)
    this.code = code
  }
}

/** A worker's timer: not slowed in a background tab like the page's own. Falls back to setInterval */
function workerTicker(ms: number, tick: () => void): () => void {
  try {
    const worker = new Worker(new URL('./ticker.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = () => tick()
    worker.postMessage(ms)
    return () => worker.terminate()
  } catch {
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
  }
}

/** The browser's own pieces */
export function browserDeps(): RecorderDeps {
  return {
    isTypeSupported: (type) => MediaRecorder.isTypeSupported(type),
    createRecorder: (stream, options) =>
      new MediaRecorder(stream, options) as unknown as RecorderLike,
    createAudioContext: () => new AudioContext(),
    createCanvas: (width, height) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas as unknown as RecordingCanvas
    },
    createStream: (tracks) => new MediaStream(tracks),
    trackStream: (track) => new MediaStream([track]),
    videos: browserVideos,
    openStore: openRecordingStore,
    download: downloadFile,
    ticker: workerTicker,
    newId: () => crypto.randomUUID(),
    now: Date.now,
    later: (work, ms) => void setTimeout(work, ms),
    hold: holdRecording,
  }
}

const isQuotaError = (error: unknown) =>
  error instanceof DOMException && error.name === 'QuotaExceededError'

/**
 * Starts recording. Rejects with RecorderError `unsupported` when this browser records none of
 * the formats, `storage` when IndexedDB cannot be opened.
 */
export async function startRecording(
  options: RecorderOptions,
  deps: RecorderDeps = browserDeps(),
): Promise<RecordingHandle> {
  const { settings } = options
  const mimeType = pickMimeType(deps.isTypeSupported, settings.audioOnly)
  if (mimeType === null) throw new RecorderError('unsupported')
  let store: RecordingStore
  try {
    store = await deps.openStore()
  } catch {
    throw new RecorderError('storage')
  }
  const startedAt = deps.now()
  const fileName = recordingFileName(options.roomName, new Date(startedAt), mimeType)
  let meta: RecordingMeta = await store.create({
    id: deps.newId(),
    roomId: options.roomId,
    roomName: options.roomName,
    startedAt,
    mimeType,
    fileName,
  })
  const release = deps.hold(meta.id)

  const context = deps.createAudioContext()
  await context.resume?.().catch(() => {})
  const mixer = new AudioMixer(context, deps.trackStream)
  const size = RESOLUTIONS[settings.resolution]
  let composer: Composer | null = null
  let videoTrack: MediaStreamTrack | null = null
  const fps = options.powerSaving ? RECORDING_FPS_SAVING : RECORDING_FPS
  if (!settings.audioOnly) {
    const canvas = deps.createCanvas(size.width, size.height)
    const ctx = canvas.getContext('2d')
    if (ctx) {
      composer = new Composer(ctx, size.width, size.height, deps.videos)
      videoTrack = canvas.captureStream(fps).getVideoTracks()[0] ?? null
    }
  }
  const frame = () => {
    const now = options.getScene()
    // Our own camera only when chosen (包含我的鏡頭); the tile stays, with our initial
    const scene = settings.includeSelf ? now : withoutOwnCamera(now)
    mixer.sync(scene.audio)
    composer?.draw(scene)
  }
  frame()
  const stopTicker = deps.ticker(Math.round(1000 / fps), frame)

  const stream = deps.createStream([...(videoTrack ? [videoTrack] : []), mixer.track])
  const recorder = deps.createRecorder(stream, {
    mimeType,
    ...(settings.audioOnly ? {} : { videoBitsPerSecond: size.videoBitsPerSecond }),
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  })

  // Chunks are written one after another, never held: the write takes the only reference
  let writes = Promise.resolve()
  let stopping: Promise<SavedRecording> | null = null
  const problem = (kind: RecorderProblem) => {
    if (stopping) return
    options.onProblem?.(kind)
    void handle.stop()
  }
  recorder.ondataavailable = (event) => {
    const blob = event.data
    if (!blob || blob.size === 0) return
    writes = writes.then(async () => {
      try {
        meta = await store.append(meta, blob)
      } catch (error) {
        problem(isQuotaError(error) ? 'storage' : 'failed')
      }
    })
  }
  recorder.onerror = () => problem('failed')

  const finish = async (): Promise<SavedRecording> => {
    stopTicker()
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        try {
          recorder.stop()
        } catch {
          resolve()
        }
      })
    }
    await writes
    videoTrack?.stop()
    mixer.close()
    composer?.dispose()
    await context.close().catch(() => {})
    try {
      if (meta.chunks === 0) {
        await store.remove(meta.id).catch(() => {})
        return { fileName, bytes: 0 }
      }
      const blob = await store.file(meta, containerType(mimeType), deps.now() - startedAt)
      deps.download(blob, fileName)
      await store.markDownloaded(meta).catch(() => {})
      // The download has started reading the stored chunks by then
      deps.later(() => void store.cleanUp().catch(() => {}), DOWNLOADED_KEEP_MS + 1000)
      return { fileName, bytes: meta.bytes }
    } finally {
      // Downloaded (or failed: then offered next time as left behind)
      release()
    }
  }

  const handle: RecordingHandle = {
    id: meta.id,
    fileName,
    mimeType,
    stop: () => (stopping ??= finish()),
  }
  recorder.start(RECORDER_TIMESLICE_MS)
  return handle
}

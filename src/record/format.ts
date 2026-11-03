// Local recording's formats and file names (I4, e8-t03): which container and codecs this
// browser's MediaRecorder can write, picked by asking it (MediaRecorder.isTypeSupported), never
// by guessing the browser. Small and pure: src/media/capabilities.ts uses it to decide whether
// to offer recording at all, before the recorder itself (lazy) is loaded.

/**
 * Video with sound, best first: WebM (VP9, then VP8, with Opus) where Chromium and Firefox write
 * it; MP4 (H.264 and AAC) where Safari does. A bare container last: the browser picks the codecs.
 */
export const VIDEO_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
] as const

/** Sound only (錄影設定 「只錄聲音」), best first */
export const AUDIO_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
] as const

/** MediaRecorder.isTypeSupported, or a stand-in in tests */
export type TypeSupport = (type: string) => boolean

/** The first type this browser records, or null when it records none of them */
export function pickMimeType(isTypeSupported: TypeSupport, audioOnly: boolean): string | null {
  for (const type of audioOnly ? AUDIO_TYPES : VIDEO_TYPES) {
    try {
      if (isTypeSupported(type)) return type
    } catch {
      // Some browsers throw on a type they cannot parse: not that one
    }
  }
  return null
}

/** The file's extension for a recorded type (`.webm`, `.mp4`; sound only in MP4 is `.m4a`) */
export function fileExtension(mimeType: string): string {
  const [container] = mimeType.toLowerCase().split(';')
  if (container === 'audio/mp4') return 'm4a'
  if (container.endsWith('/mp4')) return 'mp4'
  return 'webm'
}

/** The type without codecs, for the file's Blob (players prefer the plain container type) */
export const containerType = (mimeType: string): string => mimeType.split(';')[0].trim()

// What a file name may not contain on Windows, macOS or Linux, and control characters
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\p{Cc}‪-‮⁦-⁩]/gu

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The download's name: LongTalk, the room's name, the local date and time it started and the
 * extension, e.g. `LongTalk 週五聊天 2026-11-04 15-30.webm`. Characters a file system refuses
 * become spaces; a long room name is cut.
 */
export function recordingFileName(roomName: string, startedAt: Date, mimeType: string): string {
  const room = [...roomName.replace(UNSAFE_FILE_CHARS, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, 60)
    .join('')
    .trim()
  const date =
    `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}` +
    ` ${pad(startedAt.getHours())}-${pad(startedAt.getMinutes())}`
  // The product name is English only (RULES.md §2)
  return `${['LongTalk', room, date].filter(Boolean).join(' ')}.${fileExtension(mimeType)}`
}

/** The recording's size per resolution (16:9) and the bitrate it is recorded at */
export const RESOLUTIONS = {
  '720p': { width: 1280, height: 720, videoBitsPerSecond: 2_500_000 },
  '1080p': { width: 1920, height: 1080, videoBitsPerSecond: 5_000_000 },
} as const

export type Resolution = keyof typeof RESOLUTIONS

export const isResolution = (value: unknown): value is Resolution =>
  value === '720p' || value === '1080p'

/** The mixed sound's bitrate */
export const AUDIO_BITS_PER_SECOND = 128_000

/** What the person chose in 錄影設定 (e8-t03) */
export interface RecordingSettings {
  /** 只錄聲音: no picture at all */
  audioOnly: boolean
  /** 包含我的鏡頭: our own camera in our tile (off: our tile shows our initial) */
  includeSelf: boolean
  resolution: Resolution
}

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  audioOnly: false,
  includeSelf: true,
  resolution: '720p',
}

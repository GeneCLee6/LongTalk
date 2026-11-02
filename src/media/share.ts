// Picking what to share (e3-t01): the browser's getDisplayMedia picker, with the options the PRD
// asks for (E3 需求), and its failures sorted into what the room says about them. Publishing the
// track is MediaTransport's business (publish({ kind: 'screen' }), CLAUDE.md rule 2). Text and
// motion modes (contentHint and constraints, e3-t06) and the share's own audio (e3-t04) build on
// this file. No React here.

/** The part of navigator.mediaDevices sharing needs (a stand-in in tests) */
export interface DisplayMediaLike {
  getDisplayMedia?: (options?: DisplayMediaStreamOptions) => Promise<MediaStream>
}

const browserDevices = (): DisplayMediaLike | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator.mediaDevices ?? undefined)

/**
 * - `cancelled`: the person closed the picker without choosing: nothing to say
 * - `denied`: the operating system does not let the browser record the screen (macOS: System
 *   Settings › Privacy › Screen Recording), or a policy forbids it
 * - `unsupported`: no getDisplayMedia (phones, an insecure page)
 * - `failed`: anything else (the source could not be captured)
 */
export type ShareProblem = 'cancelled' | 'denied' | 'unsupported' | 'failed'

export type CaptureResult =
  { ok: true; track: MediaStreamTrack } | { ok: false; problem: ShareProblem }

/**
 * What the picker offers (E3): anything but this meeting's own tab (it would show itself
 * endlessly), switching source while sharing, no audio (e3-t04 adds it). Up to 1080p at a low
 * frame rate: text stays sharp and the free tier lasts (the text mode, e3-t06, refines it).
 */
export const DISPLAY_MEDIA_OPTIONS = {
  video: {
    width: { max: 1920 },
    height: { max: 1080 },
    frameRate: { ideal: 15, max: 30 },
  },
  audio: false,
  preferCurrentTab: false,
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  monitorTypeSurfaces: 'include',
} as const

/** A getDisplayMedia failure, as the room explains it */
export function shareProblem(error: unknown): ShareProblem {
  const name = (error as { name?: unknown } | null)?.name
  const message = String((error as { message?: unknown } | null)?.message ?? '')
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // Chrome says "Permission denied by system" when the OS refuses; closing the picker is a
      // plain "Permission denied" (Chrome, Edge), or NotAllowedError in Firefox and Safari too
      return /system|policy/i.test(message) || name === 'SecurityError' ? 'denied' : 'cancelled'
    case 'AbortError':
      return 'cancelled'
    case 'TypeError':
    case 'NotSupportedError':
      return 'unsupported'
    default:
      return 'failed'
  }
}

/**
 * Opens the browser's picker (must run in a click: the browser asks for a user gesture) and
 * resolves with the chosen screen, window or tab, marked as detail content (text stays sharp).
 */
export async function captureScreen(
  devices: DisplayMediaLike | undefined = browserDevices(),
): Promise<CaptureResult> {
  if (typeof devices?.getDisplayMedia !== 'function') return { ok: false, problem: 'unsupported' }
  let stream: MediaStream
  try {
    stream = await devices.getDisplayMedia(DISPLAY_MEDIA_OPTIONS as DisplayMediaStreamOptions)
  } catch (error) {
    return { ok: false, problem: shareProblem(error) }
  }
  const [track] = stream.getVideoTracks()
  // Audio is not asked for, but a browser could add some: not sent in D1
  for (const extra of stream.getTracks()) if (extra !== track) extra.stop()
  if (!track) return { ok: false, problem: 'failed' }
  try {
    track.contentHint = 'detail'
  } catch {
    // Read-only here: the encoder picks for itself
  }
  return { ok: true, track }
}

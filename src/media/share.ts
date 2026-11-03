// Picking what to share (e3-t01): the browser's getDisplayMedia picker, with the options the PRD
// asks for (E3 需求), and its failures sorted into what the room says about them. Publishing the
// track is MediaTransport's business (publish({ kind: 'screen' }), CLAUDE.md rule 2). Text and
// motion modes (contentHint and constraints, e3-t06) build on this file. No React here.
//
// The share's own sound (e3-t04): where the browser can capture it (Chromium on the desktop: a
// tab's audio everywhere, the whole system's sound on Windows and ChromeOS; capabilities.ts
// canShareAudio) the picker offers it, the person decides there (its "share audio" switch), and
// the audio track, if any, comes back next to the video. Choices, and why:
// - the sound is sent as it is (no echo cancellation, noise suppression or gain control: those
//   are for voices and spoil music);
// - the sharer keeps hearing the tab (suppressLocalAudioPlayback: false): a video they share is
//   one they want to hear too. Their microphone may then pick the tab up from the speakers, and
//   the others hear it twice (headphones avoid it; the sharing bar says so);
// - the system's sound leaves out this meeting's own sound where the browser can
//   (restrictOwnAudio): otherwise everyone would hear the others' voices come back through the
//   sharer's share.

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
  | {
      ok: true
      track: MediaStreamTrack
      /** The tab's or system's sound, when asked for and the person chose to share it */
      audio: MediaStreamTrack | null
    }
  | { ok: false; problem: ShareProblem }

/**
 * What the picker offers (E3): anything but this meeting's own tab (it would show itself
 * endlessly), switching source while sharing. Up to 1080p and up to 30 fps: the field test
 * (2026-11-03) found 15 fps choppy for scrolling and video; the encoder (encoding.ts: `balanced`
 * degradation, the uplink's larger share, at most 2.5 Mbps) gives up frame rate and resolution
 * together when the network or CPU cannot keep up, and a still screen sends almost nothing
 * whatever the rate (measurements in ADR-001; the text/motion switch is e3-t06). No audio here:
 * displayMediaOptions adds it where the browser can capture it (e3-t04).
 */
export const DISPLAY_MEDIA_OPTIONS = {
  video: {
    width: { max: 1920 },
    height: { max: 1080 },
    frameRate: { ideal: 30, max: 30 },
  },
  audio: false,
  preferCurrentTab: false,
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  monitorTypeSurfaces: 'include',
} as const

/** The share's sound as captured (e3-t04; the choices are explained at the top of this file) */
export const SHARE_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  suppressLocalAudioPlayback: false,
  restrictOwnAudio: true,
} as const

/** The picker's options, with the share's sound (tab and system audio) or without it */
export function displayMediaOptions(audio: boolean) {
  return audio
    ? { ...DISPLAY_MEDIA_OPTIONS, audio: SHARE_AUDIO_CONSTRAINTS, systemAudio: 'include' as const }
    : DISPLAY_MEDIA_OPTIONS
}

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
 * resolves with the chosen screen, window or tab, marked as detail content (text stays sharp),
 * and its sound when `audio` asks for it (capabilities.ts canShareAudio) and the person shared
 * it. A source without sound is no error: `audio` is then null.
 */
export async function captureScreen(
  devices: DisplayMediaLike | undefined = browserDevices(),
  audio = false,
): Promise<CaptureResult> {
  if (typeof devices?.getDisplayMedia !== 'function') return { ok: false, problem: 'unsupported' }
  const ask = (withAudio: boolean) =>
    devices.getDisplayMedia!(displayMediaOptions(withAudio) as DisplayMediaStreamOptions)
  let stream: MediaStream
  try {
    stream = await ask(audio).catch((error: unknown) => {
      // A browser that cannot take the audio options at all refuses them before the picker
      // opens (TypeError): ask again without
      if (audio && (error as { name?: unknown } | null)?.name === 'TypeError') return ask(false)
      throw error
    })
  } catch (error) {
    return { ok: false, problem: shareProblem(error) }
  }
  const [track] = stream.getVideoTracks()
  const sound = (audio && stream.getAudioTracks()[0]) || null
  // Anything else (audio nobody asked for) is not kept running
  for (const extra of stream.getTracks()) if (extra !== track && extra !== sound) extra.stop()
  if (!track) {
    sound?.stop()
    return { ok: false, problem: 'failed' }
  }
  // Detail: the first frames are already full resolution (with `motion` the share began at 720p
  // for ~14 s); smoothness under pressure comes from the sender's `balanced` degradation
  try {
    track.contentHint = 'detail'
  } catch {
    // Read-only here: the encoder picks for itself
  }
  return { ok: true, track, audio: sound }
}

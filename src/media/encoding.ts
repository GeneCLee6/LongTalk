// How a published video track is encoded (field test 2026-11-03, docs/adr-001-media-layer.md
// 「編碼參數」): sender parameters per kind of track, set by CloudflareRealtimeTransport when it
// publishes (CLAUDE.md rule 2: nothing else touches RTCRtpSender). Measured on the PR preview
// with headless Chrome through Realtime; the numbers are in the ADR.
//
// - The screen gets the larger share of the uplink (priority `high`: Chrome splits the estimate
//   between a PeerConnection's senders by priority), up to 30 fps, and adapts by `balanced`
//   degradation: under pressure it lowers resolution and frame rate together, instead of holding
//   1080p and dropping to a frame or two a second (what `detail` alone did: 「卡卡的」).
// - The camera is capped, which also leaves room for a share on the same uplink.
//
// Simulcast (e2-t11, H1; ADR-001 「Simulcast」): a camera goes out in three layers and a screen in
// two (SIMULCAST below), and each receiver asks the SFU for the one its tile needs (layers.ts,
// e2-t12). The single-layer parameters stay for a browser that refuses simulcast encodings.
import type { Layer, TrackKind } from './MediaTransport.ts'
import type { SimulcastRid } from '../../shared/sfu.ts'

export interface VideoSendParameters {
  maxBitrate: number
  maxFramerate: number
  priority: RTCPriorityType
  degradationPreference: RTCDegradationPreference | null
}

export const VIDEO_SEND: Record<'cam' | 'screen', VideoSendParameters> = {
  cam: {
    maxBitrate: 800_000,
    maxFramerate: 30,
    priority: 'low',
    // The browser's default for a camera is already `balanced`
    degradationPreference: null,
  },
  screen: {
    maxBitrate: 2_500_000,
    maxFramerate: 30,
    priority: 'high',
    degradationPreference: 'balanced',
  },
}

/** One simulcast layer as it is sent: its rid, scale, bitrate cap, and nominal short side */
export interface SimulcastLayer {
  layer: Layer
  rid: SimulcastRid
  scaleResolutionDownBy: number
  maxBitrate: number
  maxFramerate: number
  /**
   * The layer's short side in pixels for the capture size we ask for (a camera at 1280×720, a
   * screen at most 1920×1080): what a receiver compares its tile against (layers.ts)
   */
  shortSide: number
}

/**
 * The layers per kind, highest first (rids `f`／`h`／`q` = full, half, quarter: Realtime's
 * `asciibetical` ordering treats `f` as the most desirable). The camera is captured at 1280×720
 * (devices.ts CAMERA_CAPTURE): Chrome sends only as many layers as the source is big enough for
 * (VP8 from 640×480: two; from 1280×720: three), so 720p is what makes three layers possible.
 * Bitrates follow libwebrtc's own simulcast ladder for these sizes, the top layer a little under
 * its 2.5 Mbps for 720p (a receiver only asks for it for a big tile). The screen's second layer
 * is for small screens and thin links: half size at a lower frame rate.
 */
export const SIMULCAST: Record<'cam' | 'screen', readonly SimulcastLayer[]> = {
  cam: [
    {
      layer: 'high',
      rid: 'f',
      scaleResolutionDownBy: 1,
      maxBitrate: 1_200_000,
      maxFramerate: 30,
      shortSide: 720,
    },
    {
      layer: 'medium',
      rid: 'h',
      scaleResolutionDownBy: 2,
      maxBitrate: 400_000,
      maxFramerate: 30,
      shortSide: 360,
    },
    {
      layer: 'low',
      rid: 'q',
      scaleResolutionDownBy: 4,
      maxBitrate: 120_000,
      maxFramerate: 15,
      shortSide: 180,
    },
  ],
  screen: [
    {
      layer: 'high',
      rid: 'f',
      scaleResolutionDownBy: 1,
      maxBitrate: 2_500_000,
      maxFramerate: 30,
      shortSide: 1080,
    },
    {
      layer: 'medium',
      rid: 'h',
      scaleResolutionDownBy: 2,
      maxBitrate: 600_000,
      maxFramerate: 15,
      shortSide: 540,
    },
  ],
}

/** addTransceiver's sendEncodings for a simulcast camera or screen, highest layer first */
export function simulcastEncodings(kind: 'cam' | 'screen'): RTCRtpEncodingParameters[] {
  const { priority } = VIDEO_SEND[kind]
  return SIMULCAST[kind].map((layer) => ({
    rid: layer.rid,
    scaleResolutionDownBy: layer.scaleResolutionDownBy,
    maxBitrate: layer.maxBitrate,
    maxFramerate: layer.maxFramerate,
    priority,
    networkPriority: priority,
  }))
}

/** The parameters for a published track of this kind, or null (audio keeps the defaults) */
export function videoSendParameters(kind: TrackKind): VideoSendParameters | null {
  return kind === 'cam' || kind === 'screen' ? VIDEO_SEND[kind] : null
}

/** The one encoding of a single-layer video sender (addTransceiver's sendEncodings) */
export function sendEncoding(params: VideoSendParameters): RTCRtpEncodingParameters {
  return {
    maxBitrate: params.maxBitrate,
    maxFramerate: params.maxFramerate,
    priority: params.priority,
    networkPriority: params.priority,
  }
}

/**
 * Sets the degradation preference once the sender is negotiated. Not every browser has it
 * (Firefox ignores it, older Safari refuses setParameters with unknown fields): a refusal keeps
 * the browser's default, the track is still sent.
 */
export async function applyDegradation(
  sender: RTCRtpSender,
  params: VideoSendParameters,
): Promise<void> {
  if (!params.degradationPreference) return
  if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
    return
  }
  try {
    const current = sender.getParameters()
    await sender.setParameters({
      ...current,
      degradationPreference: params.degradationPreference,
    } as RTCRtpSendParameters)
  } catch {
    // The browser's default stays
  }
}

/**
 * Where the browser's bandwidth estimate starts (kbps). Chrome's default is 300 kbps, so a new
 * camera started at 320×240 and took 13–16 s to reach 640×480 (ADR-001 「編碼參數」); from 1000
 * kbps it sends 640×480 from the first second. Only the starting point: the estimate still
 * follows the SFU's congestion feedback (transport-cc) from there.
 */
export const START_BITRATE_KBPS = 1000

/**
 * The SFU's answer to our publish with `x-google-start-bitrate` on its VP8 payload types. Changed
 * locally before setRemoteDescription: the SFU never sees it (it is the browser's own sender
 * setting, read from the remote description), so Realtime's view of the session is unchanged.
 * Browsers other than Chromium ignore the parameter.
 */
export function withStartBitrate(sdp: string, kbps: number = START_BITRATE_KBPS): string {
  const param = `x-google-start-bitrate=${kbps}`
  // Payload type numbers belong to their media section: look at one section at a time
  const sections = sdp.split(/\r\n(?=m=)/)
  return sections
    .map((section) => {
      const lines = section.split('\r\n')
      const vp8 = new Set(
        lines.flatMap((line) => /^a=rtpmap:(\d+) VP8\/90000/i.exec(line)?.slice(1, 2) ?? []),
      )
      if (vp8.size === 0) return section
      const withFmtp = new Set<string>()
      const updated = lines.map((line) => {
        const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line)
        if (!fmtp || !vp8.has(fmtp[1])) return line
        withFmtp.add(fmtp[1])
        return fmtp[2].includes('x-google-start-bitrate') ? line : `${line};${param}`
      })
      return updated
        .flatMap((line) => {
          const pt = /^a=rtpmap:(\d+) VP8\/90000/i.exec(line)?.[1]
          return pt && !withFmtp.has(pt) ? [line, `a=fmtp:${pt} ${param}`] : [line]
        })
        .join('\r\n')
    })
    .join('\r\n')
}

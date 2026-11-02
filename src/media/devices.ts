// Local devices for the pre-join screen (e4-t03) and the room (e2-t06): the camera and
// microphone through getUserMedia, the device lists through enumerateDevices, the speaker
// through setSinkId. No RTCPeerConnection here: sending media is MediaTransport's job (B1). No
// React and no interface text either: hooks wrap this, components show it with strings.ts.

export type DeviceKind = 'audioinput' | 'videoinput' | 'audiooutput'

export interface DeviceOption {
  deviceId: string
  /** Empty until the page has permission; the screen then shows a numbered fallback */
  label: string
}

export type DeviceLists = Record<DeviceKind, DeviceOption[]>

/**
 * Why a device could not be opened:
 * - `denied`: the person or the browser said no (NotAllowedError, SecurityError)
 * - `notFound`: no such device, or the chosen one is gone (NotFoundError, OverconstrainedError)
 * - `inUse`: another program holds it, or the hardware failed (NotReadableError, AbortError)
 * - `unsupported`: no navigator.mediaDevices (an http: page, or a very old browser)
 * - `lost`: the device stopped in the middle of the call (unplugged) and no other one opened
 * - `unknown`: anything else
 */
export type MediaProblem = 'denied' | 'notFound' | 'inUse' | 'unsupported' | 'lost' | 'unknown'

/** The part of navigator.mediaDevices this module uses, so tests can pass a fake */
export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  enumerateDevices(): Promise<MediaDeviceInfo[]>
  addEventListener?(type: 'devicechange', listener: () => void): void
  removeEventListener?(type: 'devicechange', listener: () => void): void
}

/** navigator.mediaDevices, or null where there is none (insecure origin, old browser) */
export function browserMediaDevices(): MediaDevicesLike | null {
  return (typeof navigator !== 'undefined' && navigator.mediaDevices) || null
}

export const emptyDeviceLists = (): DeviceLists => ({
  audioinput: [],
  videoinput: [],
  audiooutput: [],
})

/** The devices by kind, in the browser's order; entries without an id (no permission yet) are left out */
export async function listDevices(devices: MediaDevicesLike): Promise<DeviceLists> {
  const lists = emptyDeviceLists()
  for (const info of await devices.enumerateDevices()) {
    if (!(info.kind in lists) || info.deviceId === '') continue
    lists[info.kind].push({ deviceId: info.deviceId, label: info.label })
  }
  return lists
}

export function mediaProblem(error: unknown): MediaProblem {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'notFound'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'inUse'
    default:
      return 'unknown'
  }
}

export interface LocalMediaRequest {
  mic: boolean
  cam: boolean
  /** null: the browser's default */
  micId: string | null
  camId: string | null
}

export interface LocalMedia {
  /** Every track that opened (null when none did, or none was asked for) */
  stream: MediaStream | null
  micProblem: MediaProblem | null
  camProblem: MediaProblem | null
}

/**
 * A remembered device is only preferred (`ideal`): when it is gone the browser opens another
 * one instead of failing. A device the person just picked is required (`exact`).
 */
const constraint = (deviceId: string | null, strict = false): MediaTrackConstraints | true =>
  deviceId ? { deviceId: strict ? { exact: deviceId } : { ideal: deviceId } } : true

/** Makes one stream of several tracks; `new MediaStream` in the browser */
export type CreateStream = (tracks: MediaStreamTrack[]) => MediaStream

const browserStream: CreateStream = (tracks) => new MediaStream(tracks)

/**
 * Opens the microphone and camera asked for, in one request (one permission prompt). When that
 * fails for a reason other than a refusal, tries each on its own, so a computer without a camera
 * still gets its microphone.
 */
export async function openLocalMedia(
  devices: MediaDevicesLike | null,
  request: LocalMediaRequest,
  createStream: CreateStream = browserStream,
): Promise<LocalMedia> {
  const none: LocalMedia = { stream: null, micProblem: null, camProblem: null }
  if (!request.mic && !request.cam) return none
  if (!devices) {
    return {
      stream: null,
      micProblem: request.mic ? 'unsupported' : null,
      camProblem: request.cam ? 'unsupported' : null,
    }
  }
  const audio = request.mic ? constraint(request.micId) : false
  const video = request.cam ? constraint(request.camId) : false
  try {
    return { ...none, stream: await devices.getUserMedia({ audio, video }) }
  } catch (error) {
    const problem = mediaProblem(error)
    if (problem === 'denied' || !request.mic || !request.cam) {
      return {
        stream: null,
        micProblem: request.mic ? problem : null,
        camProblem: request.cam ? problem : null,
      }
    }
  }
  const [mic, cam] = await Promise.allSettled([
    devices.getUserMedia({ audio, video: false }),
    devices.getUserMedia({ audio: false, video }),
  ])
  const tracks = [mic, cam].flatMap((result) =>
    result.status === 'fulfilled' ? result.value.getTracks() : [],
  )
  return {
    stream: tracks.length > 0 ? createStream(tracks) : null,
    micProblem: mic.status === 'rejected' ? mediaProblem(mic.reason) : null,
    camProblem: cam.status === 'rejected' ? mediaProblem(cam.reason) : null,
  }
}

export function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

/** The device a stream's first track of that kind is really using (to preselect the menus) */
export function activeDeviceId(stream: MediaStream | null, kind: 'audio' | 'video'): string | null {
  const track = kind === 'audio' ? stream?.getAudioTracks()[0] : stream?.getVideoTracks()[0]
  return track?.getSettings?.().deviceId ?? null
}

/** Thrown by openDevice: why the device could not be opened */
export class MediaOpenError extends Error {
  readonly problem: MediaProblem
  constructor(problem: MediaProblem) {
    super(problem)
    this.name = 'MediaOpenError'
    this.problem = problem
  }
}

/**
 * Opens one microphone or camera on its own (the room's toggles and device menus, e2-t06):
 * `strict` requires that very device, otherwise it is only preferred. Rejects with
 * MediaOpenError.
 */
export async function openDevice(
  devices: MediaDevicesLike | null,
  kind: 'audio' | 'video',
  deviceId: string | null,
  strict = false,
): Promise<MediaStreamTrack> {
  if (!devices) throw new MediaOpenError('unsupported')
  const wanted = constraint(deviceId, strict)
  let stream: MediaStream
  try {
    stream = await devices.getUserMedia(
      kind === 'audio' ? { audio: wanted, video: false } : { audio: false, video: wanted },
    )
  } catch (error) {
    throw new MediaOpenError(mediaProblem(error))
  }
  const track = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0]
  if (!track) {
    stopStream(stream)
    throw new MediaOpenError('notFound')
  }
  return track
}

/** The element the speaker choice applies to (HTMLMediaElement with setSinkId) */
interface SinkElement {
  setSinkId?: (deviceId: string) => Promise<void>
}

/**
 * Plays an <audio> through the chosen speaker where the browser can (canChooseSpeaker in
 * capabilities.ts); null keeps the system default. Failures (the speaker is gone) leave it on the
 * current output.
 */
export function setSpeaker(element: HTMLMediaElement | null, deviceId: string | null): void {
  const sink = element as SinkElement | null
  if (!sink?.setSinkId || deviceId === null) return
  void sink.setSinkId(deviceId).catch(() => undefined)
}

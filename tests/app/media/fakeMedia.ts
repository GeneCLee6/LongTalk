import { vi } from 'vitest'
import type { MediaDevicesLike } from '../../../src/media/devices.ts'

// Stand-ins for getUserMedia and enumerateDevices: jsdom has neither, nor MediaStream.

export class FakeTrack {
  readonly kind: 'audio' | 'video'
  readonly deviceId: string
  stopped = false
  constructor(kind: 'audio' | 'video', deviceId: string) {
    this.kind = kind
    this.deviceId = deviceId
  }
  stop() {
    this.stopped = true
  }
  getSettings() {
    return { deviceId: this.deviceId }
  }
}

export class FakeStream {
  readonly tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video')
  }
}

export const asStream = (stream: FakeStream) => stream as unknown as MediaStream

export const createFakeStream = (tracks: MediaStreamTrack[]) =>
  asStream(new FakeStream(tracks as unknown as FakeTrack[]))

export function mediaError(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

const DEVICES = [
  { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in Microphone' },
  { kind: 'audioinput', deviceId: 'mic-2', label: 'USB Headset' },
  { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime HD Camera' },
  { kind: 'videoinput', deviceId: 'cam-2', label: '' },
  { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers' },
] as const

export interface FakeDevicesOptions {
  /** Fails every request that asks for this kind with this error name */
  fail?: Partial<Record<'audio' | 'video', string>>
  /** Fails everything (a refusal) */
  denyAll?: boolean
  /** No permission yet: enumerateDevices hides ids and labels */
  hidden?: boolean
}

/** A fake navigator.mediaDevices that hands out FakeStreams and records them */
export function fakeMediaDevices(options: FakeDevicesOptions = {}) {
  const streams: FakeStream[] = []
  const listeners = new Set<() => void>()
  let granted = !options.hidden
  const pick = (constraint: boolean | MediaTrackConstraints | undefined, fallback: string) => {
    if (!constraint) return null
    if (constraint === true) return fallback
    const id = (constraint.deviceId as { exact: string }).exact
    return id
  }
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (options.denyAll) throw mediaError('NotAllowedError')
    const audio = pick(constraints.audio, 'mic-1')
    const video = pick(constraints.video, 'cam-1')
    if (audio && options.fail?.audio) throw mediaError(options.fail.audio)
    if (video && options.fail?.video) throw mediaError(options.fail.video)
    granted = true
    const tracks = [
      ...(audio ? [new FakeTrack('audio', audio)] : []),
      ...(video ? [new FakeTrack('video', video)] : []),
    ]
    const stream = new FakeStream(tracks)
    streams.push(stream)
    return asStream(stream)
  })
  const enumerateDevices = vi.fn(
    async () =>
      DEVICES.map((device) =>
        granted ? device : { ...device, deviceId: '', label: '' },
      ) as unknown as MediaDeviceInfo[],
  )
  const devices: MediaDevicesLike = {
    getUserMedia,
    enumerateDevices,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  }
  return {
    devices,
    getUserMedia,
    enumerateDevices,
    streams,
    listeners,
    fireDeviceChange: () => listeners.forEach((listener) => listener()),
  }
}

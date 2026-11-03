import { vi } from 'vitest'
import type { MediaDevicesLike } from '../../../src/media/devices.ts'

// Stand-ins for getUserMedia and enumerateDevices: jsdom has neither, nor MediaStream.

export class FakeTrack {
  readonly kind: 'audio' | 'video'
  readonly deviceId: string
  readonly label: string
  readonly id = `track-${Math.random().toString(36).slice(2)}`
  stopped = false
  enabled = true
  readyState: 'live' | 'ended' = 'live'
  readonly applyConstraints = vi.fn(async () => {})
  #listeners = new Set<() => void>()
  constructor(kind: 'audio' | 'video', deviceId: string, label = '') {
    this.kind = kind
    this.deviceId = deviceId
    this.label = label
  }
  stop() {
    this.stopped = true
    this.readyState = 'ended'
  }
  /** Clones made of this track (the muted-speech analysis, H3) */
  readonly clones: FakeTrack[] = []
  clone(): FakeTrack {
    const copy = new FakeTrack(this.kind, this.deviceId, this.label)
    copy.enabled = this.enabled
    this.clones.push(copy)
    return copy
  }
  getSettings() {
    return { deviceId: this.deviceId }
  }
  addEventListener(type: string, listener: () => void) {
    if (type === 'ended') this.#listeners.add(listener)
  }
  removeEventListener(type: string, listener: () => void) {
    if (type === 'ended') this.#listeners.delete(listener)
  }
  /** The device went away (unplugged): the browser ends the track without stop() */
  end() {
    this.readyState = 'ended'
    this.#listeners.forEach((listener) => listener())
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

type DeviceConstraint = { exact?: string; ideal?: string }

/** A fake navigator.mediaDevices that hands out FakeStreams and records them */
export function fakeMediaDevices(options: FakeDevicesOptions = {}) {
  const streams: FakeStream[] = []
  const listeners = new Set<() => void>()
  const present = new Set<string>(DEVICES.map((device) => device.deviceId))
  let granted = !options.hidden
  /** The device a constraint opens: an `exact` one must be present, an `ideal` one is preferred */
  const pick = (constraint: boolean | MediaTrackConstraints | undefined, kind: string) => {
    if (!constraint) return null
    const available = DEVICES.filter((d) => d.kind === kind && present.has(d.deviceId))
    const wanted = constraint === true ? {} : ((constraint.deviceId as DeviceConstraint) ?? {})
    if (wanted.exact !== undefined) {
      if (!present.has(wanted.exact)) throw mediaError('OverconstrainedError')
      return DEVICES.find((d) => d.deviceId === wanted.exact)!
    }
    const device = available.find((d) => d.deviceId === wanted.ideal) ?? available[0]
    if (!device) throw mediaError('NotFoundError')
    return device
  }
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (options.denyAll) throw mediaError('NotAllowedError')
    if (constraints.audio && options.fail?.audio) throw mediaError(options.fail.audio)
    if (constraints.video && options.fail?.video) throw mediaError(options.fail.video)
    const audio = pick(constraints.audio, 'audioinput')
    const video = pick(constraints.video, 'videoinput')
    granted = true
    const tracks = [
      ...(audio ? [new FakeTrack('audio', audio.deviceId, audio.label)] : []),
      ...(video ? [new FakeTrack('video', video.deviceId, video.label)] : []),
    ]
    const stream = new FakeStream(tracks)
    streams.push(stream)
    return asStream(stream)
  })
  const enumerateDevices = vi.fn(
    async () =>
      DEVICES.filter((device) => present.has(device.deviceId)).map((device) =>
        granted ? device : { ...device, deviceId: '', label: '' },
      ) as unknown as MediaDeviceInfo[],
  )
  const devices: MediaDevicesLike = {
    getUserMedia,
    enumerateDevices,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  }
  const fireDeviceChange = () => listeners.forEach((listener) => listener())
  /** Every track handed out so far, newest last */
  const tracks = () => streams.flatMap((stream) => stream.tracks)
  return {
    devices,
    getUserMedia,
    enumerateDevices,
    streams,
    listeners,
    tracks,
    fireDeviceChange,
    /** The device is unplugged: its live tracks end, it leaves the lists, `devicechange` fires */
    unplug(deviceId: string) {
      present.delete(deviceId)
      for (const track of tracks()) {
        if (track.deviceId === deviceId && track.readyState === 'live') track.end()
      }
      fireDeviceChange()
    },
    plug(deviceId: string) {
      present.add(deviceId)
      fireDeviceChange()
    },
  }
}

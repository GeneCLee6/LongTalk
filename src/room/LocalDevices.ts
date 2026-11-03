import {
  emptyDeviceLists,
  listDevices,
  MediaOpenError,
  openDevice,
  openLocalMedia,
  type CreateStream,
  type DeviceLists,
  type MediaDevicesLike,
  type MediaProblem,
} from '../media/devices.ts'
import type { DeviceChoices } from './session.ts'

// The microphone and camera in the room (e2-t05, e2-t06, e2-t09): turning them on and off,
// switching devices, a device unplugged mid-call, and why one would not open. Only local
// devices: what is sent is RoomMedia's job, which gets `sending()`. No React (useLocalDevices
// wraps it) and no interface text (the room page explains problems with strings.ts).
//
// - The microphone stays open while muted (unmuting is instant); it sends nothing because the
//   room sends null for it. The camera is stopped when turned off, so its light goes out.
// - A device that ends on its own (unplugged) is replaced by another one of the same kind; when
//   there is none the kind turns off with the problem `lost`. A device plugged in later is tried
//   again for a kind that is off with `lost` or `notFound`.
// - A device picked in the menu is required (`exact`); remembered choices are only preferred.

export type LocalKind = 'mic' | 'cam'

export interface LocalDevice {
  /** The person wants it on and it is open */
  on: boolean
  /** The open track (the microphone's stays open while muted) */
  track: MediaStreamTrack | null
  /** Why it is off against the person's wish; null when nothing went wrong */
  problem: MediaProblem | null
  opening: boolean
}

export interface LocalDevicesState {
  /** The first opening finished (whatever its outcome) */
  ready: boolean
  mic: LocalDevice
  cam: LocalDevice
  devices: DeviceLists
  /** The device chosen per menu (null: the browser's default) */
  chosen: DeviceChoices
}

/** Something to tell the person about that is not a lasting problem */
export type DeviceNotice =
  /** Unplugged mid-call, and another device took over */
  | { type: 'switched'; kind: LocalKind; label: string }
  /** A device plugged in after the kind had none */
  | { type: 'recovered'; kind: LocalKind; label: string }
  | { type: 'switchFailed'; kind: LocalKind; problem: MediaProblem }

export interface LocalDevicesOptions {
  mediaDevices: MediaDevicesLike | null
  chosen: DeviceChoices
  /** Remembers a choice (localStorage, shared with the pre-join screen) */
  saveChoice?: (kind: keyof DeviceChoices, deviceId: string, label: string) => void
  onNotice?: (notice: DeviceNotice) => void
  createStream?: CreateStream
  /** Wait before the one quiet retry of a device that failed when the room opened it */
  startRetryMs?: number
}

const off = (): LocalDevice => ({ on: false, track: null, problem: null, opening: false })

const MEDIA_KIND = { mic: 'audio', cam: 'video' } as const
const START_RETRY_MS = 600

export class LocalDevices {
  private readonly mediaDevices: MediaDevicesLike | null
  private readonly options: LocalDevicesOptions
  private state: LocalDevicesState
  private readonly listeners = new Set<() => void>()
  private closed = false
  /** Bumped on every opening per kind, so a slower earlier one is thrown away */
  private readonly generation = { mic: 0, cam: 0 }
  private readonly endedHandlers = new Map<MediaStreamTrack, () => void>()
  private readonly onDeviceChange = () => void this.deviceChanged()
  private readonly startRetryMs: number

  constructor(options: LocalDevicesOptions) {
    this.options = options
    this.mediaDevices = options.mediaDevices
    this.startRetryMs = options.startRetryMs ?? START_RETRY_MS
    this.state = {
      ready: false,
      mic: off(),
      cam: off(),
      devices: emptyDeviceLists(),
      chosen: { ...options.chosen },
    }
  }

  getState = (): LocalDevicesState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** What the room should send: the track of each kind that is on */
  static sending(state: LocalDevicesState): {
    mic: MediaStreamTrack | null
    cam: MediaStreamTrack | null
  } {
    return {
      mic: state.mic.on ? state.mic.track : null,
      cam: state.cam.on ? state.cam.track : null,
    }
  }

  /** Opens what the pre-join screen had on, in one request (one permission prompt). Runs once. */
  async start(wanted: { mic: boolean; cam: boolean }): Promise<void> {
    this.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange)
    const { chosen } = this.state
    const generation = { ...this.generation }
    this.update({
      mic: { ...off(), opening: wanted.mic },
      cam: { ...off(), opening: wanted.cam },
    })
    const media = await openLocalMedia(
      this.mediaDevices,
      { mic: wanted.mic, cam: wanted.cam, micId: chosen.mic, camId: chosen.cam },
      this.options.createStream ?? trackBundle,
    )
    const opened = {
      mic: { track: media.stream?.getAudioTracks()[0] ?? null, problem: media.micProblem },
      cam: { track: media.stream?.getVideoTracks()[0] ?? null, problem: media.camProblem },
    }
    const changes: Partial<LocalDevicesState> = { ready: true }
    for (const kind of ['mic', 'cam'] as const) {
      const { track, problem } = opened[kind]
      // Closed, or the person pressed the button meanwhile: theirs wins
      if (this.closed || this.generation[kind] !== generation[kind]) {
        track?.stop()
        continue
      }
      if (track) this.watch(track)
      changes[kind] = { on: track !== null, track, problem, opening: false }
    }
    if (this.closed) return
    this.update(changes)
    await this.refreshDevices()
    // The pre-join preview released these devices a moment ago; some cameras (and Chrome's fake
    // one) are briefly not found or busy right after. One quiet try more before showing it.
    await Promise.all(
      (['mic', 'cam'] as const).map(async (kind) => {
        const { problem } = this.state[kind]
        if (problem !== 'notFound' && problem !== 'inUse') return
        const before = this.generation[kind]
        await new Promise((resolve) => setTimeout(resolve, this.startRetryMs))
        if (this.closed || this.generation[kind] !== before) return
        await this.open(kind, this.state.chosen[kind], false)
      }),
    )
  }

  /** The toolbar's microphone or camera button */
  async setOn(kind: LocalKind, on: boolean): Promise<void> {
    const device = this.state[kind]
    if (!on) {
      this.generation[kind]++
      if (kind === 'cam') {
        this.release(device.track)
        this.setDevice(kind, off())
      } else {
        if (device.track) device.track.enabled = false
        this.setDevice(kind, { ...device, on: false, problem: null, opening: false })
      }
      return
    }
    if (device.track && device.track.readyState !== 'ended') {
      device.track.enabled = true
      this.setDevice(kind, { ...device, on: true, problem: null })
      return
    }
    await this.open(kind, this.state.chosen[kind], false)
  }

  /** Tries again after a problem (permission granted, the other program closed) */
  async retry(kind: LocalKind): Promise<void> {
    await this.open(kind, this.state.chosen[kind], false)
  }

  /**
   * A device picked in a menu: remembered, and switched to at once when that kind is open. A
   * device that will not open leaves the current one in place (notice `switchFailed`).
   */
  async select(kind: keyof DeviceChoices, deviceId: string): Promise<void> {
    const list =
      this.state.devices[
        kind === 'mic' ? 'audioinput' : kind === 'cam' ? 'videoinput' : 'audiooutput'
      ]
    const label = list.find((option) => option.deviceId === deviceId)?.label ?? ''
    this.options.saveChoice?.(kind, deviceId, label)
    this.update({ chosen: { ...this.state.chosen, [kind]: deviceId } })
    if (kind === 'speaker') return
    const device = this.state[kind]
    if (!device.track || device.track.getSettings?.().deviceId === deviceId) return
    await this.open(kind, deviceId, true)
  }

  /** Stops every track; the object cannot be reused */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange)
    this.release(this.state.mic.track)
    this.release(this.state.cam.track)
    this.listeners.clear()
  }

  /**
   * Opens a device of `kind`. On success it replaces the current track (keeping the microphone
   * muted if it was). On failure: a strict switch keeps the current device and reports a notice;
   * otherwise the kind is off with the problem.
   */
  private async open(kind: LocalKind, deviceId: string | null, strict: boolean): Promise<boolean> {
    if (this.closed) return false
    const generation = ++this.generation[kind]
    const before = this.state[kind]
    this.setDevice(kind, { ...before, opening: true })
    let track: MediaStreamTrack
    try {
      track = await openDevice(this.mediaDevices, MEDIA_KIND[kind], deviceId, strict)
    } catch (error) {
      if (this.closed || generation !== this.generation[kind]) return false
      const problem = error instanceof MediaOpenError ? error.problem : 'unknown'
      const current = this.state[kind]
      if (strict && current.track) {
        this.setDevice(kind, { ...current, opening: false })
        this.options.onNotice?.({ type: 'switchFailed', kind, problem })
      } else {
        this.release(current.track)
        this.setDevice(kind, { on: false, track: null, problem, opening: false })
      }
      return false
    }
    if (this.closed || generation !== this.generation[kind]) {
      track.stop()
      return false
    }
    const current = this.state[kind]
    // A switch keeps the microphone muted; turning on or recovering turns it on
    const on = strict ? current.on : true
    track.enabled = kind === 'cam' || on
    this.watch(track)
    this.release(current.track)
    this.setDevice(kind, { on, track, problem: null, opening: false })
    void this.refreshDevices()
    return true
  }

  private watch(track: MediaStreamTrack): void {
    const handler = () => void this.ended(track)
    this.endedHandlers.set(track, handler)
    track.addEventListener?.('ended', handler)
  }

  private release(track: MediaStreamTrack | null): void {
    if (!track) return
    const handler = this.endedHandlers.get(track)
    if (handler) track.removeEventListener?.('ended', handler)
    this.endedHandlers.delete(track)
    track.stop()
  }

  /** A track ended without us stopping it: its device was unplugged or failed */
  private async ended(track: MediaStreamTrack): Promise<void> {
    if (this.closed) return
    const kind: LocalKind | null =
      this.state.mic.track === track ? 'mic' : this.state.cam.track === track ? 'cam' : null
    if (!kind) return
    const device = this.state[kind]
    this.release(track)
    if (!device.on) {
      // A muted microphone: nothing to recover until it is turned on again
      this.setDevice(kind, { ...device, track: null })
      return
    }
    const recovered = await this.open(kind, null, false)
    if (this.closed) return
    if (recovered) {
      const label = this.state[kind].track?.label ?? ''
      this.options.onNotice?.({ type: 'switched', kind, label })
    } else if (this.state[kind].problem === 'notFound') {
      this.setDevice(kind, { ...this.state[kind], problem: 'lost' })
    }
  }

  /** A device was plugged in or out: fresh lists, and another try for a kind that had none */
  private async deviceChanged(): Promise<void> {
    await this.refreshDevices()
    for (const kind of ['mic', 'cam'] as const) {
      const { problem, opening } = this.state[kind]
      if (opening || (problem !== 'lost' && problem !== 'notFound')) continue
      const has = kind === 'mic' ? this.state.devices.audioinput : this.state.devices.videoinput
      if (has.length === 0) continue
      if (await this.open(kind, this.state.chosen[kind], false)) {
        this.options.onNotice?.({
          type: 'recovered',
          kind,
          label: this.state[kind].track?.label ?? '',
        })
      }
    }
  }

  private async refreshDevices(): Promise<void> {
    if (!this.mediaDevices || this.closed) return
    try {
      const devices = await listDevices(this.mediaDevices)
      if (!this.closed) this.update({ devices })
    } catch {
      // Keep the lists we have
    }
  }

  private setDevice(kind: LocalKind, device: LocalDevice): void {
    this.update({ [kind]: device })
  }

  private update(changes: Partial<LocalDevicesState>): void {
    this.state = { ...this.state, ...changes }
    for (const listener of this.listeners) listener()
  }
}

/**
 * Only the tracks are kept, so when the microphone and camera open separately they need not be
 * put into a real MediaStream
 */
const trackBundle: CreateStream = (tracks) =>
  ({
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  }) as unknown as MediaStream

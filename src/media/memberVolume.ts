// How loud one person plays on this computer (e6-t08, AC-6.6; PRD: 0–200%): local only, nobody else
// hears the difference. Each person keeps their own <audio> (MemberAudio), and:
//
// - 0–100%: `<audio>.volume`, nothing else. No Web Audio, so no autoplay question and no way for
//   this to cut anyone off. The usual case.
// - Above 100% an element cannot go, so the track goes through a GainNode whose output the same
//   element plays (a MediaStreamDestination): setSinkId keeps working, because it is still that
//   element that plays. Only people boosted touch Web Audio. Until the context runs (no gesture
//   yet, after a reload) they stay on the direct path at 100%: quieter than asked, never silent.
// - Where `<audio>.volume` is read-only (iPhone, iPad; capabilities.ts canSetMemberVolume) there is
//   no slider: a Web Audio route there takes over the phone's audio session and stops with it,
//   which is not worth risking the sound of the whole call.
import { browserAudioContext, type AudioContextLike } from './levelMeter.ts'

export const VOLUME_MIN = 0
export const VOLUME_MAX = 200
export const VOLUME_STEP = 5
export const VOLUME_DEFAULT = 100

export function clampVolume(percent: number): number {
  if (!Number.isFinite(percent)) return VOLUME_DEFAULT
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(percent)))
}

/** What a volume means: the element's own volume, and the gain above it (null: no Web Audio) */
export function volumeRouting(percent: number): { element: number; gain: number | null } {
  const volume = clampVolume(percent)
  return volume <= 100 ? { element: volume / 100, gain: null } : { element: 1, gain: volume / 100 }
}

/** The bits of AudioContext a boost needs on top of the level meter's, so tests can pass a fake */
export interface BoostContext extends AudioContextLike {
  createGain(): { gain: { value: number }; connect(node: unknown): unknown; disconnect(): void }
  createMediaStreamDestination(): { stream: MediaStream }
}

export interface BoostRoute {
  /** What the person's <audio> plays instead of their track */
  stream: MediaStream
  setGain(gain: number): void
  close(): void
}

export interface BoostEnv {
  createContext: () => BoostContext | null
  /** Chromium only pulls a remote track for Web Audio while a media element plays it too */
  keepAlive: (track: MediaStreamTrack) => () => void
  /** Called when the next user gesture happens (a context may only start from one) */
  onGesture: (callback: () => void) => () => void
}

const browserEnv: BoostEnv = {
  createContext: () => browserAudioContext() as BoostContext | null,
  keepAlive(track) {
    const element = new Audio()
    element.muted = true
    element.srcObject = new MediaStream([track])
    void element.play().catch(() => undefined)
    return () => {
      element.srcObject = null
    }
  },
  onGesture(callback) {
    window.addEventListener('pointerdown', callback)
    window.addEventListener('keydown', callback)
    return () => {
      window.removeEventListener('pointerdown', callback)
      window.removeEventListener('keydown', callback)
    }
  },
}

/** The one context every boosted person shares; closed when the last one goes */
export class VolumeBooster {
  private context: BoostContext | null = null
  private users = 0
  private readonly env: BoostEnv

  constructor(env: BoostEnv = browserEnv) {
    this.env = env
  }

  /**
   * Calls `ready` with a route for `track` once the context runs (at once when it does). Returns
   * the undo: closes the route, or stops waiting for one.
   */
  route(track: MediaStreamTrack, gain: number, ready: (route: BoostRoute) => void): () => void {
    const context = (this.context ??= this.env.createContext())
    if (!context) return () => {}
    this.users += 1
    let route: BoostRoute | null = null
    let stopWaiting: (() => void) | null = null
    let done = false
    const build = () => {
      if (done || route || context.state !== 'running') return
      stopWaiting?.()
      stopWaiting = null
      route = this.build(context, track, gain)
      ready(route)
    }
    const resume = () => void context.resume?.().then(build, () => undefined)
    if (context.state === 'running') build()
    else {
      stopWaiting = this.env.onGesture(resume)
      resume()
    }
    return () => {
      done = true
      stopWaiting?.()
      route?.close()
      this.users -= 1
      if (this.users === 0) {
        void this.context?.close().catch(() => undefined)
        this.context = null
      }
    }
  }

  private build(context: BoostContext, track: MediaStreamTrack, gain: number): BoostRoute {
    const release = this.env.keepAlive(track)
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const node = context.createGain()
    node.gain.value = gain
    const destination = context.createMediaStreamDestination()
    source.connect(node)
    node.connect(destination)
    return {
      stream: destination.stream,
      setGain(value) {
        node.gain.value = value
      },
      close() {
        source.disconnect()
        node.disconnect()
        release()
      },
    }
  }
}

let shared: VolumeBooster | null = null

/** The page's one booster */
export function volumeBooster(): VolumeBooster {
  shared ??= new VolumeBooster()
  return shared
}

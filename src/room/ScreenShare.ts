import type { ClientMessage, ErrorCode, ShareInfo } from '../../shared/protocol.ts'
import {
  capturedSurface,
  type CaptureResult,
  type CapturedSurface,
  type ShareProblem,
} from '../media/share.ts'
import type { ShareMode } from '../media/shareMode.ts'

// This member's side of the room's screen shares (e3-t02, e3-t03; several members at once from
// H5, e3-t07). RoomDO decides who shares (CLAUDE.md rule 1); this only asks, follows what the
// room says, and keeps the captured screen in step with it:
//
// 1. Share pressed: the browser's picker (`picking`; it must open in the click).
// 2. `share` to the room (`claiming`); the screen is published (RoomMedia) only once the room
//    lists our share (`sharing`). `share_full` (MAX_SHARES members already share) and
//    `audio_only` stop, with a notice. Nobody's share is ever taken over.
// 3. Stopping: the 你正在分享 bar, the toolbar, and the browser's own "stop sharing" (the track
//    ends) all end up in stop(): `unshare` and the capture stops. Losing the share (the host
//    stopped it) stops the capture too, with a notice.
// 4. 換一個畫面 (e3-t09): repick() opens the picker again while sharing; what is picked replaces
//    the screen (and its sound) without ending the share; closing the picker keeps the old one.
//
// A share the room still lists for us when we have no screen (a reload while sharing) is ended.
//
// The share's sound (e3-t04): when the picker handed back the tab's or system's audio, it goes
// with the screen (`audio`) and the sharer turns it off and on from the sharing bar (`audioOn`,
// sent or not by RoomMedia, which tells the room it is muted like a microphone). It stops with
// the screen, on every way the share ends.
//
// The mode (e3-t06): 文字 or 動態, chosen on the sharing bar (`mode`, kept for the next share while
// in the room); RoomMedia applies it. `motionHint`: the screen moves too much for 文字 (the page's
// sampler says so, noticeMotion), shown once per screen picked.
//
// Where the camera has to go off first (Safari, as a precaution: ShareCameraGuard.ts), step 2 waits
// for `prepare` (`preparing`), which comes after the picker so that closing the picker changes
// nothing; `released` says the share is over, whichever way it ended, except on leaving the room.
//
// No React here: useScreenShare wraps it.

/**
 * - `idle`: not sharing
 * - `picking`: the browser's picker is open
 * - `preparing`: picked; `prepare` runs before the room is asked (only with `prepare`)
 * - `claiming`: picked; waiting for the room to list our share
 * - `sharing`: the room lists our share; the screen is published
 */
export type SharePhase = 'idle' | 'picking' | 'preparing' | 'claiming' | 'sharing'

export interface ScreenShareState {
  phase: SharePhase
  /** The captured screen, from `preparing` on */
  track: MediaStreamTrack | null
  /** The screen's sound (tab or system audio), when the picker gave any (e3-t04) */
  audio: MediaStreamTrack | null
  /** Whether the sound is sent now (the sharing bar's switch); on when sharing starts */
  audioOn: boolean
  /** What the screen is (a tab, a window, a whole screen), for the presenter view and e3-t09 */
  surface: CapturedSurface | null
  /** 文字 or 動態 (e3-t06) */
  mode: ShareMode
  /** The screen keeps moving while in 文字: suggest 動態 (e3-t06) */
  motionHint: boolean
  /** The picker is open again to change what is shared (換一個畫面) */
  repicking: boolean
}

export type ShareNotice =
  /** The picker failed for a reason worth saying (closing it is not one) */
  | { type: 'problem'; problem: Exclude<ShareProblem, 'cancelled'> }
  /** The room ended our share (the host, from F1) */
  | { type: 'stopped' }
  /** The month is audio-only: no screen either */
  | { type: 'audioOnly' }
  /** MAX_SHARES members already share (H5) */
  | { type: 'full' }

export interface ScreenShareOptions {
  /** Opens the browser's picker (src/media/share.ts captureScreen) */
  capture: () => Promise<CaptureResult>
  /** Sends a message to the room */
  send: (message: ClientMessage) => void
  notify: (notice: ShareNotice) => void
  /** The mode to start in; 文字 without it */
  mode?: ShareMode
  /** Runs once a screen is picked, before the room is asked for the share; must not reject */
  prepare?: () => Promise<void>
  /** A share past the picker ended, however it ended; not called on leaving the room */
  released?: () => void
}

export const idleShare: ScreenShareState = {
  phase: 'idle',
  track: null,
  audio: null,
  audioOn: true,
  surface: null,
  mode: 'text',
  motionHint: false,
  repicking: false,
}

export class ScreenShare {
  private readonly options: ScreenShareOptions
  private state: ScreenShareState
  private readonly listeners = new Set<() => void>()
  private ours: ShareInfo | null = null
  /** The share (its `since`) we last sent `unshare` for, so it is not sent on every patch */
  private unsharedSince: number | null = null
  /** The motion hint was shown (or answered) for the screen shared now */
  private hinted = false
  private closed = false

  constructor(options: ScreenShareOptions) {
    this.options = options
    this.state = { ...idleShare, mode: options.mode ?? 'text' }
  }

  getState = (): ScreenShareState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Share pressed: opens the picker */
  request(): Promise<void> {
    if (this.closed || this.state.phase !== 'idle') return Promise.resolve()
    return this.pick()
  }

  /** Stop sharing (the bar, the toolbar, or the browser ended the capture) */
  stop = (): void => {
    const { phase } = this.state
    if (phase === 'claiming' || phase === 'sharing') {
      this.options.send({ t: 'unshare' })
      if (this.ours) this.unsharedSince = this.ours.since
    }
    if (phase !== 'idle' && phase !== 'picking') this.release()
  }

  /** The sharing bar's switch: send the share's sound, or not (e3-t04) */
  toggleAudio = (): void => {
    if (this.closed || !this.state.audio) return
    this.update({ ...this.state, audioOn: !this.state.audioOn })
  }

  /** 文字 or 動態 (e3-t06): applied live by RoomMedia, kept for the next share */
  setMode = (mode: ShareMode): void => {
    if (this.closed || mode === this.state.mode) return
    // Choosing either answers the hint
    if (this.state.motionHint) this.hinted = true
    this.update({ ...this.state, mode, motionHint: false })
  }

  /** The page's sampler: the screen keeps moving (true) or calmed down (e3-t06) */
  noticeMotion = (moving: boolean): void => {
    const { phase, mode, motionHint } = this.state
    const show = moving && phase === 'sharing' && mode === 'text' && !this.hinted
    if (show === motionHint) return
    // Shown once: hidden when it calms down, and not shown again for this screen
    if (motionHint) this.hinted = true
    this.update({ ...this.state, motionHint: show })
  }

  /** The hint's 「不用」: not shown again for this screen */
  dismissMotionHint = (): void => {
    if (!this.state.motionHint) return
    this.hinted = true
    this.update({ ...this.state, motionHint: false })
  }

  /**
   * 換一個畫面 (e3-t09): the picker again while sharing; what is picked replaces the screen and
   * its sound, the share goes on. Closing the picker keeps what is shared.
   */
  async repick(): Promise<void> {
    if (this.closed || this.state.repicking) return
    if (this.state.phase !== 'sharing' && this.state.phase !== 'claiming') return
    this.update({ ...this.state, repicking: true })
    const result = await this.options.capture()
    const { phase } = this.state
    if (this.closed || (phase !== 'sharing' && phase !== 'claiming')) {
      // Left or stopped while the picker was open
      if (result.ok) {
        result.track.stop()
        result.audio?.stop()
      }
      if (!this.closed && this.state.repicking) this.update({ ...this.state, repicking: false })
      return
    }
    if (!result.ok) {
      this.update({ ...this.state, repicking: false })
      if (result.problem !== 'cancelled') {
        this.options.notify({ type: 'problem', problem: result.problem })
      }
      return
    }
    this.releaseCapture()
    this.listen(result.track, result.audio)
    this.hinted = false
    this.update({
      ...this.state,
      track: result.track,
      audio: result.audio,
      audioOn: true,
      surface: capturedSurface(result.track),
      motionHint: false,
      repicking: false,
    })
  }

  /** The room view's shares and our member id, on every change */
  setRoom(shares: Readonly<Record<string, ShareInfo>> | undefined, you: string | null): void {
    this.ours = (you !== null && shares?.[you]) || null
    this.evaluate()
  }

  /** The room refused our `share` */
  refused(code: ErrorCode): void {
    if (this.state.phase !== 'claiming') return
    if (code === 'share_full') {
      this.release()
      this.options.notify({ type: 'full' })
    } else if (code === 'audio_only') {
      this.release()
      this.options.notify({ type: 'audioOnly' })
    }
  }

  /** The room welcomed us again: a claim the dropped socket may have lost is sent again */
  rejoined(): void {
    if (this.state.phase === 'claiming') this.options.send({ t: 'share' })
  }

  /** Leaving the room: the capture stops (the room ends the share with the member) */
  close(): void {
    this.closed = true
    this.release()
    this.listeners.clear()
  }

  private async pick(): Promise<void> {
    this.update({ ...this.idle(), phase: 'picking' })
    const result = await this.options.capture()
    if (this.closed) {
      if (result.ok) {
        result.track.stop()
        result.audio?.stop()
      }
      return
    }
    if (!result.ok) {
      this.update(this.idle())
      if (result.problem !== 'cancelled') {
        this.options.notify({ type: 'problem', problem: result.problem })
      }
      return
    }
    this.listen(result.track, result.audio)
    this.hinted = false
    const { prepare } = this.options
    this.update({
      ...this.idle(),
      phase: prepare ? 'preparing' : 'claiming',
      track: result.track,
      audio: result.audio,
      surface: capturedSurface(result.track),
    })
    if (prepare) {
      await prepare()
      // Stopped meanwhile (the browser's stop button, leaving the room): nothing to ask for
      if (this.closed || this.state.track !== result.track) return
      this.update({ ...this.state, phase: 'claiming' })
    }
    this.options.send({ t: 'share' })
    this.evaluate()
  }

  /** The browser's own "stop sharing" button ends the track; the sound may end on its own */
  private listen(track: MediaStreamTrack, audio: MediaStreamTrack | null): void {
    track.addEventListener('ended', this.stop)
    audio?.addEventListener('ended', this.audioEnded)
  }

  /** The sound ended on its own (its source went away): the screen goes on without it */
  private readonly audioEnded = (): void => {
    if (this.state.audio) this.update({ ...this.state, audio: null })
  }

  /** Brings our phase in line with whether the room lists our share */
  private evaluate(): void {
    const { phase } = this.state
    if (this.ours) {
      if (phase === 'claiming') this.update({ ...this.state, phase: 'sharing' })
      else if (
        (phase === 'idle' || phase === 'picking') &&
        this.unsharedSince !== this.ours.since
      ) {
        // Listed as sharing without a screen: left over from before a reload
        this.unsharedSince = this.ours.since
        this.options.send({ t: 'unshare' })
      }
      return
    }
    if (phase === 'sharing') {
      this.release()
      this.options.notify({ type: 'stopped' })
    }
  }

  /** Idle, keeping the mode chosen */
  private idle(): ScreenShareState {
    return { ...idleShare, mode: this.state.mode }
  }

  /** Stops the captured screen and its sound */
  private releaseCapture(): void {
    const { track, audio } = this.state
    if (track) {
      track.removeEventListener('ended', this.stop)
      track.stop()
    }
    if (audio) {
      audio.removeEventListener('ended', this.audioEnded)
      audio.stop()
    }
  }

  /** Stops the capture and goes idle */
  private release(): void {
    this.releaseCapture()
    const { phase, track, audio, repicking } = this.state
    if (phase !== 'idle' || track || audio || repicking) this.update(this.idle())
    if (!this.closed && (phase === 'preparing' || phase === 'claiming' || phase === 'sharing')) {
      this.options.released?.()
    }
  }

  private update(state: ScreenShareState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

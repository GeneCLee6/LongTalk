import type { ClientMessage, ErrorCode, ShareInfo } from '../../shared/protocol.ts'
import type { CaptureResult, ShareProblem } from '../media/share.ts'

// This member's side of the room's one screen share (e3-t02, e3-t03). RoomDO decides who shares
// (CLAUDE.md rule 1); this only asks, follows what the room says, and keeps the captured screen
// in step with it:
//
// 1. Share pressed: when someone else shares, ask first (`confirm`) whether to take over.
// 2. The browser's picker (`picking`; it must open in the click, hence after the question).
// 3. `share` to the room (`claiming`); the screen is published (RoomMedia) only once the room
//    names us the sharer (`sharing`). `share_busy` (someone started first) asks again with the
//    screen already picked; `audio_only` stops.
// 4. Stopping: the 你正在分享 bar, the toolbar, and the browser's own "stop sharing" (the track
//    ends) all end up in stop(): `unshare` and the capture stops. Losing the share (someone took
//    over, the host stopped it) stops the capture too, with a notice.
//
// A share the room still lists for us when we have no screen (a reload while sharing) is ended.
//
// The share's sound (e3-t04): when the picker handed back the tab's or system's audio, it goes
// with the screen (`audio`) and the sharer turns it off and on from the sharing bar (`audioOn`,
// sent or not by RoomMedia, which tells the room it is muted like a microphone). It stops with
// the screen, on every way the share ends.
//
// No React here: useScreenShare wraps it.

/**
 * - `idle`: not sharing
 * - `confirm`: asking whether to take over from the member who shares (with the screen already
 *   picked when the room said `share_busy`)
 * - `picking`: the browser's picker is open
 * - `claiming`: picked; waiting for the room to name us the sharer
 * - `sharing`: the room lists us as the sharer; the screen is published
 */
export type SharePhase = 'idle' | 'confirm' | 'picking' | 'claiming' | 'sharing'

export interface ScreenShareState {
  phase: SharePhase
  /** The captured screen, while claiming, confirming a take-over or sharing */
  track: MediaStreamTrack | null
  /** The screen's sound (tab or system audio), when the picker gave any (e3-t04) */
  audio: MediaStreamTrack | null
  /** Whether the sound is sent now (the sharing bar's switch); on when sharing starts */
  audioOn: boolean
}

export type ShareNotice =
  /** The picker failed for a reason worth saying (closing it is not one) */
  | { type: 'problem'; problem: Exclude<ShareProblem, 'cancelled'> }
  /** Someone else took over the share */
  | { type: 'takenOver'; by: string }
  /** The room ended our share (the host, from F1) */
  | { type: 'stopped' }
  /** The month is audio-only: no screen either */
  | { type: 'audioOnly' }

export interface ScreenShareOptions {
  /** Opens the browser's picker (src/media/share.ts captureScreen) */
  capture: () => Promise<CaptureResult>
  /** Sends a message to the room */
  send: (message: ClientMessage) => void
  notify: (notice: ShareNotice) => void
}

export const idleShare: ScreenShareState = {
  phase: 'idle',
  track: null,
  audio: null,
  audioOn: true,
}

export class ScreenShare {
  private readonly options: ScreenShareOptions
  private state: ScreenShareState = idleShare
  private readonly listeners = new Set<() => void>()
  private you: string | null = null
  private share: ShareInfo | null = null
  /** The takeOver of the last `share` sent, to send it again after a reconnect */
  private takeOver = false
  /** The share (its `since`) we last sent `unshare` for, so it is not sent on every patch */
  private unsharedSince: number | null = null
  private closed = false

  constructor(options: ScreenShareOptions) {
    this.options = options
  }

  getState = (): ScreenShareState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Share pressed: asks first when someone else shares, else opens the picker */
  request(): Promise<void> {
    if (this.closed || this.state.phase !== 'idle') return Promise.resolve()
    if (this.share && this.share.memberId !== this.you) {
      this.update({ ...idleShare, phase: 'confirm' })
      return Promise.resolve()
    }
    return this.pick(false)
  }

  /** Take over: yes. Opens the picker, or claims with the screen already picked */
  confirm(): Promise<void> {
    if (this.closed || this.state.phase !== 'confirm') return Promise.resolve()
    if (!this.state.track) return this.pick(true)
    this.claim(true)
    return Promise.resolve()
  }

  /** Take over: no */
  cancel(): void {
    if (this.state.phase === 'confirm') this.release()
  }

  /** Stop sharing (the bar, the toolbar, or the browser ended the capture) */
  stop = (): void => {
    const { phase } = this.state
    if (phase === 'claiming' || phase === 'sharing') {
      this.options.send({ t: 'unshare' })
      if (this.share?.memberId === this.you) this.unsharedSince = this.share?.since ?? null
    }
    if (phase !== 'idle' && phase !== 'picking') this.release()
  }

  /** The sharing bar's switch: send the share's sound, or not (e3-t04) */
  toggleAudio = (): void => {
    if (this.closed || !this.state.audio) return
    this.update({ ...this.state, audioOn: !this.state.audioOn })
  }

  /** The room view's share and our member id, on every change */
  setRoom(share: ShareInfo | null, you: string | null): void {
    this.share = share
    this.you = you
    this.evaluate()
  }

  /** The room refused our `share` */
  refused(code: ErrorCode): void {
    if (this.state.phase !== 'claiming') return
    if (code === 'share_busy') {
      // Someone started sharing between our press and our claim: ask, keeping what was picked
      this.update({ ...this.state, phase: 'confirm' })
    } else if (code === 'audio_only') {
      this.release()
      this.options.notify({ type: 'audioOnly' })
    }
  }

  /** The room welcomed us again: a claim the dropped socket may have lost is sent again */
  rejoined(): void {
    if (this.state.phase === 'claiming') this.options.send({ t: 'share', takeOver: this.takeOver })
  }

  /** Leaving the room: the capture stops (the room ends the share with the member) */
  close(): void {
    this.closed = true
    this.release()
    this.listeners.clear()
  }

  private async pick(takeOver: boolean): Promise<void> {
    this.update({ ...idleShare, phase: 'picking' })
    const result = await this.options.capture()
    if (this.closed) {
      if (result.ok) {
        result.track.stop()
        result.audio?.stop()
      }
      return
    }
    if (!result.ok) {
      this.update(idleShare)
      if (result.problem !== 'cancelled') {
        this.options.notify({ type: 'problem', problem: result.problem })
      }
      return
    }
    // The browser's own "stop sharing" button ends the track
    result.track.addEventListener('ended', this.stop)
    result.audio?.addEventListener('ended', this.audioEnded)
    this.update({ ...idleShare, phase: 'picking', track: result.track, audio: result.audio })
    this.claim(takeOver)
  }

  /** The sound ended on its own (its source went away): the screen goes on without it */
  private readonly audioEnded = (): void => {
    if (this.state.audio) this.update({ ...this.state, audio: null })
  }

  /** Asks the room for the share, with what was picked */
  private claim(takeOver: boolean): void {
    this.takeOver = takeOver
    this.update({ ...this.state, phase: 'claiming' })
    this.options.send({ t: 'share', takeOver })
    this.evaluate()
  }

  /** Brings our phase in line with who the room says shares */
  private evaluate(): void {
    const { phase } = this.state
    const ours = this.share !== null && this.you !== null && this.share.memberId === this.you
    if (ours) {
      if (phase === 'claiming') this.update({ ...this.state, phase: 'sharing' })
      else if (
        (phase === 'idle' || phase === 'picking') &&
        this.unsharedSince !== this.share!.since
      ) {
        // Listed as sharing without a screen: left over from before a reload
        this.unsharedSince = this.share!.since
        this.options.send({ t: 'unshare' })
      }
      return
    }
    if (phase === 'sharing') {
      const by = this.share?.memberId ?? null
      this.release()
      this.options.notify(by ? { type: 'takenOver', by } : { type: 'stopped' })
    }
  }

  /** Stops the capture and goes idle */
  private release(): void {
    const { track, audio } = this.state
    if (track) {
      track.removeEventListener('ended', this.stop)
      track.stop()
    }
    if (audio) {
      audio.removeEventListener('ended', this.audioEnded)
      audio.stop()
    }
    if (this.state !== idleShare) this.update(idleShare)
  }

  private update(state: ScreenShareState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

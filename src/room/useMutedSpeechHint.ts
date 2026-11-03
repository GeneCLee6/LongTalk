import { useEffect, useRef, useState } from 'react'
import {
  attachLevelMeter,
  browserAudioContext,
  type AudioContextLike,
  type LevelMeter,
} from '../media/levelMeter.ts'
import {
  nextMutedSpeech,
  NO_MUTED_SPEECH,
  PUSH_TO_TALK_GRACE_MS,
  type MutedSpeechState,
} from '../media/mutedSpeech.ts'
import { SPEAKING_INTERVAL_MS } from '../media/speaking.ts'

// The speaking-while-muted hint (e6-t03, AC-6.3), on top of media/mutedSpeech.ts.
//
// Privacy: nothing is sent while muted. Muting turns the microphone track off (enabled = false)
// and the room sends null on its sender (LocalDevices.sending → RoomMedia → replaceTrack(null)),
// so the SFU gets no audio at all. A disabled track also reads as silence, so to hear the
// person locally this hook takes a clone of the track (same microphone, its own enabled flag)
// into a Web Audio analyser that is connected to nothing else: the clone is never handed to
// RoomMedia or the transport, and it is stopped as soon as the microphone is unmuted or the
// room is left.

/** How long the hint stays up when nobody answers it */
export const MUTED_HINT_SHOW_MS = 8_000

export interface MutedSpeechHintInput {
  /** The local microphone track (open while muted, LocalDevices) */
  track: MediaStreamTrack | null
  muted: boolean
  /** Push-to-talk is held (G4) */
  pushToTalk: boolean
  /** No hint at all (the room is not open yet) */
  disabled?: boolean
}

export interface MutedSpeechHintDeps {
  /** A level meter on the analysis clone; the browser's Web Audio without it */
  createMeter?: (track: MediaStreamTrack) => LevelMeter | null
  now?: () => number
  intervalMs?: number
  hidden?: () => boolean
}

export interface MutedSpeechHint {
  hint: boolean
  dismiss: () => void
}

/** A meter on its own AudioContext, resumed on the first click or key if it started suspended */
function browserMeter(track: MediaStreamTrack): LevelMeter | null {
  if (typeof MediaStream === 'undefined') return null
  const context: AudioContextLike | null = browserAudioContext()
  if (!context) return null
  const meter = attachLevelMeter(context, new MediaStream([track]))
  const unlock = () => void context.resume?.().catch(() => {})
  const suspended = context.state === 'suspended' && typeof window !== 'undefined'
  if (suspended) {
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  }
  return {
    read: meter.read,
    close() {
      if (suspended) {
        window.removeEventListener('pointerdown', unlock)
        window.removeEventListener('keydown', unlock)
      }
      meter.close()
      void context.close().catch(() => {})
    },
  }
}

const pageHidden = () => typeof document !== 'undefined' && document.hidden

export function useMutedSpeechHint(
  { track, muted, pushToTalk, disabled = false }: MutedSpeechHintInput,
  deps: MutedSpeechHintDeps = {},
): MutedSpeechHint {
  const [hint, setHint] = useState(false)
  const [options] = useState(() => ({
    createMeter: deps.createMeter ?? browserMeter,
    now: deps.now ?? (() => performance.now()),
    intervalMs: deps.intervalMs ?? SPEAKING_INTERVAL_MS,
    hidden: deps.hidden ?? pageHidden,
  }))
  // Kept across mutes, so the cooldown holds when someone unmutes and mutes again
  const detector = useRef<MutedSpeechState>(NO_MUTED_SPEECH)
  const pushing = useRef(pushToTalk)

  // Pressing or letting go of push-to-talk: quiet for a moment (the end of the sentence)
  useEffect(() => {
    if (pushing.current === pushToTalk) return
    pushing.current = pushToTalk
    const until = options.now() + PUSH_TO_TALK_GRACE_MS
    detector.current = {
      ...detector.current,
      since: null,
      lastLoud: null,
      quietUntil: Math.max(detector.current.quietUntil, until),
    }
  }, [pushToTalk, options])

  const listening = muted && !disabled && track !== null && track.readyState !== 'ended'
  useEffect(() => {
    if (!listening || !track || typeof track.clone !== 'function') return
    // The analysis clone: never sent (see the top of this file)
    const clone = track.clone()
    clone.enabled = true
    const meter = options.createMeter(clone)
    const timer = setInterval(() => {
      if (options.hidden()) return
      const next = nextMutedSpeech(detector.current, {
        level: meter?.read() ?? 0,
        now: options.now(),
        muted: true,
        pushToTalk: pushing.current,
      })
      detector.current = next.state
      if (next.hint) setHint(true)
    }, options.intervalMs)
    return () => {
      clearInterval(timer)
      meter?.close()
      clone.stop()
      detector.current = { ...detector.current, since: null, lastLoud: null }
    }
  }, [listening, track, options])

  // Unmuted (by the hint or otherwise): the hint goes. Adjusted while rendering (React's pattern
  // for state that follows a value), so it is not there again at the next mute
  if (hint && !listening) setHint(false)
  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(false), MUTED_HINT_SHOW_MS)
    return () => clearTimeout(timer)
  }, [hint])

  return { hint: hint && listening, dismiss: () => setHint(false) }
}

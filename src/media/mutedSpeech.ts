// Speaking while muted (e6-t03, AC-6.3): Zoom's 「你目前是靜音」. While the microphone is muted
// its level is still read locally (useMutedSpeechHint: a clone of the track into an analyser,
// nothing sent), and speech that lasts MUTED_SPEECH_MS brings up the hint with a one-tap unmute.
// Short pauses between words (up to MUTED_SPEECH_GAP_MS) keep counting; a longer silence starts
// over. After a hint none comes again for MUTED_HINT_COOLDOWN_MS, so it does not nag someone
// muted on purpose (talking to someone in the room). Never while push-to-talk is held (the
// microphone is on then), nor for PUSH_TO_TALK_GRACE_MS after it is let go (the end of the
// sentence). Pure: the hook feeds it levels and the clock.
import { SPEAKING_THRESHOLD } from './speaking.ts'

export const MUTED_SPEECH_MS = 2_000
export const MUTED_SPEECH_GAP_MS = 400
export const MUTED_HINT_COOLDOWN_MS = 30_000
export const PUSH_TO_TALK_GRACE_MS = 1_500

export interface MutedSpeechState {
  /** When the current stretch of speech started; null in silence */
  since: number | null
  /** The last reading at or above the threshold */
  lastLoud: number | null
  /** No hint before this (after a hint, or push-to-talk) */
  quietUntil: number
}

export const NO_MUTED_SPEECH: MutedSpeechState = { since: null, lastLoud: null, quietUntil: 0 }

export interface MutedSpeechInput {
  /** The microphone's level, 0–1 (levelMeter.ts) */
  level: number
  now: number
  muted: boolean
  /** Push-to-talk is held (G4) */
  pushToTalk: boolean
}

/** The next state for one reading, and whether the hint should show now */
export function nextMutedSpeech(
  state: MutedSpeechState,
  { level, now, muted, pushToTalk }: MutedSpeechInput,
): { state: MutedSpeechState; hint: boolean } {
  if (pushToTalk) {
    return {
      state: { since: null, lastLoud: null, quietUntil: now + PUSH_TO_TALK_GRACE_MS },
      hint: false,
    }
  }
  if (!muted) return { state: { ...state, since: null, lastLoud: null }, hint: false }
  if (level < SPEAKING_THRESHOLD) {
    const gapOver = state.lastLoud === null || now - state.lastLoud > MUTED_SPEECH_GAP_MS
    return { state: gapOver ? { ...state, since: null, lastLoud: null } : state, hint: false }
  }
  const since = state.since ?? now
  if (now - since >= MUTED_SPEECH_MS && now >= state.quietUntil) {
    return {
      state: { since: null, lastLoud: null, quietUntil: now + MUTED_HINT_COOLDOWN_MS },
      hint: true,
    }
  }
  return { state: { ...state, since, lastLoud: now }, hint: false }
}

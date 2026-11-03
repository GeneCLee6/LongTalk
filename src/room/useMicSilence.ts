import { useEffect, useState } from 'react'

/** Below this the meter counts as not moving (0–1, as useMicLevel reports it) */
export const SILENCE_LEVEL = 0.02
/** How long the meter must stay still before the pre-join screen says so */
export const SILENCE_MS = 6_000

/**
 * Whether an open microphone has heard nothing for SILENCE_MS (G1, e4-t09): the pre-join screen
 * then suggests speaking or picking another microphone. Any sound resets it.
 */
export function useMicSilence(level: number, listening: boolean, ms = SILENCE_MS): boolean {
  const quiet = listening && level < SILENCE_LEVEL
  const [silent, setSilent] = useState(false)
  // A sound (or the microphone going off) starts the wait over: adjusted while rendering
  const [wasQuiet, setWasQuiet] = useState(quiet)
  if (quiet !== wasQuiet) {
    setWasQuiet(quiet)
    if (!quiet) setSilent(false)
  }
  useEffect(() => {
    if (!quiet) return
    const timer = setTimeout(() => setSilent(true), ms)
    return () => clearTimeout(timer)
  }, [quiet, ms])
  return quiet && silent
}

import { useEffect, useState } from 'react'
import { holdSpeaker, SPEAKER_SWITCH_MS, type HeldSpeaker } from '../../shared/layout.ts'

/**
 * The speaker layout's big tile with hysteresis (G2, e4-t10): `wanted` (pickSpeaker's answer)
 * takes it once whoever has it held it for `holdMs` (shared/layout.ts holdSpeaker); someone who
 * leaves the stage gives it up at once. `ids`: the tiles on the stage.
 */
export function useHeldSpeaker(
  wanted: string | null,
  ids: readonly string[],
  holdMs = SPEAKER_SWITCH_MS,
): string | null {
  const [held, setHeld] = useState<HeldSpeaker | null>(null)
  const key = ids.join(' ')
  useEffect(() => {
    const present = key === '' ? [] : key.split(' ')
    const next = holdSpeaker(held, wanted, present, Date.now(), holdMs)
    if (next.held === held && next.wait === 0) return
    // A change now (on the next tick), or `wanted` takes it once the hold is over (a new
    // `wanted` restarts this)
    const timer = setTimeout(
      () =>
        setHeld(
          next.held !== held || wanted === null ? next.held : { id: wanted, since: Date.now() },
        ),
      next.held !== held ? 0 : next.wait,
    )
    return () => clearTimeout(timer)
  }, [held, wanted, key, holdMs])
  return held !== null && ids.includes(held.id) ? held.id : wanted
}

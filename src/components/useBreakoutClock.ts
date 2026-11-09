// The breakout rooms' clock and what is said when they change (L3, e10-t05), for BreakoutBar,
// BreakoutPanel and the room page
import { useEffect, useRef, useState } from 'react'
import { BREAKOUT_RECALL_MS, breakoutRemaining, type BreakoutView } from '../../shared/breakout.ts'
import { strings } from '../strings.ts'

/** The clock, ticking every second while there is something to count down (on this device's clock) */
export function useBreakoutClock(breakout: BreakoutView | null, now: () => number): number {
  const [at, setAt] = useState(now)
  const counting = breakout !== null && (breakout.endsAt !== null || breakout.closesAt !== null)
  useEffect(() => {
    if (!counting) return
    // Read the clock at once (a recall's seconds start from now), then every second
    const first = setTimeout(() => setAt(now()), 0)
    const tick = setInterval(() => setAt(now()), 1000)
    return () => {
      clearTimeout(first)
      clearInterval(tick)
    }
  }, [counting, now])
  return at
}

/**
 * Where the rooms are now (shared/breakout.ts breakoutRemaining), ticking. A recall never reads
 * more than its own length: the clock last read can be up to a second old when it starts
 */
export function useBreakoutRemaining(
  breakout: BreakoutView,
  now: () => number,
): { phase: 'open' | 'closing'; ms: number | null } {
  const at = useBreakoutClock(breakout, now)
  const left = breakoutRemaining(breakout, at)
  return left.phase === 'closing' && left.ms !== null
    ? { phase: 'closing', ms: Math.min(left.ms, BREAKOUT_RECALL_MS) }
    : left
}

/** Whole seconds, rounded up: it reads 0 only once it is really over */
export const secondsOf = (ms: number): number => Math.ceil(ms / 1000)

/**
 * What changes about the breakout rooms, said once as a toast (the toasts are a live region): the
 * host's broadcast, the recall, and our own moves into a room and back. Nothing for what was
 * already so when we came in.
 */
export function useBreakoutNotices(
  breakout: BreakoutView | null,
  group: string | null,
  show: (text: string) => void,
  /** We have the room's view (not before the welcome, nor in the waiting room) */
  ready: boolean = true,
  now: () => number = Date.now,
): void {
  const previous = useRef<{ breakout: BreakoutView | null; group: string | null } | null>(null)
  useEffect(() => {
    if (!ready) {
      previous.current = null
      return
    }
    const was = previous.current
    previous.current = { breakout, group }
    if (was === null) return
    const broadcast = breakout?.broadcast ?? null
    if (broadcast && broadcast.at !== was.breakout?.broadcast?.at) {
      show(strings.breakout.broadcastToast(broadcast.by, broadcast.text))
    }
    const closesAt = breakout?.closesAt ?? null
    if (closesAt !== null && (was.breakout?.closesAt ?? null) === null) {
      show(strings.breakout.recalled(secondsOf(Math.max(0, closesAt - now()))))
    }
    if (group !== was.group) {
      const name = breakout?.groups.find((entry) => entry.id === group)?.name
      if (group !== null && name !== undefined) show(strings.breakout.movedTo(name))
      else if (group === null) show(strings.breakout.backToMain)
    }
  }, [breakout, group, show, ready, now])
}

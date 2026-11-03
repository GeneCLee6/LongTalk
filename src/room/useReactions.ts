import { useEffect, useEffectEvent, useState } from 'react'
import { REACTION_BADGE_MS, REACTION_FLOAT_MS } from '../../shared/reactions.ts'
import type { ReactionMessage } from '../../shared/protocol.ts'
import { addReaction, liveReactions, type FloatingReaction } from './floatingReactions.ts'

export type ReactionsByMember = Readonly<Record<string, readonly FloatingReaction[]>>

const NONE: ReactionsByMember = {}

let nextKey = 1

/**
 * The reactions floating over each member's tile now (G3, e5-t03), from the room's `reaction`
 * frames: a bubble lasts REACTION_FLOAT_MS (REACTION_BADGE_MS as the still badge that
 * prefers-reduced-motion gets). While `hidden` (更多 › 隱藏表情反應) nothing is kept.
 */
export function useReactions(
  subscribe: (listener: (reaction: ReactionMessage) => void) => () => void,
  { hidden, reducedMotion }: { hidden: boolean; reducedMotion: boolean },
): ReactionsByMember {
  const [bubbles, setBubbles] = useState<ReactionsByMember>(NONE)
  const [timers] = useState(() => new Set<ReturnType<typeof setTimeout>>())
  const duration = reducedMotion ? REACTION_BADGE_MS : REACTION_FLOAT_MS
  // Hiding drops what is showing (adjusted while rendering, React's pattern)
  if (hidden && bubbles !== NONE) setBubbles(NONE)

  const prune = useEffectEvent(() => {
    const now = Date.now()
    setBubbles((current) => {
      const next: Record<string, FloatingReaction[]> = {}
      for (const [id, list] of Object.entries(current)) {
        const live = liveReactions(list, now, duration)
        if (live.length > 0) next[id] = live
      }
      return Object.keys(next).length === 0 ? NONE : next
    })
  })
  const receive = useEffectEvent((reaction: ReactionMessage) => {
    if (hidden) return
    const now = Date.now()
    const key = nextKey++
    const drift = Math.random() * 2 - 1
    setBubbles((current) => ({
      ...current,
      [reaction.from]: addReaction(current[reaction.from] ?? [], reaction.emoji, now, key, drift),
    }))
    const timer = setTimeout(() => {
      timers.delete(timer)
      prune()
    }, duration + 50)
    timers.add(timer)
  })
  useEffect(() => {
    const stop = subscribe((reaction) => receive(reaction))
    return () => {
      stop()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [subscribe, timers])
  return bubbles
}

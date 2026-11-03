import { MAX_FLOATING_PER_TILE, REACTION_MERGE_MS, type Reaction } from '../../shared/reactions.ts'

/** One bubble over a tile (G3, e5-t03): an emoji, how many times in a row, where it drifts */
export interface FloatingReaction {
  /** Unique for the page's life: the element's key (a merge keeps it, so the float goes on) */
  key: number
  emoji: Reaction
  /** The same reaction from the same member within REACTION_MERGE_MS: 「👏 ×3」 */
  count: number
  /** When the bubble started (ms) */
  at: number
  /** A small random sideways drift, −1 … 1 (DESIGN.md §6: 隨機微偏移) */
  drift: number
}

/**
 * One member's bubbles after a new reaction at `now`: the same emoji as the newest bubble, which
 * started less than REACTION_MERGE_MS ago, counts there; anything else is a new bubble, the
 * oldest making room beyond MAX_FLOATING_PER_TILE. Pure: the hook passes the key and the drift.
 */
export function addReaction(
  bubbles: readonly FloatingReaction[],
  emoji: Reaction,
  now: number,
  key: number,
  drift: number,
): FloatingReaction[] {
  const newest = bubbles.at(-1)
  if (newest && newest.emoji === emoji && now - newest.at < REACTION_MERGE_MS) {
    return [...bubbles.slice(0, -1), { ...newest, count: newest.count + 1 }]
  }
  return [...bubbles, { key, emoji, count: 1, at: now, drift }].slice(-MAX_FLOATING_PER_TILE)
}

/** The bubbles still showing at `now`, each `duration` long */
export const liveReactions = (
  bubbles: readonly FloatingReaction[],
  now: number,
  duration: number,
): FloatingReaction[] => bubbles.filter((bubble) => now - bubble.at < duration)

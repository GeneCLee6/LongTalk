// Emoji reactions and raised hands (G3, e5-t03, e5-t04; PRD E5). Shared by the Worker (RoomHost
// decides) and the browser (which checks the same rate before sending and draws them).

/** The six reactions (E5: 👍 ❤️ 😂 😮 👏 🎉), in the picker's order */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'] as const

export type Reaction = (typeof REACTIONS)[number]

export const isReaction = (value: unknown): value is Reaction =>
  REACTIONS.includes(value as Reaction)

/**
 * Each member may send at most REACTION_RATE.count reactions in any REACTION_RATE.windowMs; the
 * room drops the rest without a word (a reaction is not worth an error), the browser does not
 * send them in the first place
 */
export const REACTION_RATE = { count: 8, windowMs: 5_000 } as const

/** How long a reaction floats over the sender's tile (E5: 浮出 5 秒) */
export const REACTION_FLOAT_MS = 5_000

/** With prefers-reduced-motion: a still badge on the tile for this long instead of the float */
export const REACTION_BADGE_MS = 2_500

/**
 * The same reaction from the same member within this long joins the bubble already floating
 * (「👏 ×3」) instead of starting another: a burst stays one bubble
 */
export const REACTION_MERGE_MS = 1_500

/** At most this many bubbles float over one tile at once; an older one makes room */
export const MAX_FLOATING_PER_TILE = 4

/** Who has a hand up, in the order they raised it (ties by id, so every end agrees) */
export function handQueue<T extends { id: string; hand?: number | null }>(
  members: Iterable<T>,
): T[] {
  return [...members]
    .filter((member) => typeof member.hand === 'number')
    .sort((a, b) => a.hand! - b.hand! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

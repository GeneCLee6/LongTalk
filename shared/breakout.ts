// Breakout rooms (L3, e10-t04, e10-t05; AC-10.4): what they are, their limits, and the pure helpers
// both ends share. The rooms live inside the same RoomDO (worker/room-breakout.ts keeps them); a
// member's room is `Member.group` (null or absent: the main room). The server decides who is where
// and refuses SFU pulls across rooms (RoomHost.sfuAccess); each browser scopes its view to its own
// room (scopeView) so it neither subscribes to nor shows anyone outside it.
//
// Only types are imported from protocol.ts / chat.ts: protocol.ts imports this file's values.
import type { ChatMessage } from './chat.ts'
import type { RoomView } from './protocol.ts'

/** Rooms one `breakoutOpen` may create */
export const MAX_BREAKOUT_GROUPS = 12
/** One room's name, in characters after normalizeName */
export const MAX_BREAKOUT_NAME_CHARS = 30
/** How long the host may set the rooms to run, in whole minutes (null: until recalled) */
export const MAX_BREAKOUT_MINUTES = 240
/** After a recall, or when the time runs out, everyone gets this long before being brought back */
export const BREAKOUT_RECALL_MS = 60_000
/** A broadcast to every room, in characters after normalizeName */
export const MAX_BROADCAST_CHARS = 200

/** One breakout room: ids are `g1` … `gN` in the order the host listed them */
export type BreakoutGroup = { id: string; name: string }

/** The host's last message to every room: who sent it (by name) and when (the server's clock) */
export type BreakoutBroadcast = { text: string; by: string; at: number }

/** The breakout rooms while they are open (`RoomView.breakout`); absent or null when they are not */
export type BreakoutView = {
  groups: BreakoutGroup[]
  openedAt: number
  /** When the time the host set runs out (the server's clock); null: no limit */
  endsAt: number | null
  /** Set once a recall started: everyone is brought back to the main room at this time */
  closesAt: number | null
  broadcast: BreakoutBroadcast | null
}

/** The id the room gives the `index`-th group */
export const groupId = (index: number): string => `g${index + 1}`

/** Whether `id` names one of the groups open now */
export const isGroupOf = (view: BreakoutView | null | undefined, id: string): boolean =>
  view?.groups.some((group) => group.id === id) ?? false

/**
 * Spreads members over `groupCount` rooms as evenly as possible, in random order: a group index for
 * each id, in the order given. Groups differ in size by at most one.
 */
export function autoAssign(
  memberIds: readonly string[],
  groupCount: number,
  random: () => number = Math.random,
): number[] {
  if (groupCount < 1) return memberIds.map(() => 0)
  const order = memberIds.map((_, index) => index)
  // Fisher–Yates
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const result = new Array<number>(memberIds.length).fill(0)
  order.forEach((memberIndex, position) => {
    result[memberIndex] = position % groupCount
  })
  return result
}

/** Which room a member is in (null: the main room, or nobody by that id) */
export function groupOf(view: RoomView | null | undefined, memberId: string | null): string | null {
  if (!view || memberId === null) return null
  return view.members[memberId]?.group ?? null
}

/**
 * The view as a member sees it while breakout rooms are open: only the members of their own room,
 * only the shares and the spotlight of someone in it. Without breakout rooms (or when nobody is in
 * one) it is the same object. Hosts get the full view too, separately, for the breakout panel.
 */
export function scopeView(view: RoomView, you: string): RoomView {
  const mine = view.members[you]?.group ?? null
  const anyGrouped = Object.values(view.members).some((member) => (member.group ?? null) !== null)
  if (!view.breakout && !anyGrouped) return view
  const members: RoomView['members'] = {}
  for (const [id, member] of Object.entries(view.members)) {
    if ((member.group ?? null) === mine) members[id] = member
  }
  const shares: RoomView['room']['shares'] = {}
  for (const [id, share] of Object.entries(view.room.shares ?? {})) {
    if (id in members) shares[id] = share
  }
  const spotlight =
    view.room.spotlight !== null && view.room.spotlight in members ? view.room.spotlight : null
  return { ...view, members, room: { ...view.room, shares, spotlight } }
}

/**
 * Whether the member `memberId`, in `group` (null: the main room), sees this chat message. A
 * private message (O4, e5-t09; `to`) is the sender's and the recipient's alone, wherever they are
 * now: the room only lets it be sent within one room, and it stays their conversation after a move
 */
export const chatVisible = (
  message: ChatMessage,
  group: string | null,
  memberId: string | null = null,
): boolean =>
  message.to !== undefined
    ? memberId !== null && (memberId === message.from || memberId === message.to)
    : (message.group ?? null) === group

/**
 * Where the rooms are: `open` with the time left (null: no limit), or `closing` with the time left
 * before everyone is brought back. Never below zero.
 */
export function breakoutRemaining(
  view: BreakoutView,
  now: number,
): { phase: 'open' | 'closing'; ms: number | null } {
  if (view.closesAt !== null) return { phase: 'closing', ms: Math.max(0, view.closesAt - now) }
  return { phase: 'open', ms: view.endsAt === null ? null : Math.max(0, view.endsAt - now) }
}

import type { Member } from '../../shared/protocol.ts'

/** What changed between two room views that the room tells about with a toast or a sound (G3) */
export interface MemberChanges {
  /** Who is new in the room (joined, or admitted from the waiting room) */
  joined: string[]
  /** Who is gone (left, removed; not who is reconnecting: they keep their place) */
  left: string[]
  /** Whose hand went up */
  raised: string[]
}

/**
 * The changes from `before` to `after`, leaving ourselves (`you`) out: we know what we did. With
 * no `before` (the first view after a welcome) nothing has changed: who was already there did
 * not just arrive.
 */
export function memberChanges(
  before: Readonly<Record<string, Member>> | null | undefined,
  after: Readonly<Record<string, Member>> | null | undefined,
  you: string | null,
): MemberChanges {
  const changes: MemberChanges = { joined: [], left: [], raised: [] }
  if (!before || !after) return changes
  for (const [id, member] of Object.entries(after)) {
    if (id === you) continue
    const was = before[id]
    if (!was) changes.joined.push(id)
    if (member.hand != null && was?.hand == null) changes.raised.push(id)
  }
  for (const id of Object.keys(before)) {
    if (id !== you && !(id in after)) changes.left.push(id)
  }
  return changes
}

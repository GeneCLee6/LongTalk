import {
  BREAKOUT_RECALL_MS,
  groupId,
  isGroupOf,
  type BreakoutBroadcast,
  type BreakoutView,
} from '../shared/breakout.ts'

/**
 * What survives the object being evicted (one storage key, written on every change): the rooms as
 * everyone sees them, and who is in which (member id → group id; anyone not named is in the main
 * room). Members keep their room in here rather than on `Member`, so the session records stay as
 * they are and a recall is one assignment to forget.
 */
export type BreakoutState = BreakoutView & { assign: Record<string, string> }

/** What a recall did: `closing` started the grace, `ended` brought everyone back */
export type BreakoutPhase = 'closing' | 'ended'

/**
 * A room's breakout rooms (L3, e10-t04; AC-10.4). Who may open, move, broadcast and recall is
 * RoomHost's to decide (worker/roles.ts `breakout`), and so is what isolation means for the SFU
 * and the chat; this only keeps the rooms, who is where and their clock. They belong to the
 * meeting: they go when it does, in a persistent room too.
 */
export class RoomBreakout {
  private state: BreakoutState | null

  constructor(stored: BreakoutState | null | undefined = null) {
    this.state = stored ? { ...stored, assign: { ...stored.assign } } : null
  }

  /** What is stored; null when no rooms are open */
  get stored(): BreakoutState | null {
    return this.state
  }

  /** The rooms as everyone sees them (`RoomView.breakout`); null when none are open */
  get view(): BreakoutView | null {
    if (!this.state) return null
    const { assign: _assign, ...view } = this.state
    return view
  }

  get on(): boolean {
    return this.state !== null
  }

  /** The members in a room now (not those in the main room) */
  get assigned(): string[] {
    return Object.keys(this.state?.assign ?? {})
  }

  /**
   * Opens the rooms: `assign` puts members (by id) in a room by its index in `groupNames`. The
   * caller checked the names, the indexes and that each id is a member in the meeting.
   */
  open(
    groupNames: readonly string[],
    assign: Readonly<Record<string, number>>,
    minutes: number | null,
    now: number,
  ): void {
    const groups = groupNames.map((name, index) => ({ id: groupId(index), name }))
    const placed: Record<string, string> = {}
    for (const [memberId, index] of Object.entries(assign)) {
      if (index >= 0 && index < groups.length) placed[memberId] = groups[index].id
    }
    this.state = {
      groups,
      openedAt: now,
      endsAt: minutes === null ? null : now + minutes * 60_000,
      closesAt: null,
      broadcast: null,
      assign: placed,
    }
  }

  /**
   * Puts a member in a room, or (null) back in the main room. False when no rooms are open or
   * there is no such room (the panel that asked was out of date).
   */
  move(memberId: string, group: string | null): boolean {
    const state = this.state
    if (!state || (group !== null && !isGroupOf(state, group))) return false
    const { [memberId]: _was, ...rest } = state.assign
    this.state = { ...state, assign: group === null ? rest : { ...rest, [memberId]: group } }
    return true
  }

  /** The room a member is in; null for the main room (or when no rooms are open) */
  groupOf(memberId: string): string | null {
    return this.state?.assign[memberId] ?? null
  }

  /** The member left the meeting; false when it was in no room (nothing to store) */
  forget(memberId: string): boolean {
    if (this.groupOf(memberId) === null) return false
    return this.move(memberId, null)
  }

  /** The host's message to every room, replacing the last one */
  broadcast(broadcast: BreakoutBroadcast): void {
    if (this.state) this.state = { ...this.state, broadcast }
  }

  /**
   * A recall: starts BREAKOUT_RECALL_MS of grace (everyone sees the time left), or (`immediate`)
   * brings everyone back at once, grace or not. Null when nothing changed: no rooms are open, or a
   * recall without `immediate` while one is under way (two co-hosts never skip the warning).
   */
  close(now: number, immediate = false): BreakoutPhase | null {
    if (!this.state) return null
    if (immediate) {
      this.state = null
      return 'ended'
    }
    if (this.state.closesAt !== null) return null
    this.state = { ...this.state, closesAt: now + BREAKOUT_RECALL_MS }
    return 'closing'
  }

  /** When the clock next does something: the time running out while open, the grace's end after */
  due(): number | null {
    if (!this.state) return null
    return this.state.closesAt ?? this.state.endsAt
  }

  /**
   * The alarm fired: the time that ran out starts the recall (with its full grace, counted from
   * now, so a late alarm never skips the warning), a grace that ran out ends it. Null: nothing due.
   */
  tick(now: number): BreakoutPhase | null {
    const due = this.due()
    if (due === null || due > now) return null
    return this.close(now, this.state!.closesAt !== null)
  }

  /** The meeting ended */
  reset(): void {
    this.state = null
  }
}

import {
  MAX_POLL_VOTERS,
  tally,
  type AgendaInfo,
  type AgendaItem,
  type PollResult,
  type PollView,
  type TimerInfo,
} from '../shared/interact.ts'

/** A poll as the room keeps it: `votes` is by member id and never goes to anyone as it is */
export type StoredPoll = Pick<
  PollView,
  'id' | 'by' | 'question' | 'options' | 'multi' | 'anonymous'
> & {
  votes: Record<string, { name: string; choices: number[] }>
}

/** What survives the object being evicted (one storage key, written on every change) */
export type InteractState = {
  poll: StoredPoll | null
  timer: TimerInfo | null
  agenda: AgendaInfo | null
}

export type VoteOutcome =
  /** Counted; `changed` is false when it was the member's answer already */
  | { ok: true; changed: boolean }
  /** The choices do not fit the poll */
  | { ok: false; reason: 'invalid' }
  /** MAX_POLL_VOTERS have voted */
  | { ok: false; reason: 'full' }
  /** That poll is over: not an error, the patch saying so is on its way */
  | { ok: false; reason: 'over' }

/**
 * A room's poll, countdown and agenda (L5, e5-t07, e5-t08). Who may do what is RoomHost's to decide
 * (worker/roles.ts); this only keeps the state and what the view shows of it. All of it belongs to
 * the meeting: it goes when the meeting does, in a persistent room too.
 */
export class RoomInteract {
  private state: InteractState

  constructor(stored: InteractState | null | undefined = null) {
    this.state = {
      poll: stored?.poll ?? null,
      timer: stored?.timer ?? null,
      agenda: stored?.agenda ?? null,
    }
  }

  /** What is stored */
  get stored(): InteractState {
    return this.state
  }

  get timer(): TimerInfo | null {
    return this.state.timer
  }

  get agenda(): AgendaInfo | null {
    return this.state.agenda
  }

  get pollOn(): boolean {
    return this.state.poll !== null
  }

  /** The poll on now as everyone sees it; null when there is none */
  get pollView(): PollView | null {
    const { poll } = this.state
    if (!poll) return null
    const { votes: _votes, ...rest } = poll
    return { ...rest, ...this.results(poll) }
  }

  private results(poll: StoredPoll): Pick<PollView, 'counts' | 'voters' | 'votes'> {
    const answers = Object.values(poll.votes)
    return {
      ...tally(
        poll.options.length,
        answers.map((answer) => answer.choices),
      ),
      ...(poll.anonymous ? {} : { votes: answers }),
    }
  }

  startPoll(poll: Omit<StoredPoll, 'votes'>): void {
    this.state = { ...this.state, poll: { ...poll, votes: {} } }
  }

  /** The member's answer, replacing an earlier one (a poll on now may be answered again) */
  vote(id: number, memberId: string, name: string, choices: readonly number[]): VoteOutcome {
    const { poll } = this.state
    if (!poll || poll.id !== id) return { ok: false, reason: 'over' }
    if (!poll.multi && choices.length !== 1) return { ok: false, reason: 'invalid' }
    if (choices.some((choice) => choice >= poll.options.length)) {
      return { ok: false, reason: 'invalid' }
    }
    const before = poll.votes[memberId]
    if (!before && Object.keys(poll.votes).length >= MAX_POLL_VOTERS) {
      return { ok: false, reason: 'full' }
    }
    const sorted = [...choices].sort((a, b) => a - b)
    if (before && before.choices.join() === sorted.join()) return { ok: true, changed: false }
    this.state = {
      ...this.state,
      poll: { ...poll, votes: { ...poll.votes, [memberId]: { name, choices: sorted } } },
    }
    return { ok: true, changed: true }
  }

  /** What `memberId` answered to the poll on now; null when they have not */
  voteOf(memberId: string): { poll: number; choices: number[] } | null {
    const { poll } = this.state
    const vote = poll?.votes[memberId]
    return poll && vote ? { poll: poll.id, choices: vote.choices } : null
  }

  /** Ends the poll on now and gives its results; null when `id` is not that poll */
  endPoll(id: number): PollResult | null {
    const { poll } = this.state
    if (!poll || poll.id !== id) return null
    const { question, options, multi, anonymous } = poll
    this.state = { ...this.state, poll: null }
    return { question, options, multi, anonymous, ...this.results(poll) }
  }

  setTimer(timer: TimerInfo | null): void {
    this.state = { ...this.state, timer }
  }

  /** The new list, or none (empty); the first item is the current one */
  setAgenda(items: readonly AgendaItem[]): void {
    this.state = {
      ...this.state,
      agenda: items.length === 0 ? null : { items: [...items], current: 0 },
    }
  }

  /** False when there is no such item */
  setAgendaCurrent(index: number): boolean {
    const { agenda } = this.state
    if (!agenda || index >= agenda.items.length) return false
    this.state = { ...this.state, agenda: { ...agenda, current: index } }
    return true
  }
}

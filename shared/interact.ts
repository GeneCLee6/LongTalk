// Polls, the countdown and the agenda bar (L5, e5-t07, e5-t08; AC-5.5): what they are, their limits,
// and how a poll's votes add up. Shared by the Worker (RoomHost decides, worker/room-interact.ts
// keeps them) and the browser (which checks the same limits before sending).

/** A poll's question, in characters (code points) after normalizeName */
export const MAX_POLL_QUESTION_CHARS = 200
/** One choice's text, likewise */
export const MAX_POLL_OPTION_CHARS = 100
export const MIN_POLL_OPTIONS = 2
export const MAX_POLL_OPTIONS = 10
/**
 * The most members one poll counts (MAX_MEMBERS at once, plus people coming and going): it keeps the
 * stored state and the chat message with the results small however a poll is used
 */
export const MAX_POLL_VOTERS = 50
/** Polls one member may start: a host polling every few seconds is a script */
export const POLL_START_RATE = { count: 5, windowMs: 60_000 } as const
/** Votes, timers and agenda changes per member; each one is written to storage */
export const INTERACT_RATE = { count: 20, windowMs: 10_000 } as const

/** A countdown's length: at least a second, at most four hours */
export const MAX_TIMER_SECONDS = 4 * 60 * 60
/** A countdown that ran out stays on the top bar for this long, saying so, for everyone */
export const TIMER_SHOWN_AFTER_MS = 60_000

export const MAX_AGENDA_ITEMS = 20
export const MAX_AGENDA_TITLE_CHARS = 80
/** One item's planned length, in whole minutes */
export const MAX_AGENDA_MINUTES = 480

/** One member's answer, as everyone sees it in a poll that is not anonymous */
export type PollVoter = { name: string; choices: number[] }

/**
 * The poll on now, as everyone sees it: never who voted what when it is `anonymous`. Only one at a
 * time; when it ends it leaves the view and its results are a chat message (PollResult).
 */
export type PollView = {
  /** Its start time (the server's clock): what `pollVote` and `pollEnd` say they are about */
  id: number
  /** Who started it, by name when they did */
  by: string
  question: string
  options: string[]
  /** Several choices may be picked (one otherwise) */
  multi: boolean
  /** Who voted what is not shown; the room keeps it only so a member can change their vote */
  anonymous: boolean
  /** Votes per option, in the options' order */
  counts: number[]
  /** How many members voted */
  voters: number
  /** Who voted what; absent on an anonymous poll */
  votes?: PollVoter[]
}

/** A finished poll in the chat (ChatMessage.poll): the view without what only matters while on */
export type PollResult = Omit<PollView, 'id' | 'by'>

/** The countdown (e5-t08): `endsAt` on the server's clock; `seconds` is what it was set to */
export type TimerInfo = { endsAt: number; seconds: number }

export type AgendaItem = { title: string; minutes: number }

/** The agenda bar (e5-t08): `current` indexes `items`, which is never empty */
export type AgendaInfo = { items: AgendaItem[]; current: number }

/** Adds a member's answers up: votes per option, and how many voted */
export function tally(optionCount: number, answers: Iterable<readonly number[]>) {
  const counts = new Array<number>(optionCount).fill(0)
  let voters = 0
  for (const choices of answers) {
    voters += 1
    for (const choice of choices) counts[choice] += 1
  }
  return { counts, voters }
}

/** A share of the voters as a whole percent, for the results' bars and text */
export const percentOf = (count: number, voters: number): number =>
  voters === 0 ? 0 : Math.round((count / voters) * 100)

/** A poll result in a chat message, as far as the browser checks it (the server is trusted) */
export function isPollResult(value: unknown): value is PollResult {
  if (typeof value !== 'object' || value === null) return false
  const poll = value as Record<string, unknown>
  return (
    typeof poll.question === 'string' &&
    Array.isArray(poll.options) &&
    Array.isArray(poll.counts) &&
    poll.options.length === poll.counts.length &&
    typeof poll.multi === 'boolean' &&
    typeof poll.anonymous === 'boolean' &&
    typeof poll.voters === 'number'
  )
}

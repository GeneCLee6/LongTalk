import type { Member } from '../../shared/protocol.ts'

// The participants panel's search and filters (O1, e10-t06; AC-10.5). Local to the browser: what
// the host sees listed is only a view; muting who is listed goes to RoomDO, which checks each one
// again (CLAUDE.md rule 1).

/** The filters, in the order the panel shows them */
export const PARTICIPANT_FILTERS = ['all', 'hand', 'muted', 'noVideo'] as const

export type ParticipantFilter = (typeof PARTICIPANT_FILTERS)[number]

/**
 * From how many people (waiting room not counted) the panel shows the search box and the filters:
 * below that the whole list fits on a phone's screen and they would only take room
 */
export const SEARCH_FROM = 6

/** What a name is compared as: full-width letters as half-width, case folded */
export function nameKey(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().trim()
}

/** Whether the member's microphone is on (sending, not muted) */
export function micOn(member: Member): boolean {
  const mic = member.tracks.find((track) => track.kind === 'mic')
  return !!mic && !mic.muted
}

function camOn(member: Member): boolean {
  const cam = member.tracks.find((track) => track.kind === 'cam')
  return !!cam && !cam.muted
}

/**
 * Whether the member is one the filter keeps. A desktop agent (N2) has no microphone or camera to
 * speak of and no hand to raise: only 全部 keeps it
 */
export function matchesFilter(member: Member, filter: ParticipantFilter): boolean {
  if (filter === 'all') return true
  if (member.agent) return false
  switch (filter) {
    case 'hand':
      return member.hand != null
    case 'muted':
      return !micOn(member)
    case 'noVideo':
      return !camOn(member)
  }
}

/** Whether the member's name has the query in it (an empty query keeps everyone) */
export function matchesQuery(member: Member, query: string): boolean {
  const key = nameKey(query)
  return key === '' || nameKey(member.name).includes(key)
}

/** The members both keep, in the order given */
export function filterMembers<T extends Member>(
  members: readonly T[],
  query: string,
  filter: ParticipantFilter,
): T[] {
  return members.filter((member) => matchesFilter(member, filter) && matchesQuery(member, query))
}

/** How many members each filter would keep (for the counts on the filter buttons) */
export function filterCounts(members: readonly Member[]): Record<ParticipantFilter, number> {
  const counts = { all: 0, hand: 0, muted: 0, noVideo: 0 }
  for (const member of members) {
    for (const filter of PARTICIPANT_FILTERS) if (matchesFilter(member, filter)) counts[filter]++
  }
  return counts
}

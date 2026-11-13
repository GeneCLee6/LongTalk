// O1 (e10-t06; AC-10.5): the participants panel in a large room. Search by name, filters with
// counts, muting who is listed (only who has a microphone on and whom our role may mute) and the
// start-muted switch. What is listed is local; RoomDO decides again (tests/worker/room-host.test.ts).
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Member, MemberTrack } from '../../shared/protocol.ts'
import type { Role } from '../../shared/roles.ts'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import {
  SEARCH_FROM,
  filterCounts,
  filterMembers,
  matchesQuery,
  nameKey,
} from '../../src/room/participantFilter.ts'

const track = (kind: MemberTrack['kind'], muted = false): MemberTrack => ({
  sessionId: 's',
  trackName: `${kind}-1`,
  kind,
  muted,
})

const person = (
  id: string,
  name: string,
  role: Role,
  tracks: MemberTrack[] = [track('mic'), track('cam')],
  hand: number | null = null,
): Member => ({
  id,
  name,
  role,
  joinedAt: id.charCodeAt(0),
  reconnecting: false,
  tracks,
  hand,
  signal: null,
  mayRecord: false,
})

const MEMBERS: Member[] = [
  person('a', 'Gene', 'host'),
  person('b', '小潔', 'cohost'),
  person('c', '阿明', 'participant', [track('mic'), track('cam', true)], 5),
  person('d', 'Wei Chen', 'participant', [track('mic', true)]),
  person('e', '陳小芳', 'participant', [track('mic')]),
  person('f', 'ＡＮＮＡ', 'participant', [track('mic'), track('cam')], 3),
  {
    ...person('g', 'Gene 的電腦', 'participant', [track('screen')]),
    agent: { owner: 'a', device: 'DESK', platform: 'windows' },
  },
]

function panel(you: string, overrides: Partial<Parameters<typeof ParticipantsPanel>[0]> = {}) {
  const props = {
    members: MEMBERS,
    you,
    sharerIds: [],
    onAction: vi.fn(),
    onMuteAll: vi.fn(),
    onMuteMembers: vi.fn(),
    onStartMuted: vi.fn(),
    onEndMeeting: vi.fn(),
    ...overrides,
  }
  render(<ParticipantsPanel {...props} />)
  return props
}

const listed = () =>
  screen
    .queryAllByRole('listitem')
    .map((item) => item.getAttribute('aria-label'))
    .filter((name) => name !== null)
const search = () => screen.getByRole('searchbox', { name: '搜尋參與者' })

describe('participantFilter (O1)', () => {
  it('compares names with full-width letters as half-width, case folded', () => {
    expect(nameKey('ＡＮＮＡ ')).toBe('anna')
    expect(matchesQuery(MEMBERS[5], 'ann')).toBe(true)
    expect(matchesQuery(MEMBERS[3], 'CHEN')).toBe(true)
    expect(matchesQuery(MEMBERS[3], '  ')).toBe(true)
    expect(matchesQuery(MEMBERS[3], '小')).toBe(false)
  })

  it('filters by hand, microphone and camera; a computer only under 全部', () => {
    expect(filterMembers(MEMBERS, '', 'hand').map((m) => m.id)).toEqual(['c', 'f'])
    expect(filterMembers(MEMBERS, '', 'muted').map((m) => m.id)).toEqual(['d'])
    expect(filterMembers(MEMBERS, '', 'noVideo').map((m) => m.id)).toEqual(['c', 'd', 'e'])
    expect(filterMembers(MEMBERS, '小', 'noVideo').map((m) => m.id)).toEqual(['e'])
    expect(filterCounts(MEMBERS)).toEqual({ all: 7, hand: 2, muted: 1, noVideo: 3 })
  })
})

describe('ParticipantsPanel in a large room (O1, e10-t06)', () => {
  it('shows search and filters only from SEARCH_FROM people', () => {
    expect(SEARCH_FROM).toBeLessThanOrEqual(MEMBERS.length)
    panel('e', { members: MEMBERS.slice(0, SEARCH_FROM - 1) })
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('narrows the list by name and by filter, and says how many are listed', () => {
    panel('e')
    expect(listed()).toHaveLength(7)
    fireEvent.change(search(), { target: { value: '小' } })
    expect(listed()).toEqual(['陳小芳', '小潔'])
    expect(screen.getByRole('status')).toHaveTextContent('列出 2 人，共 7 人')
    fireEvent.change(search(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '舉手 2' }))
    expect(screen.getByRole('button', { name: '舉手 2' })).toHaveAttribute('aria-pressed', 'true')
    // Raised hands keep their queue's order
    expect(listed()).toEqual(['ＡＮＮＡ', '阿明'])
    fireEvent.change(search(), { target: { value: 'nobody' } })
    expect(listed()).toEqual([])
    expect(screen.getByRole('status')).toHaveTextContent('沒有符合的人')
    // Escape clears the box first
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(search()).toHaveValue('')
  })

  it('offers a participant the search but no muting', () => {
    panel('e')
    fireEvent.click(screen.getByRole('button', { name: '沒開鏡頭 3' }))
    expect(screen.queryByRole('button', { name: /^靜音列出的/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: '預設靜音進入' })).toBeNull()
  })

  it('mutes who is listed: only microphones on, never ourselves or the host', () => {
    const p = panel('b')
    // Nothing narrowed: 全員靜音 is the one for everyone
    expect(screen.queryByRole('button', { name: /^靜音列出的/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '沒開鏡頭 3' }))
    // 阿明 and 陳小芳 have a microphone on; Wei Chen is muted already
    fireEvent.click(screen.getByRole('button', { name: '靜音列出的 2 人' }))
    expect(p.onMuteMembers).toHaveBeenCalledWith(['c', 'e'])
    fireEvent.click(screen.getByRole('button', { name: '全部 7' }))
    fireEvent.change(search(), { target: { value: 'gene' } })
    // Gene is the host (out of a co-host's reach) and Gene 的電腦 has no microphone
    expect(screen.queryByRole('button', { name: /^靜音列出的/ })).toBeNull()
  })

  it('has the start-muted switch for a host or co-host', () => {
    const p = panel('a', { startMuted: false })
    const toggle = screen.getByRole('switch', { name: '預設靜音進入' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(p.onStartMuted).toHaveBeenCalledWith(true)
  })
})

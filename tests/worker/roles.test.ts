import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  PERMISSIONS,
  RANK,
  ROLES,
  authorize,
  can,
  canActOn,
  type Action,
  type Role,
} from '../../worker/roles.ts'

// The whole table spelled out, one row per action: H host, C cohost, P participant, W waiting.
// Changing who may do something means changing worker/roles.ts' table and this row together.
const EXPECTED: Record<Action, string> = {
  renameSelf: 'HCPW',
  media: 'HCP',
  shareScreen: 'HCP',
  chat: 'HCP',
  react: 'HCP',
  raiseHand: 'HCP',
  annotate: 'HCP',
  requestControl: 'HCP',
  renameRoom: 'HC',
  muteAll: 'HC',
  endMeeting: 'H',
  lockRoom: 'HC',
  waitingRoom: 'HC',
  admit: 'HC',
  spotlight: 'HC',
  setPassword: 'H',
  annotationPolicy: 'HC',
  clearAnnotations: 'HC',
  record: 'H',
  muteMember: 'HC',
  camOff: 'HC',
  stopShare: 'HC',
  remove: 'HC',
  lowerHand: 'HC',
  setCohost: 'H',
  makeHost: 'H',
  allowRecord: 'H',
}

const LETTER: Record<Role, string> = { host: 'H', cohost: 'C', participant: 'P', waiting: 'W' }

describe('roles (e1-t06)', () => {
  it('lists every action of the table exactly once in the expected matrix', () => {
    expect(ACTIONS.toSorted()).toEqual(Object.keys(EXPECTED).toSorted())
  })

  for (const action of Object.keys(EXPECTED) as Action[]) {
    it(`${action}: ${EXPECTED[action]}`, () => {
      for (const role of ROLES) {
        expect(can(role, action), `${role} × ${action}`).toBe(
          EXPECTED[action].includes(LETTER[role]),
        )
      }
    })
  }

  it('ranks host above cohost above participant above waiting', () => {
    expect(RANK.host).toBeGreaterThan(RANK.cohost)
    expect(RANK.cohost).toBeGreaterThan(RANK.participant)
    expect(RANK.participant).toBeGreaterThan(RANK.waiting)
  })

  it('acts on a member only from a higher rank, never on oneself', () => {
    const memberActions = ACTIONS.filter((action) => PERMISSIONS[action].on === 'member')
    expect(memberActions.toSorted()).toEqual(
      [
        'camOff',
        'lowerHand',
        'allowRecord',
        'makeHost',
        'muteMember',
        'remove',
        'setCohost',
        'stopShare',
      ].toSorted(),
    )
    for (const action of memberActions) {
      for (const actor of ROLES) {
        for (const target of ROLES) {
          expect(canActOn(actor, action, target), `${actor} ${action} ${target}`).toBe(
            can(actor, action) && RANK[actor] > RANK[target],
          )
          expect(canActOn(actor, action, target, true)).toBe(false)
        }
      }
    }
    // The cases that matter in a meeting
    expect(canActOn('host', 'remove', 'cohost')).toBe(true)
    expect(canActOn('cohost', 'remove', 'host')).toBe(false)
    expect(canActOn('cohost', 'muteMember', 'cohost')).toBe(false)
    expect(canActOn('participant', 'muteMember', 'participant')).toBe(false)
  })

  it('never treats a room or self action as one on a member', () => {
    expect(canActOn('host', 'muteAll', 'participant')).toBe(false)
    expect(canActOn('host', 'chat', 'participant')).toBe(false)
  })

  it('authorize: room and self actions by role, member actions by role, rank and target', () => {
    expect(authorize('a', 'host', 'endMeeting')).toBe(true)
    expect(authorize('a', 'cohost', 'endMeeting')).toBe(false)
    expect(authorize('a', 'participant', 'muteAll')).toBe(false)
    expect(authorize('a', 'waiting', 'chat')).toBe(false)
    expect(authorize('a', 'host', 'muteMember', { id: 'b', role: 'participant' })).toBe(true)
    // Nobody there, or oneself
    expect(authorize('a', 'host', 'muteMember', null)).toBe(false)
    expect(authorize('a', 'host', 'remove', { id: 'a', role: 'host' })).toBe(false)
    expect(authorize('a', 'participant', 'remove', { id: 'b', role: 'participant' })).toBe(false)
  })
})

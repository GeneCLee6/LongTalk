// The server's permission check (E1 e1-t06, CLAUDE.md rule 1): every action a member asks the
// room for goes through `authorize` in RoomHost before anything changes. The table itself (roles ×
// actions) is shared/roles.ts, so the browser can leave out the buttons a member could not use;
// the decision is only ever made here.
import { PERMISSIONS, can, canActOn, type Action, type Role } from '../shared/roles.ts'

export {
  ACTIONS,
  PERMISSIONS,
  RANK,
  ROLES,
  can,
  canActOn,
  mayClearLayer,
  mayCloseBoard,
  mayDraw,
  mayMessagePrivately,
  mayOpenBoard,
} from '../shared/roles.ts'
export type { Action, Role, Rule } from '../shared/roles.ts'

/** The member on the other end of a `member` action */
export type Target = { id: string; role: Role }

/**
 * Whether the member `actorId` (role `actor`) may do `action`; for a `member` action, to `target`
 * (null when there is no such member: refused). Pure: RoomHost passes what it knows.
 */
export function authorize(
  actorId: string,
  actor: Role,
  action: Action,
  target: Target | null = null,
): boolean {
  if (PERMISSIONS[action].on !== 'member') return can(actor, action)
  if (!target) return false
  return canActOn(actor, action, target.role, target.id === actorId)
}

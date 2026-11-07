// Who may do what in a room (E1 e1-t06): every role × every action, as one table. RoomDO decides
// with it (worker/roles.ts `authorize`, CLAUDE.md rule 1); the browser reads the same table only
// to leave out buttons the member could not use (the server checks again either way).
//
// An action is one of three shapes (`on`):
// - `self`: something the member does for themselves (chat, share the screen);
// - `room`: something done to the whole room (mute everyone, end the meeting, rename it);
// - `member`: something done to one other member (mute them, remove them). On top of the role,
//   the target must rank below the actor (`RANK`): a co-host cannot remove the host, nobody acts
//   on someone of the same rank, nobody targets themselves (they have their own controls).
//
// Rows whose `since` is a later batch are not used yet: they are here so that batch only wires
// its message to `authorize` and, if the owner decides differently, flips its entry.

/**
 * - `host`: one per room (the first to join; AC-1.3 hands it on)
 * - `cohost`: the host's helpers, named by the host (e1-t16; until then nobody is one)
 * - `participant`: everyone else in the room
 * - `waiting`: in the waiting room, not in the meeting yet (e1-t10)
 */
export type Role = 'host' | 'cohost' | 'participant' | 'waiting'

export const ROLES: readonly Role[] = ['host', 'cohost', 'participant', 'waiting']

/** Higher acts on lower (`member` actions only) */
export const RANK: Readonly<Record<Role, number>> = {
  host: 3,
  cohost: 2,
  participant: 1,
  waiting: 0,
}

export type ActionTarget = 'self' | 'room' | 'member'

export type Rule = {
  /** The roles allowed */
  who: readonly Role[]
  on: ActionTarget
  /** The batch that puts the action on the wire (docs/ROADMAP.md) */
  since: string
}

const STAFF = ['host', 'cohost'] as const
const IN_ROOM = ['host', 'cohost', 'participant'] as const
const ANYONE = ['host', 'cohost', 'participant', 'waiting'] as const

/** The table. Keep it in step with tests/worker/roles.test.ts, which spells out every cell. */
export const PERMISSIONS = {
  // ── What a member does for themselves ──
  /** Change one's own display name (C2) */
  renameSelf: { who: ANYONE, on: 'self', since: 'C2' },
  /** Publish a microphone or camera and receive the others' (B1; the SFU proxy asks) */
  media: { who: IN_ROOM, on: 'self', since: 'B1' },
  /** Share the screen (D1) */
  shareScreen: { who: IN_ROOM, on: 'self', since: 'D1' },
  /** Send a chat message to everyone (D3) */
  chat: { who: IN_ROOM, on: 'self', since: 'D3' },
  /**
   * Share a file in the chat, and download what others shared (I5, e5-t05): RoomDO decides for
   * the Worker's upload and download routes (worker/files.ts)
   */
  uploadFile: { who: IN_ROOM, on: 'self', since: 'I5' },
  downloadFile: { who: IN_ROOM, on: 'self', since: 'I5' },
  /** Reactions and raising a hand (G3) */
  react: { who: IN_ROOM, on: 'self', since: 'G3' },
  raiseHand: { who: IN_ROOM, on: 'self', since: 'G3' },
  /** Draw on a share or the whiteboard, subject to the room's annotation policy (J, E7: mayDraw) */
  annotate: { who: IN_ROOM, on: 'self', since: 'J' },
  /**
   * Open the room's whiteboard for everyone (J3, e7-t06), subject to the same policy (mayOpenBoard).
   * Closing it is mayCloseBoard: it asks for more than opening does
   */
  openWhiteboard: { who: IN_ROOM, on: 'self', since: 'J3' },
  /** Answer the poll on now (L5, e5-t07) */
  votePoll: { who: IN_ROOM, on: 'self', since: 'L5' },
  /** Ask the sharer for remote control (N, E9; the sharer still has to accept) */
  requestControl: { who: IN_ROOM, on: 'self', since: 'N' },

  // ── What is done to the whole room ──
  /** The room's name (C2, e1-t05) */
  renameRoom: { who: STAFF, on: 'room', since: 'C2' },
  /** Mute everyone ranked below the actor (F1) */
  muteAll: { who: STAFF, on: 'room', since: 'F1' },
  /** End the meeting for everyone: the room closes at once (F1) */
  endMeeting: { who: ['host'], on: 'room', since: 'F1' },
  /** Lock the room; turn the waiting room on or off; admit or turn away who waits (F2) */
  lockRoom: { who: STAFF, on: 'room', since: 'F2' },
  waitingRoom: { who: STAFF, on: 'room', since: 'F2' },
  admit: { who: STAFF, on: 'room', since: 'F2' },
  /**
   * Put one member in everyone's main area, or end it (G2, e4-t11). A room action, not a member
   * one: any member may be spotlighted, the actor and the host included (no rank check)
   */
  spotlight: { who: STAFF, on: 'room', since: 'G2' },
  /** The room's password (F3, e1-t15) */
  setPassword: { who: ['host'], on: 'room', since: 'F3' },
  /**
   * Who may annotate (J, E7 AC-7.3) and clearing everyone's drawings. Whoever shares may also clear
   * on their own share, and whoever opened the whiteboard on it (mayClearLayer)
   */
  annotationPolicy: { who: STAFF, on: 'room', since: 'J' },
  clearAnnotations: { who: STAFF, on: 'room', since: 'J' },
  /**
   * Record the meeting, and stop anyone's recording (I4, e8-t02; K for transcripts; everyone is
   * told, rule 4). The host only (F1's decision: not co-hosts); a member the host allowed
   * (`allowRecord`, `Member.mayRecord`) may record too, and stop their own
   */
  record: { who: ['host'], on: 'room', since: 'I4' },

  /** Start and end polls (L5, e5-t07); the countdown and the agenda bar (L5, e5-t08) */
  poll: { who: STAFF, on: 'room', since: 'L5' },
  timer: { who: STAFF, on: 'room', since: 'L5' },
  agenda: { who: STAFF, on: 'room', since: 'L5' },

  // ── What is done to one other member ──
  /** Mute their microphone; only they can turn it back on (F1) */
  muteMember: { who: STAFF, on: 'member', since: 'F1' },
  /** Turn their camera off; only they can turn it back on (F1) */
  camOff: { who: STAFF, on: 'member', since: 'F1' },
  /** Stop their screen share (F1; RoomHost.stopShare) */
  stopShare: { who: STAFF, on: 'member', since: 'F1' },
  /** Remove them; their browser cannot join again for BAN_MS (F1) */
  remove: { who: STAFF, on: 'member', since: 'F1' },
  /** Lower their raised hand (G3) */
  lowerHand: { who: STAFF, on: 'member', since: 'G3' },
  /** Make them a co-host or a participant again; hand them the host role (F3, e1-t16) */
  setCohost: { who: ['host'], on: 'member', since: 'F3' },
  makeHost: { who: ['host'], on: 'member', since: 'F3' },
  /** Let them record the meeting themselves, or take that back (I4, PRD E8 「主持人可允許特定成員」) */
  allowRecord: { who: ['host'], on: 'member', since: 'I4' },
} as const satisfies Record<string, Rule>

export type Action = keyof typeof PERMISSIONS

export const ACTIONS = Object.keys(PERMISSIONS) as Action[]

/** Whether `role` may do `action` at all (for a `member` action, see also canActOn) */
export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action].who as readonly Role[]).includes(role)
}

/**
 * Whether `actor` may do the `member` action `action` to `target`: the role allows it and the
 * target ranks below the actor. `self` is whether the target is the actor (never allowed).
 */
export function canActOn(actor: Role, action: Action, target: Role, self = false): boolean {
  if (PERMISSIONS[action].on !== 'member' || self) return false
  return can(actor, action) && RANK[actor] > RANK[target]
}

export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role)

// ---------------------------------------------------------------------------------------------
// Annotations (J3, e7-t05; AC-7.3): the table's rows and the room's policy together. Whether someone
// may draw depends on more than the role (the policy, whose layer it is), so the decision is these
// functions, used by RoomDO to decide and by the browser only to leave out what would be refused.

/**
 * Who may draw on the room's shares and whiteboard (`RoomInfo.annotationPolicy`, set by a host or
 * co-host):
 * - `everyone`: everyone in the meeting;
 * - `sharer`: the host, co-hosts and the layer's owner (who shares it, who opened the whiteboard);
 * - `off`: nobody, not the host either. What is drawn stays, and can still be cleared.
 */
export type AnnotationPolicy = 'everyone' | 'sharer' | 'off'

export const ANNOTATION_POLICIES: readonly AnnotationPolicy[] = ['everyone', 'sharer', 'off']

export const DEFAULT_ANNOTATION_POLICY: AnnotationPolicy = 'everyone'

export const isAnnotationPolicy = (value: unknown): value is AnnotationPolicy =>
  ANNOTATION_POLICIES.includes(value as AnnotationPolicy)

/** Whether `role` may draw on a layer; `owner`: the layer is theirs */
export function mayDraw(policy: AnnotationPolicy, role: Role, owner: boolean): boolean {
  if (!can(role, 'annotate')) return false
  if (policy === 'off') return false
  return policy === 'everyone' || owner || can(role, 'annotationPolicy')
}

/** Whether `role` may clear everything on a layer, or one person's on it */
export function mayClearLayer(role: Role, owner: boolean): boolean {
  return can(role, 'annotate') && (owner || can(role, 'clearAnnotations'))
}

/** Whether `role` may open the whiteboard: a host or co-host always, others when anyone may draw */
export function mayOpenBoard(policy: AnnotationPolicy, role: Role): boolean {
  if (!can(role, 'openWhiteboard')) return false
  return policy === 'everyone' || can(role, 'clearAnnotations')
}

/** Whether `role` may take the whiteboard off the stage: a host, a co-host, whoever opened it */
export const mayCloseBoard = (role: Role, owner: boolean): boolean => mayClearLayer(role, owner)

// Remote control in the room (N3: e9-t04 consent, e9-t05 the event channel; AC-9.2, AC-9.4). The
// threat model is docs/PRD/f-remote-control-security.md: §5.2 (requests and their limits), §5.3 (no
// unattended access), §5.4 (everyone sees it), §5.5–§5.6 (the channel: forwarded only from the
// socket holding the grant, acceptSeq, CONTROL_EVENT_RATE) and §5.7 (every way a grant ends). The
// shapes and the pure rules are shared/control.ts; who may ask, and the host's `stopControl`, are
// worker/roles.ts (RoomHost asks before calling here, CLAUDE.md rule 1).
//
// What this keeps, per agent at most one of each: the request waiting for the agent's answer, and
// the grant it turned into. A grant is bound to the controller's socket (`conn`), never its token:
// that socket closing (a reload, a drop, the token joining from elsewhere) ends it, and coming back
// does not resume it (D4). The only way a grant starts is `answer`, which RoomHost calls only for a
// `controlAnswer` on the agent's own socket (§5.3: no host action, no browser message makes one).
//
// Nothing of what is typed or clicked is stored (D11, T-18): the stored state is ids, who, when and
// the last seq forwarded; the events only pass through `event` on their way to the agent.
//
// N5 (e9-t08, e9-t09): a grant also carries what the agent says about it (`status`: injection paused
// by the secure desktop; pasting turned off) and whether the person allowed pasting in the consent
// dialog. `paste` forwards the controller's 「貼到對方電腦」 text to the agent only when the grant
// allows it, from the socket holding it, within CONTROL_CLIPBOARD_RATE; the text is never stored
// (T-22), and everyone is told that it happened (`controlPasted`), not what it was.
import {
  CONTROL_AGENT_DENY_LIMIT,
  CONTROL_CLIPBOARD_RATE,
  CONTROL_AGENT_MUTE_MS,
  CONTROL_DENY_COOLDOWN_MS,
  CONTROL_EVENT_RATE,
  CONTROL_GRANT_MS,
  CONTROL_REQUEST_RATE,
  CONTROL_REQUEST_TTL_MS,
  acceptSeq,
  grantUntil,
  newControlId,
  takeControlEvents,
  upEventsOnly,
  type AgentServerMessage,
  type ControlAnswerMessage,
  type ControlBlock,
  type ControlClipboardMessage,
  type ControlDecision,
  type ControlEndReason,
  type ControlErrorCode,
  type ControlEventMessage,
  type ControlRequestEndReason,
  type ControlStatusMessage,
  type ControlView,
  type EventWindow,
} from '../shared/control.ts'
import type { Member, NoticeMessage, ServerMessage } from '../shared/protocol.ts'

/**
 * How long after a forwarded batch the last seq is stored (one write per burst, not per batch). An
 * eviction in between brings back a `last` at most this far behind: the next batch is then a `gap`
 * (fewer than MAX_CONTROL_SEQ_GAP batches fit in it), never a refusal.
 */
export const CONTROL_SEQ_SAVE_MS = 2_000

/** A request waiting for the agent's answer */
export type ControlRequestRecord = {
  id: string
  agent: string
  requester: string
  /** The requester's name when it asked: what the agent's dialog shows (a rename does not change it) */
  name: string
  /** The sockets it was made between: either one going away ends it */
  requesterConn: string
  agentConn: string
  since: number
  until: number
}

/** A grant: control the agent allowed, bound to the controller's socket */
export type ControlGrantRecord = {
  id: string
  agent: string
  controller: string
  name: string
  conn: string
  agentConn: string
  decision: Exclude<ControlDecision, 'deny'>
  since: number
  /** null: until stopped */
  until: number | null
  /** The last seq forwarded to the agent (acceptSeq's `last`) */
  last: number
  /**
   * N5: pasting is allowed (the person ticked it in the consent dialog and has not turned it off
   * since); absent in what an earlier version stored: no
   */
  clipboard?: boolean
  /** N5: what pauses the agent's injection now, as it says (`controlStatus`); absent: nothing */
  blocked?: ControlBlock | null
}

/** What survives the object being evicted (one storage key; null when there is nothing) */
export type ControlState = {
  requests: ControlRequestRecord[]
  grants: ControlGrantRecord[]
  /** When each member's requests were made (CONTROL_REQUEST_RATE) */
  asked: Record<string, number[]>
  /** `<member> <agent>` → until when that member may not ask that agent (CONTROL_DENY_COOLDOWN_MS) */
  cooldowns: Record<string, number>
  /** When each agent denied or let a request run out (CONTROL_AGENT_DENY_LIMIT) */
  denies: Record<string, number[]>
  /** Until when each agent takes no requests (`controlMute`, or the deny limit) */
  mutes: Record<string, number>
}

/** What RoomHost tells and lends the control state */
export interface ControlRoom {
  now(): number
  /** A member in the meeting (not one waiting); undefined for anyone else */
  member(id: string): Member | undefined
  /** The socket the member is on now; null while it is away */
  connOf(id: string): string | null
  /** The member's breakout room; null for the main room */
  groupOf(id: string): string | null
  /** Whether the member shares its screen now */
  sharing(id: string): boolean
  /** `RoomInfo.allowControl` (absent: true) */
  controlAllowed(): boolean
  roomLabel(): { roomName: string | null; createdBy: string | null }
  send(conn: string, message: ServerMessage): void
  post(conn: string, message: AgentServerMessage): void
  /** A notice to every person in the meeting */
  tellEveryone(notice: NoticeMessage): void
  save(state: ControlState | null): void
  /** Runs `work` after `ms` (the adapter's timer); absent in tests that do not need it */
  later?(ms: number, work: () => void): void
}

const recent = (times: readonly number[] | undefined, now: number, windowMs: number): number[] =>
  (times ?? []).filter((at) => now - at < windowMs)

const pairKey = (member: string, agent: string): string => `${member} ${agent}`

export class RoomControl {
  private requests: ControlRequestRecord[] = []
  private grants: ControlGrantRecord[] = []
  private asked = new Map<string, number[]>()
  private cooldowns = new Map<string, number>()
  private denies = new Map<string, number[]>()
  private mutes = new Map<string, number>()
  /** The events forwarded lately per grant id (CONTROL_EVENT_RATE); memory only */
  private readonly windows = new Map<string, EventWindow>()
  /** The pastes forwarded lately per grant id (CONTROL_CLIPBOARD_RATE, N5); memory only */
  private readonly pastes = new Map<string, EventWindow>()
  private seqDirty = false

  private readonly room: ControlRoom

  constructor(room: ControlRoom, stored: ControlState | null | undefined = null) {
    this.room = room
    this.load(stored ?? null)
  }

  private load(stored: ControlState | null): void {
    this.requests = (stored?.requests ?? []).map((entry) => ({ ...entry }))
    this.grants = (stored?.grants ?? []).map((entry) => ({ ...entry }))
    this.asked = new Map(Object.entries(stored?.asked ?? {}).map(([k, v]) => [k, [...v]]))
    this.cooldowns = new Map(Object.entries(stored?.cooldowns ?? {}))
    this.denies = new Map(Object.entries(stored?.denies ?? {}).map(([k, v]) => [k, [...v]]))
    this.mutes = new Map(Object.entries(stored?.mutes ?? {}))
    this.windows.clear()
    this.pastes.clear()
    this.seqDirty = false
  }

  get stored(): ControlState | null {
    if (
      this.requests.length === 0 &&
      this.grants.length === 0 &&
      this.asked.size === 0 &&
      this.cooldowns.size === 0 &&
      this.denies.size === 0 &&
      this.mutes.size === 0
    ) {
      return null
    }
    return {
      requests: this.requests.map((entry) => ({ ...entry })),
      grants: this.grants.map((entry) => ({ ...entry })),
      asked: Object.fromEntries([...this.asked].map(([k, v]) => [k, [...v]])),
      cooldowns: Object.fromEntries(this.cooldowns),
      denies: Object.fromEntries([...this.denies].map(([k, v]) => [k, [...v]])),
      mutes: Object.fromEntries(this.mutes),
    }
  }

  /** What everyone sees (`RoomView.control`); null when nothing is asked or granted */
  get view(): ControlView | null {
    if (this.requests.length === 0 && this.grants.length === 0) return null
    const view: ControlView = {}
    for (const request of this.requests) {
      view[request.agent] = {
        agent: request.agent,
        controller: request.requester,
        phase: 'asking',
        since: request.since,
        until: request.until,
      }
    }
    for (const grant of this.grants) {
      view[grant.agent] = {
        agent: grant.agent,
        controller: grant.controller,
        phase: 'granted',
        since: grant.since,
        until: grant.until,
        ...(grant.clipboard ? { clipboard: true as const } : {}),
        ...(grant.blocked ? { blocked: grant.blocked } : {}),
      }
    }
    return view
  }

  /**
   * The grant the socket `conn` holds now (null: none), for exemptFromSocketRate: only a
   * `controlEvent` naming it stays out of SOCKET_MESSAGE_RATE
   */
  liveGrantOf(conn: string): string | null {
    return this.grants.find((grant) => grant.conn === conn)?.id ?? null
  }

  /** Whether an agent is controlled now (for tests and the adapter) */
  grantOf(agent: string): ControlGrantRecord | null {
    const grant = this.grants.find((entry) => entry.agent === agent)
    return grant ? { ...grant } : null
  }

  /**
   * `controlRequest` from `member` on `conn` (RoomHost checked `requestControl`). Refused with the
   * first ControlErrorCode that applies; null when the request was made (and the view changed).
   */
  request(conn: string, member: string, agent: string): ControlErrorCode | null {
    const now = this.room.now()
    this.prune(now)
    if (!this.room.controlAllowed()) return 'control_off'
    const target = this.room.member(agent)
    const requester = this.room.member(member)
    // An agent that does not show its screen cannot be controlled: nobody could see where to click
    if (
      !requester ||
      requester.agent ||
      !target?.agent ||
      agent === member ||
      this.room.connOf(agent) === null ||
      !this.room.sharing(agent)
    ) {
      return 'control_not_agent'
    }
    if (this.room.groupOf(agent) !== this.room.groupOf(member)) return 'control_separated'
    if ((this.mutes.get(agent) ?? 0) > now) return 'control_muted'
    const busy = (entry: { agent: string }, who: string) => entry.agent === agent || who === member
    if (
      this.requests.some((entry) => busy(entry, entry.requester)) ||
      this.grants.some((entry) => busy(entry, entry.controller))
    ) {
      return 'control_busy'
    }
    const asked = recent(this.asked.get(member), now, CONTROL_REQUEST_RATE.windowMs)
    if (
      asked.length >= CONTROL_REQUEST_RATE.count ||
      (this.cooldowns.get(pairKey(member, agent)) ?? 0) > now
    ) {
      return 'control_cooldown'
    }
    this.asked.set(member, [...asked, now])
    const request: ControlRequestRecord = {
      id: newControlId(),
      agent,
      requester: member,
      name: requester.name,
      requesterConn: conn,
      agentConn: this.room.connOf(agent)!,
      since: now,
      until: now + CONTROL_REQUEST_TTL_MS,
    }
    this.requests.push(request)
    this.save()
    this.room.send(conn, { t: 'controlRequested', request: request.id, agent })
    const { roomName, createdBy } = this.room.roomLabel()
    this.room.post(request.agentConn, {
      t: 'controlAsk',
      request: request.id,
      from: { id: member, name: request.name },
      roomName,
      createdBy,
      ttlMs: CONTROL_REQUEST_TTL_MS,
    })
    return null
  }

  /** `controlCancel`: the requester withdraws its own request. Returns whether anything changed */
  cancel(member: string, requestId: string): boolean {
    const request = this.requests.find(
      (entry) => entry.id === requestId && entry.requester === member,
    )
    if (!request) return false
    this.endRequest(request, 'cancelled')
    return true
  }

  /**
   * `controlAnswer` on the agent's own socket (`conn`, member `agent`): the only way a grant is ever
   * made. An answer to a request that is not this agent's, or that already ended, does nothing.
   * Returns whether anything changed.
   */
  answer(conn: string, agent: string, message: ControlAnswerMessage): boolean {
    const request = this.requests.find(
      (entry) => entry.id === message.request && entry.agent === agent && entry.agentConn === conn,
    )
    if (!request) return false
    if (message.decision === 'deny') {
      this.endRequest(request, 'denied')
      return true
    }
    // The requester's socket must still be the one that asked (reconcile would end it otherwise)
    if (this.room.connOf(request.requester) !== request.requesterConn) {
      this.endRequest(request, 'requesterLeft')
      return true
    }
    const now = this.room.now()
    this.requests = this.requests.filter((entry) => entry !== request)
    const grant: ControlGrantRecord = {
      id: newControlId(),
      agent,
      controller: request.requester,
      name: request.name,
      conn: request.requesterConn,
      agentConn: conn,
      decision: message.decision,
      since: now,
      until: grantUntil(message.decision, now),
      last: 0,
      clipboard: message.clipboard === true,
      blocked: null,
    }
    this.grants.push(grant)
    this.save()
    this.room.send(grant.conn, {
      t: 'controlGranted',
      grant: grant.id,
      agent,
      until: grant.until,
    })
    // `durationMs` is an echo of the agent's own decision: the agent refuses any other (D5b)
    this.room.post(conn, {
      t: 'controlStart',
      request: request.id,
      grant: grant.id,
      controller: { id: grant.controller, name: grant.name },
      durationMs: CONTROL_GRANT_MS[message.decision],
    })
    this.room.tellEveryone({ t: 'notice', notice: 'controlStarted', by: grant.controller, agent })
    return true
  }

  /**
   * `controlEvent` from `member` on `conn`: forwarded to the agent only when this socket holds the
   * named grant, acceptSeq says `next` or `gap`, and it fits CONTROL_EVENT_RATE; over the rate only
   * its up events go (keeping the seq), and a batch with none is dropped without moving `last` (so
   * the next one forwarded is a `gap`, and the agent lets go of what it holds). A seq too far ahead
   * ends the grant (`desynced`). Returns whether the view changed.
   */
  event(conn: string, member: string, message: ControlEventMessage): boolean {
    const grant = this.grants.find((entry) => entry.id === message.grant)
    if (!grant || grant.conn !== conn || grant.controller !== member) return false
    const verdict = acceptSeq(grant.last, message.seq)
    if (verdict === 'stale') return false
    if (verdict === 'invalid') {
      this.endGrant(grant, 'desynced')
      return true
    }
    const take = takeControlEvents(
      this.windows.get(grant.id) ?? [],
      message.events.length,
      this.room.now(),
      CONTROL_EVENT_RATE,
    )
    this.windows.set(grant.id, take.window)
    const events = take.ok ? message.events : upEventsOnly(message.events)
    if (events.length === 0) return false
    grant.last = message.seq
    this.room.post(grant.agentConn, {
      t: 'controlForward',
      grant: grant.id,
      seq: message.seq,
      events,
    })
    this.seqChanged()
    return false
  }

  /**
   * `controlStatus` from the agent's own socket (N5): what pauses its injection now, and whether
   * pasting is still allowed. Pasting can only be turned off here, never on (on is the consent
   * dialog's, `controlAnswer.clipboard`). Returns whether the view changed.
   */
  status(conn: string, agent: string, message: ControlStatusMessage): boolean {
    const grant = this.grants.find(
      (entry) => entry.id === message.grant && entry.agent === agent && entry.agentConn === conn,
    )
    if (!grant) return false
    const clipboard = grant.clipboard === true && message.clipboard
    const blocked = message.blocked
    if (clipboard === (grant.clipboard === true) && blocked === (grant.blocked ?? null))
      return false
    grant.clipboard = clipboard
    grant.blocked = blocked
    this.save()
    return true
  }

  /**
   * `controlClipboard` from `member` on `conn` (N5, e9-t09): forwarded to the agent as
   * `controlPaste` only from the socket holding the named grant, when it allows pasting and within
   * CONTROL_CLIPBOARD_RATE; everyone is told (`controlPasted`), never the text, and nothing of it is
   * stored. `ignored` for a grant this socket does not hold (dropped quietly, as `controlEvent`);
   * `control_clipboard_off` when the grant takes no paste now; null when it went.
   */
  paste(
    conn: string,
    member: string,
    message: ControlClipboardMessage,
  ): 'ignored' | 'control_clipboard_off' | null {
    const grant = this.grants.find((entry) => entry.id === message.grant)
    if (!grant || grant.conn !== conn || grant.controller !== member) return 'ignored'
    if (grant.clipboard !== true) return 'control_clipboard_off'
    const take = takeControlEvents(
      this.pastes.get(grant.id) ?? [],
      1,
      this.room.now(),
      CONTROL_CLIPBOARD_RATE,
    )
    this.pastes.set(grant.id, take.window)
    if (!take.ok) return 'control_clipboard_off'
    this.room.post(grant.agentConn, { t: 'controlPaste', grant: grant.id, text: message.text })
    this.room.tellEveryone({
      t: 'notice',
      notice: 'controlPasted',
      by: grant.controller,
      agent: grant.agent,
    })
    return null
  }

  /** `controlStop` from the controller: its own grant only. Returns whether anything changed */
  stop(conn: string, member: string, grantId: string): boolean {
    const grant = this.grants.find(
      (entry) => entry.id === grantId && entry.conn === conn && entry.controller === member,
    )
    if (!grant) return false
    this.endGrant(grant, 'controllerStopped')
    return true
  }

  /** `controlStop` from the agent's own socket: the person at the computer stopped it */
  agentStop(conn: string, agent: string, grantId: string): boolean {
    const grant = this.grants.find(
      (entry) => entry.id === grantId && entry.agent === agent && entry.agentConn === conn,
    )
    if (!grant) return false
    this.endGrant(grant, 'agentStopped')
    return true
  }

  /**
   * `controlMute` from the agent: no requests for `ms` (0 takes them again, the deny limit's mute
   * too). A request waiting for this agent ends (`muted`). Returns whether the view changed.
   */
  mute(conn: string, agent: string, ms: number): boolean {
    const now = this.room.now()
    if (ms === 0) {
      this.mutes.delete(agent)
      this.denies.delete(agent)
    } else {
      this.mutes.set(agent, now + ms)
    }
    const request = this.requests.find((entry) => entry.agent === agent && entry.agentConn === conn)
    if (request) this.endRequest(request, 'muted')
    else this.save()
    return request !== undefined
  }

  /** `host` `stopControl` (RoomHost checked the role): ends the agent's grant, if any */
  hostStop(agent: string): boolean {
    const grant = this.grants.find((entry) => entry.agent === agent)
    if (!grant) return false
    this.endGrant(grant, 'hostStopped')
    return true
  }

  /**
   * Ends whatever no longer holds (RoomHost runs it on every publish, before the view): a request or
   * grant whose either socket is not the one it was made on any more (left, removed, dropped,
   * reconnected, taken over: `requesterLeft` / `controllerLeft` / `agentLeft`), whose two members
   * are in different breakout rooms (`separated`), or in a room where control was turned off
   * (`controlOff`). Returns whether anything ended.
   */
  reconcile(): boolean {
    let changed = false
    const allowed = this.room.controlAllowed()
    const present = (member: string, conn: string) =>
      this.room.member(member) !== undefined && this.room.connOf(member) === conn
    for (const request of [...this.requests]) {
      const reason: ControlRequestEndReason | null = !present(
        request.requester,
        request.requesterConn,
      )
        ? 'requesterLeft'
        : !present(request.agent, request.agentConn)
          ? 'agentLeft'
          : this.room.groupOf(request.agent) !== this.room.groupOf(request.requester)
            ? 'separated'
            : !allowed
              ? 'controlOff'
              : null
      if (reason === null) continue
      this.endRequest(request, reason)
      changed = true
    }
    for (const grant of [...this.grants]) {
      const reason: ControlEndReason | null = !present(grant.controller, grant.conn)
        ? 'controllerLeft'
        : !present(grant.agent, grant.agentConn)
          ? 'agentLeft'
          : this.room.groupOf(grant.agent) !== this.room.groupOf(grant.controller)
            ? 'separated'
            : !allowed
              ? 'controlOff'
              : null
      if (reason === null) continue
      this.endGrant(grant, reason)
      changed = true
    }
    return changed
  }

  /**
   * The `control` job: requests nobody answered within CONTROL_REQUEST_TTL_MS (a deny), grants whose
   * time is up (`expired`; the agent stops on its own clock too), and the limits that ran out.
   * Returns whether the view changed.
   */
  tick(): boolean {
    const now = this.room.now()
    let changed = false
    for (const request of [...this.requests]) {
      if (request.until > now) continue
      this.endRequest(request, 'expired')
      changed = true
    }
    for (const grant of [...this.grants]) {
      if (grant.until === null || grant.until > now) continue
      this.endGrant(grant, 'expired')
      changed = true
    }
    if (this.prune(now)) this.save()
    return changed
  }

  /** The meeting ended: everything ends, both sides told, before the sockets close */
  endAll(): void {
    for (const request of [...this.requests]) this.endRequest(request, 'meetingEnded')
    for (const grant of [...this.grants]) this.endGrant(grant, 'meetingEnded', false)
    this.reset()
  }

  /** Forgets everything (the room closed); nothing is saved */
  reset(): void {
    this.load(null)
  }

  /** When the `control` job should run next; null for nothing to wait for */
  due(): number | null {
    let next: number | null = null
    const at = (time: number) => {
      if (next === null || time < next) next = time
    }
    for (const request of this.requests) at(request.until)
    for (const grant of this.grants) if (grant.until !== null) at(grant.until)
    for (const until of this.cooldowns.values()) at(until)
    for (const until of this.mutes.values()) at(until)
    for (const times of this.asked.values()) {
      if (times.length > 0) at(times[0] + CONTROL_REQUEST_RATE.windowMs)
    }
    for (const times of this.denies.values()) {
      if (times.length > 0) at(times[0] + CONTROL_AGENT_DENY_LIMIT.windowMs)
    }
    return next
  }

  /** Stores the last seqs now (the adapter's timer, CONTROL_SEQ_SAVE_MS after a forward) */
  flushSeq(): void {
    if (!this.seqDirty) return
    this.seqDirty = false
    this.save()
  }

  // ── Endings ──────────────────────────────────────────────────────────────────────────────────

  private endRequest(request: ControlRequestRecord, reason: ControlRequestEndReason): void {
    const now = this.room.now()
    this.requests = this.requests.filter((entry) => entry !== request)
    // A deny, or nobody answering, counts against asking again (§5.2)
    if (reason === 'denied' || reason === 'expired') {
      this.cooldowns.set(pairKey(request.requester, request.agent), now + CONTROL_DENY_COOLDOWN_MS)
      const denies = [
        ...recent(this.denies.get(request.agent), now, CONTROL_AGENT_DENY_LIMIT.windowMs),
        now,
      ]
      if (denies.length >= CONTROL_AGENT_DENY_LIMIT.count) {
        this.denies.delete(request.agent)
        this.mutes.set(request.agent, Math.max(this.mutes.get(request.agent) ?? 0, now + CONTROL_AGENT_MUTE_MS))
      } else {
        this.denies.set(request.agent, denies)
      }
    }
    this.save()
    if (this.room.connOf(request.requester) === request.requesterConn) {
      this.room.send(request.requesterConn, {
        t: 'controlRefused',
        request: request.id,
        reason,
      })
    }
    // The agent answered a deny or a mute itself; anything else closes its dialog
    if (
      reason !== 'denied' &&
      reason !== 'muted' &&
      this.room.connOf(request.agent) === request.agentConn
    ) {
      this.room.post(request.agentConn, { t: 'controlAskEnd', request: request.id, reason })
    }
  }

  private endGrant(grant: ControlGrantRecord, reason: ControlEndReason, save = true): void {
    this.grants = this.grants.filter((entry) => entry !== grant)
    this.windows.delete(grant.id)
    this.pastes.delete(grant.id)
    if (save) this.save()
    const end = { t: 'controlEnd', grant: grant.id, reason } as const
    if (this.room.connOf(grant.controller) === grant.conn) this.room.send(grant.conn, end)
    if (this.room.connOf(grant.agent) === grant.agentConn) this.room.post(grant.agentConn, end)
    this.room.tellEveryone({
      t: 'notice',
      notice: 'controlEnded',
      by: grant.controller,
      agent: grant.agent,
      reason,
    })
  }

  // ── Storage ──────────────────────────────────────────────────────────────────────────────────

  private save(): void {
    this.seqDirty = false
    this.room.save(this.stored)
  }

  private seqChanged(): void {
    if (this.seqDirty) return
    this.seqDirty = true
    this.room.later?.(CONTROL_SEQ_SAVE_MS, () => this.flushSeq())
  }

  /** Drops the limits that ran out; whether anything went */
  private prune(now: number): boolean {
    let changed = false
    for (const [member, times] of this.asked) {
      const kept = recent(times, now, CONTROL_REQUEST_RATE.windowMs)
      if (kept.length === times.length) continue
      changed = true
      if (kept.length === 0) this.asked.delete(member)
      else this.asked.set(member, kept)
    }
    for (const [agent, times] of this.denies) {
      const kept = recent(times, now, CONTROL_AGENT_DENY_LIMIT.windowMs)
      if (kept.length === times.length) continue
      changed = true
      if (kept.length === 0) this.denies.delete(agent)
      else this.denies.set(agent, kept)
    }
    for (const map of [this.cooldowns, this.mutes]) {
      for (const [key, until] of map) {
        if (until > now) continue
        map.delete(key)
        changed = true
      }
    }
    return changed
  }
}

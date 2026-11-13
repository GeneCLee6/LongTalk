// The messages between a browser and its room's Durable Object (RoomDO), over one WebSocket per
// member: GET /api/rooms/<roomId>/ws?v=<PROTOCOL_VERSION>. Shared by the Worker and the browser.
//
// 1. The browser opens the socket and sends `join` (its name, and the session token it was given
//    last time, if any). The server answers `welcome`: the member's id, the session token to keep
//    and the whole room (`state`). A token the room still knows (the member is connected, or
//    disconnected for less than RECONNECT_GRACE_MS) brings back the same member; any other token
//    makes a new member. A socket that does not join within JOIN_TIMEOUT_MS is closed.
// 2. Every change after that is a `patch` (shared/patch.ts) numbered `rev`, sent to everyone.
//    A browser that sees a gap in `rev` sends `resync` and gets a `snapshot`.
// 3. Heartbeat: the browser sends the text frame `ping` every HEARTBEAT_INTERVAL_MS and gets
//    `pong` (answered without waking the object); a socket silent for STALE_AFTER_MS is closed.
// 4. A socket that closes without `leave` (reload, network) leaves its member in the room marked
//    `reconnecting` for RECONNECT_GRACE_MS; `leave` removes the member at once.
//
// 5. Media (B1): a member creates its SFU session through the Worker proxy (/api/sfu/<roomId>/*,
//    authorised with its session token; the room records the session as the member's), publishes,
//    and sends `tracks` with what it publishes now. The room puts the list in `Member.tracks` and
//    everyone subscribes from it. Every STATS_INTERVAL_MS the browser sends `stats` (bytes it
//    received), which the room counts towards the month's egress (shared/usage.ts); the month's
//    state is `RoomView.usage`.
// 6. Mute (B2): every track in `tracks` carries `muted`. Turning the microphone or camera off
//    keeps the track published (the sender stops sending, nothing is renegotiated) and sends
//    `tracks` again with `muted: true`; everyone sees it in `Member.tracks`. A member with no
//    track of a kind (never opened, or refused) counts as muted for that kind.
// 7. Reconnect (B3): a socket that drops (not one closed with a 44xx code but `stale`) is opened
//    again by the browser with exponential backoff and jitter, joining with the same token, so
//    within RECONNECT_GRACE_MS it is the same member with the same tracks; the browser sends
//    `tracks` again after every `welcome`, for anything it changed while the socket was down.
//    `stats` also says whether the browser's media goes through a TURN relay (`relay`), which the
//    free-tier guard counts with TURN's overhead (shared/usage.ts).
// 8. Host and lifecycle (C2): the first member to join is the host (`Member.role`); a host that
//    leaves, or stays reconnecting for HOST_HANDOFF_MS, hands the role to the earliest-joined
//    connected member. A room with nobody in it (no member, no socket) for EMPTY_ROOM_TTL_MS is
//    closed: its state is deleted and its id answers 404 / CloseCode.roomNotFound from then on.
// 9. Names (C2): `rename` changes the member's own display name; `renameRoom` changes the room's
//    name (`RoomInfo.name`; null shows a default made from `createdBy`), host only for now
//    (worker/roles.ts arrives with e1-t06). A refused `renameRoom` is answered with `error`
//    code `forbidden`.
// 10. Screen sharing (D1; several at once from H5, e3-t07): up to MAX_SHARES members share at the
//    same time (`RoomInfo.shares`, by member id). A member who picked what to share sends
//    `share`; the room grants it when fewer than MAX_SHARES share (or the member already does)
//    and answers `error` code `share_full` otherwise: nobody's share is taken away. Once granted,
//    the sharer publishes its screen like any track and lists it in `tracks` (kind `screen`); a
//    `screen` track from a member who does not share is dropped from its list. `unshare` ends the
//    member's own share; leaving, or being removed after RECONNECT_GRACE_MS, ends it too. A host
//    or co-host stops anyone's share with `host` `stopShare` (12. below). Every browser decides
//    for itself which share is in its main area (shared/layout.ts mainShare: the latest unless
//    the viewer chose another); the others go in the strip. In an audio-only month
//    (shared/usage.ts) `share` is refused with `audio_only`: the SFU proxy would refuse the
//    screen's video anyway.
// 11. Chat (D3, shared/chat.ts): `chat` sends a message (≤ MAX_CHAT_CHARS, normalizeChatText on
//    both ends). The room keeps the latest CHAT_HISTORY messages in storage, apart from the view
//    (no patch carries chat): right after every `welcome` it sends the whole history as `chat`
//    frames of at most CHAT_CHUNK messages, the first with `reset` (replace what you have, which
//    also brings a member who reconnected up to date), and every accepted message after that as
//    `chat` with that one message, to everyone (the sender too: that is its acknowledgement).
//    A member over CHAT_RATE is answered `error` code `rate_limited`.
// 12. Host controls (F1, e1-t07): `host` asks the room to act on one member (`muteMember`,
//    `camOff`, `stopShare`, `remove`) or on the whole room (`muteAll`, `endMeeting`). The room
//    decides with worker/roles.ts (shared/roles.ts' table) and answers `error` code `forbidden`
//    when the member may not. Muting and turning a camera off mark the track `muted` in the
//    target's list at once and send the target `notice`, on which its browser turns the
//    microphone or camera off itself (and says so); nobody can turn anyone else's back on, only
//    the member themselves. Stopping a share ends it like `unshare` and sends `notice` too.
//    `remove` closes the member's socket with CloseCode.removed and bans its browser (the `client`
//    id every `join` carries) for BAN_MS: a `join` from it is closed with CloseCode.removed until
//    then. `endMeeting` closes every socket with CloseCode.ended and the room at once (its id
//    answers 404 / CloseCode.roomNotFound from then on, like a room closed when empty).
// 13. Lock and waiting room (F2, e1-t09, e1-t10): `host` `lock` / `waitingRoom` with `on` switch
//    `RoomInfo.locked` / `RoomInfo.waitingRoom` (worker/roles.ts `lockRoom`, `waitingRoom`).
//    A locked room closes every `join` with a token it does not know with CloseCode.locked; a
//    member coming back within RECONNECT_GRACE_MS (its token) still gets in, and so does
//    someone already waiting. With the waiting room on, someone new joins as `waiting`: instead
//    of `welcome` the room sends `lobby` (its id, token, place in the queue, the room's name and
//    whether someone who can admit is connected), again whenever that changes, and nothing
//    else: no view, no patch, no chat; the SFU proxy and TURN refuse it (`media`). Everyone in
//    the room sees who waits in `RoomView.waiting`. `admit` (one), `admitAll` and `deny`
//    (worker/roles.ts `admit`) decide: an admitted member gets its `welcome` and the chat
//    history and is a participant from then on; a denied one is closed with CloseCode.denied
//    and its browser cannot ask again for DENY_COOLDOWN_MS. Turning the waiting room off admits
//    everyone in it. Someone waiting WAIT_TIMEOUT_MS is closed with CloseCode.waitExpired.
// 14. Spotlight (G2, e4-t11): `spotlight` with a member's id puts that member in everyone's main
//    area (`RoomInfo.spotlight`); with null it ends the spotlight (worker/roles.ts `spotlight`:
//    host or co-host; refused with `forbidden`, also for an id that is not a member in the room).
//    One at a time: a new spotlight replaces the old. It ends when the member leaves or is
//    removed, not while they reconnect. Each browser decides how to show it: a member's own pin
//    (local, never sent) wins over the spotlight, and a share keeps the main area (shared/layout.ts).
// 15. Password (F3, e1-t15): `host` `setPassword` (worker/roles.ts `setPassword`: the host) sets,
//    changes or clears (null) the room's password; the room keeps only a salted digest
//    (worker/password.ts) and everyone sees when it was set (`RoomInfo.passwordSetAt`, null for
//    none). Someone new sends the password in `join` (never in a URL). The order a `join` is
//    checked in: a ban; a token the room knows (a member within RECONNECT_GRACE_MS, or someone
//    waiting: no password asked again); the lock; the password; then the waiting room. No
//    password: CloseCode.passwordRequired; a wrong one: CloseCode.passwordWrong;
//    PASSWORD_MAX_FAILS wrong ones in a row from a browser or a network address:
//    CloseCode.passwordWait, the close reason being the milliseconds left to wait.
// 16. Co-hosts and handing over (F3, e1-t16): `host` `setCohost` (`on`) makes a participant a
//    co-host or a co-host a participant again; `makeHost` hands the host role to a connected
//    member, the previous host becoming a co-host (worker/roles.ts: the host only). The member
//    gets `notice` (`madeCohost`, `cohostRevoked`, `madeHost`) before the patch that shows it.
//    A host leaving hands the role to whom `leave.host` names, else to the earliest-joined
//    connected co-host, else member.
// 17. Ending (F3, e1-t17): after `endMeeting` the room remembers for ENDED_TOMBSTONE_MS that it
//    ended: a socket opening then (a member coming back from a dropped connection) is closed with
//    CloseCode.ended instead of CloseCode.roomNotFound.
// 18. Reactions (G3, e5-t03, shared/reactions.ts): `react` with one of REACTIONS goes to everyone
//    in the room (the sender too) as `reaction` with the sender's id, at once and nowhere else:
//    the room keeps no record, someone joining later never sees it. Over REACTION_RATE the room
//    drops it without an answer (worker/roles.ts `react`; someone waiting may not).
// 19. Raised hands (G3, e5-t04): `hand` `up` raises or lowers the member's own hand
//    (worker/roles.ts `raiseHand`); `Member.hand` is when it went up (the server's clock), null
//    while it is down, and the queue is in that order (handQueue). Raising a hand already up
//    keeps its place. `host` `lowerHand` lowers someone else's (worker/roles.ts `lowerHand`: a
//    host or co-host, on someone ranked below), who gets `notice` `handLowered`. A hand stays up
//    while its member reconnects and goes with the member.
// 20. Signal (H2, e2-t13): every browser judges its own connection from its getStats()
//    (src/media/quality.ts) and sends `signal` with the level (good, fair, poor) when it changes,
//    at most once every SIGNAL_REPORT_MS; the room puts it in `Member.signal` (null until the
//    first report) for everyone's nameplates. More than SIGNAL_RATE is dropped without an answer,
//    and so is one from someone waiting. The level stays while the member reconnects.
// 21. Local recording (I4, e8-t02; CLAUDE.md rule 4): a member records in their own browser
//    (src/record/), but only once the room says so, so everyone knows first. `record` `on` asks;
//    the room grants it to the host (worker/roles.ts `record`) or a member the host allowed
//    (`Member.mayRecord`, `host` `allowRecord`), lists it in `RoomInfo.recordings` (who, since
//    when) for everyone and the pre-join screen (GET /api/rooms/<id>), and the browser starts
//    recording when it sees itself there. Refused with `forbidden`. `record` off ends it. Leaving,
//    or being removed after RECONNECT_GRACE_MS, ends it too (a member reconnecting keeps it: its
//    browser goes on recording). The host stops anyone's with `host` `stopRecording`: the
//    recorder gets `notice` `recordingStopped` and its browser stops and saves the file. Taking
//    the permission away (`allowRecord` off) stops a recording it allowed the same way. Several
//    members may record at once (each their own file).
// 22. Recording consent (I4, CLAUDE.md rule 4 「明確同意」): everyone in the meeting but the
//    recorder must agree to each recording. `consent` agrees to every recording on now; the room
//    adds the member to each one's `RecordingInfo.consented`. Until a member agrees, their browser
//    blocks the room with the question, and the recorder leaves their camera, screen and sound out
//    of the file. A member who has not agreed CONSENT_TIMEOUT_MS after the recording started, or
//    after they came in (joined, were admitted from the waiting room, reconnected), whichever is
//    later, is treated as declining: the room closes their socket with
//    CloseCode.recordingDeclined and removes them at once (no ban: they may come back and agree).
//    Declining in the browser is leaving. Someone waiting is told the meeting is being recorded in
//    `lobby.recording`; the pre-join screen asks for the agreement before 加入.
// 23. Annotations on a share (J2, e7-t04; shared/annotation.ts): each share has its own layer, keyed
//    by the sharer's member id. `annotate` carries the ops a browser made since its last frame, at
//    most one frame every ANNOTATION_SEND_MS; the room decides (worker/roles.ts `annotate`), keeps
//    the strokes, and sends what it accepted to everyone else in the room as `annotation` (the
//    sender drew it already: it only hears back about what it should take away). No patch carries
//    strokes. Right after every `welcome`, also a reconnect's, the room sends the whole set as
//    `annotations` frames: the first has `reset` (forget everything you have), the last `done`.
//    Strokes are written to storage in batches (ANNOTATION_FLUSH_MS), so they outlast hibernation
//    and eviction; a share stopping clears its layer, for everyone and in storage. `laser` ops are
//    only passed on. Over the limits (shared/annotation-limits.ts) a frame or stroke is refused:
//    `error` code `annotation_limit`, and a refused stroke comes back as `remove`; past the size
//    limits the oldest strokes fall out, as `remove` to everyone.
// 24. Who may annotate (J3, e7-t05; shared/roles.ts mayDraw): `RoomInfo.annotationPolicy`, changed
//    with `host` `annotationPolicy` (a host or co-host; everyone else gets a `notice`). The room
//    refuses what the policy forbids op by op: `add`, `update` and `laser` from someone who may not
//    draw get `error` `forbidden` and a refused stroke comes back removed, while taking back one's
//    own marks stays allowed. `clearAnnotations` clears a layer, or (`by`) one member's strokes on
//    it (shared/roles.ts mayClearLayer: a host, a co-host, the layer's owner): everyone gets the
//    `annotation` `clear`, the people affected a `notice` `annotationsCleared`.
// 25. The whiteboard (J3, e7-t06): `whiteboard` opens it (`RoomInfo.whiteboard`: who, since when) or
//    closes it (the strokes stay until someone clears them or the meeting ends). Its strokes are one
//    more layer (shared/annotation.ts WHITEBOARD_LAYER), in world coordinates, on the same `annotate`,
//    `annotation` and `annotations` messages. Past its limits a new stroke is refused
//    (`annotation_limit`); nothing falls out.
// 26. Polls (L5, e5-t07; shared/interact.ts): a host or co-host (worker/roles.ts `poll`) sends
//    `pollStart`; one poll at a time, another is refused with `poll_active`. The poll on now is
//    `RoomView.poll`, with its counts live for everyone; on an anonymous one the view never says
//    who voted what, so what a member answered comes back to that member alone as `pollVoted`, on
//    voting and after every `welcome`. `pollVote` (worker/roles.ts `votePoll`) replaces the member's
//    earlier answer. `pollEnd` takes it off the view and the room writes the results into the chat,
//    a message from who ended it with `ChatMessage.poll`.
// 27. The countdown and the agenda (L5, e5-t08): `timer` sets `RoomView.timer` (null ends it), and
//    `agenda` / `agendaCurrent` set `RoomView.agenda` and which item is on (worker/roles.ts `timer`,
//    `agenda`: a host or co-host). Each browser counts down from `endsAt` on its own clock.
// 28. What a persistent room's owner set on /me (L5, e1-t18): `RoomInfo.startMuted` has each
//    participant who comes in told `notice` `startMuted`, once, on which its browser turns the
//    microphone off (only they can turn it on again, as ever). With `RoomInfo.allowAnnotation` false
//    `annotationPolicy` stays `off` and `host` `annotationPolicy` is refused; with
//    `RoomInfo.allowRecording` false `record` is refused for everyone, the host too. Allowing never
//    grants anything: who may record and everyone's consent (21., 22.) stay as they are.
// 29. Breakout rooms (L3, e10-t04; shared/breakout.ts): a host or co-host (worker/roles.ts
//    `breakout`) sends `breakoutOpen` with the rooms' names, who goes where (member id → index) and
//    how long (null: until recalled); a second one while they are open is refused with
//    `breakout_active`. `RoomView.breakout` is the rooms; `Member.group` is where each member is
//    (null or absent: the main room). `breakoutMove` puts one member (the actor too: that is how a
//    host enters or leaves a room) in a room or back in the main room. Late joiners and people
//    admitted from the waiting room land in the main room; a reconnect keeps its room.
//    `breakoutBroadcast` sets `BreakoutView.broadcast` for every room. `breakoutClose` (or the time
//    running out) starts a recall: `closesAt` is BREAKOUT_RECALL_MS away, and then everyone is back
//    in the main room and `breakout` is null; `breakoutClose` with `now` ends them at once. Opening
//    the rooms ends the poll on now (its results go to the main room's chat) and stops every
//    recording (`notice` `recordingStopped`); while they are open `record` is refused with
//    `breakout_active`. A move or the end of the rooms that leaves more than MAX_SHARES shares in one
//    room stops the newest ones (`notice` `shareStopped`). The room refuses an SFU pull of a track whose owner is in another room (the proxy answers
//    `track_not_in_room`), so each browser scopes its view to its own room (scopeView). Chat follows
//    the sender: a message carries the sender's `ChatMessage.group`, and a member is sent only the
//    messages of the room it is in; on a move it gets that room's history again (`reset`, every
//    frame of it marked `regroup`: history, not news). Strokes on a share go to the sharer's room
//    only; whoever changes rooms, or sees a share arrive with its sharer, gets the strokes again. While the
//    rooms are open `spotlight`, opening the whiteboard and `pollStart` are refused with
//    `breakout_active`; opening them clears the spotlight and closes the whiteboard.
// 30. Pairing a computer (N2, e9-t02; shared/control.ts, docs/PRD/f-remote-control-security.md
//    §5.1): any member in the room (worker/roles.ts `pairComputer`) sends `pairStart`; the room
//    answers that member alone with `pairCode` (a one-time code, PAIRING_CODE_TTL_MS), replacing
//    any code they had. `pairCancel` voids it. The desktop agent brings the code on its own socket
//    (/api/rooms/<id>/agent, never this one) and becomes a member with `Member.agent` (who issued the
//    code, the computer's name, its platform), shown as 「<owner> 的電腦」. The owner is told
//    (`notice` `agentPaired`, `by`: the agent's member id) and may remove it at once with
//    `agentRemove` (「這不是我」); a host may remove it like anyone (`host` `remove`). One computer
//    per member: a new pairing replaces nothing, it is refused until the old one leaves. When too
//    many wrong codes void every open code the issuers get `notice` `pairingVoided`. An agent shares
//    its screen through the same `share` / `tracks` as a browser, on its own socket.
// 31. Remote control (N3, e9-t04, e9-t05; shared/control.ts, docs/PRD/f-remote-control-security.md
//    §5.2–§5.7): a member in the room (worker/roles.ts `requestControl`) sends `controlRequest`
//    naming an agent that shares its screen in the same breakout room; refusals are the
//    ControlErrorCode errors. The room answers `controlRequested` (the request id, for
//    `controlCancel`), shows it to everyone in `RoomView.control` (`asking`) and asks the agent. Only
//    the agent's own socket can answer; a deny, an unanswered CONTROL_REQUEST_TTL_MS or a cancel ends
//    it with `controlRefused`. An allow makes a grant bound to the requester's socket:
//    `controlGranted` (the grant id, until when), `RoomView.control` turns `granted`, and everyone
//    gets `notice` `controlStarted` (`by`: the controller, `agent`). The controller sends
//    `controlEvent` batches (the grant id, seq, events); the room forwards those that pass (the
//    socket holding the grant, acceptSeq, CONTROL_EVENT_RATE) and drops the rest. Such a batch is
//    out of the per-socket SOCKET_MESSAGE_RATE (CONTROL_FRAME_RATE instead); anything else labelled
//    `controlEvent` still counts. `controlStop` ends one's own grant, `host` `stopControl` (a host or
//    co-host, `memberId`: the agent) anyone's; every other ending (the socket closing, a breakout
//    move, the time, the room setting `RoomInfo.allowControl`…) is the room's. The controller gets
//    `controlEnd` with the reason and everyone `notice` `controlEnded` (`reason`).
//
// v1 → v2 (A4): `join`, `leave`, `welcome.token`, `Member.name` / `reconnecting`.
// v2 → v3 (B1): `tracks`, `stats`, `Member.tracks`, `RoomView.usage`.
// v3 → v4 (B2): `MemberTrack.muted`, and `muted` on every entry of `tracks`.
// v4 → v5 (B3): `stats.relay`; the browser reconnects on its own (also after `stale`).
// v5 → v6 (C2): `Member.role`, `RoomInfo.name` / `createdBy` / `startedAt`, `rename`,
//   `renameRoom`, error code `forbidden`.
// v6 → v7 (D1): `RoomInfo.share`, `share`, `unshare`, error codes `share_busy`, `audio_only`.
// v7 → v8 (D3): `chat` both ways, error code `rate_limited`; MAX_CLIENT_MESSAGE_CHARS 4096 → 16384.
// v8 → v9 (F1): `join.client`, `host`, `notice`, roles `cohost` / `waiting`, close codes
//   `removed`, `ended`.
// v9 → v10 (F2): `RoomInfo.locked` / `waitingRoom`, `RoomView.waiting`, `lobby`, `host` actions
//   `lock`, `waitingRoom`, `admit`, `admitAll`, `deny`, close codes `locked`, `denied`,
//   `waitExpired`.
// v10 → v11 (G2): `RoomInfo.spotlight`, `spotlight`.
// v11 → v12 (F3): `join.password`, `RoomInfo.passwordSetAt`, `host` actions `setPassword`,
//   `setCohost`, `makeHost`, `leave.host`, notices `madeCohost`, `cohostRevoked`, `madeHost`,
//   close codes `passwordRequired`, `passwordWrong`, `passwordWait`.
// v12 → v13 (G3): `react`, `reaction`, `Member.hand`, `hand`, `host` action `lowerHand`, notice
//   `handLowered`.
// v13 → v14 (H2): `signal`, `Member.signal`.
// v14 → v15 (H5): `RoomInfo.shares` (up to MAX_SHARES) replaces `RoomInfo.share`; `share` has no
//   `takeOver`; error code `share_full` replaces `share_busy`.
// v15 → v16 (I1): close code `rateLimited`; a frame over MAX_CLIENT_MESSAGE_CHARS closes the
//   socket with 1009 instead of answering `bad_message`.
// v16 → v17 (I4): `RoomInfo.recordings`, `Member.mayRecord`, `record`, `host` actions
//   `stopRecording`, `allowRecord`, notices `recordingStopped`, `recordAllowed`, `recordRevoked`.
//   A v16 browser could not show that the room records, so it is refused like any older one.
//   Also `RecordingInfo.consented`, `consent`, `lobby.recording`, close code `recordingDeclined`.
// v17 → v18 (I2): `RoomInfo.persistent` (a personal persistent room, /r/<slug>: its ended screen
//   offers to come back, the room is still there). Room keys may be slugs (shared/slug.ts).
// v18 → v19 (I5): `ChatMessage.file`: a shared file, a message the room writes itself when the
//   upload through the Worker finishes (worker/files.ts). The rest of the flow is HTTP, not this
//   socket. A v18 browser would show only the name, with no way to open it.
// v19 → v20 (J2): `annotate`, `annotation`, `annotations`, error code `annotation_limit`. A v19
//   browser would neither show the strokes nor send its own.
// v20 → v21 (J3): `RoomInfo.annotationPolicy` / `whiteboard`, `host` action `annotationPolicy`,
//   `clearAnnotations`, `whiteboard`, notices `annotationPolicy`, `annotationsCleared`. A v20 browser
//   would show a toolbar that is refused and could not parse the whiteboard's points.
// v21 → v22 (L5): `pollStart`, `pollVote`, `pollEnd`, `pollVoted`, `timer`, `agenda`, `agendaCurrent`,
//   `RoomView.poll` / `timer` / `agenda`, `ChatMessage.poll`, error code `poll_active`,
//   `RoomInfo.startMuted` / `allowAnnotation` / `allowRecording`, notice `startMuted`. A v21 browser
//   would not show the poll, and would stay unmuted in a room that asks otherwise.
// v22 → v23 (L3): `breakoutOpen`, `breakoutMove`, `breakoutBroadcast`, `breakoutClose`,
//   `RoomView.breakout`, `Member.group`, `ChatMessage.group`, error code `breakout_active`. A v22
//   browser would subscribe to members outside its room (refused) and see every room's chat.
// v23 → v24 (N2): `pairStart`, `pairCancel`, `pairCode`, `agentRemove`, `Member.agent`, notices
//   `agentPaired`, `pairingVoided`, error code `pair_busy`. A v23 browser would show a desktop
//   agent as a stranger with a strange name.
// v26 → v27 (N3): `controlRequest`, `controlCancel`, `controlEvent`, `controlStop`,
//   `controlRequested`, `controlRefused`, `controlGranted`, `controlEnd`, `RoomView.control`,
//   `RoomInfo.allowControl`, `host` action `stopControl`, notices `controlStarted`,
//   `controlEnded` (`NoticeMessage.agent`, `reason`), the ControlErrorCode errors. A v26 browser
//   would not show that someone controls a computer in the room.
// A browser of an older version is refused at the upgrade with CloseCode.versionMismatch and told
// to reload.
//
// View types are `type` aliases, not interfaces, so they stay assignable to JsonValue.
import {
  MAX_BREAKOUT_GROUPS,
  MAX_BREAKOUT_MINUTES,
  MAX_BREAKOUT_NAME_CHARS,
  MAX_BROADCAST_CHARS,
  type BreakoutView,
} from './breakout.ts'
import { parseAnnotationOps, spaceOf, type AnnotationOp, type Stroke } from './annotation.ts'
import { isChatMessage, normalizeChatText, type ChatMessage } from './chat.ts'
import {
  MAX_AGENDA_ITEMS,
  MAX_AGENDA_MINUTES,
  MAX_AGENDA_TITLE_CHARS,
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_CHARS,
  MAX_POLL_QUESTION_CHARS,
  MAX_TIMER_SECONDS,
  MIN_POLL_OPTIONS,
  type AgendaInfo,
  type AgendaItem,
  type PollView,
  type TimerInfo,
} from './interact.ts'
import type { JsonValue, PatchOp } from './patch.ts'
import { normalizePassword } from './password.ts'
import { isReaction, type Reaction } from './reactions.ts'
import { isAnnotationPolicy, type AnnotationPolicy, type Role } from './roles.ts'
import type { UsageState } from './usage.ts'
import {
  parseControlClientMessage,
  type AgentPlatform,
  type ControlClientMessage,
  type ControlEndReason,
  type ControlErrorCode,
  type ControllerServerMessage,
  type ControlView,
} from './control.ts'

/** Bumped on any change a browser of the previous version could not understand */
export const PROTOCOL_VERSION = 27

export const HEARTBEAT_PING = 'ping'
export const HEARTBEAT_PONG = 'pong'
export const HEARTBEAT_INTERVAL_MS = 15_000
/** Three missed heartbeats */
export const STALE_AFTER_MS = 45_000
/** How often the room checks for stale sockets and expired members while anyone is in it */
export const SWEEP_INTERVAL_MS = 15_000
/** A socket must send `join` this soon after opening */
export const JOIN_TIMEOUT_MS = 10_000
/** How long a disconnected member keeps its place (ARCHITECTURE.md §4) */
export const RECONNECT_GRACE_MS = 60_000

/**
 * Hard cap on members connected to one room: M2's target (F32, AC-10.3). M3 raises it to 50 (F36)
 * once its load test has passed (e10-t07)
 */
export const MAX_MEMBERS = 25
/** Sockets that opened but have not joined yet, on top of MAX_MEMBERS */
export const MAX_PENDING_SOCKETS = 10
/**
 * Client messages larger than this (UTF-16 code units) are refused without parsing: room for a
 * MAX_CHAT_CHARS message of astral characters (2 units each) with every escape JSON may add
 */
export const MAX_CLIENT_MESSAGE_CHARS = 16_384
/** A display name's length in characters (code points), after normalizeName */
export const MAX_NAME_CHARS = 40
/** A room name's length in characters (code points), after normalizeName */
export const MAX_ROOM_NAME_CHARS = 60

/** A room with nobody in it (no member, no socket) is closed after this long (AC-1.3) */
export const EMPTY_ROOM_TTL_MS = 10 * 60_000
/** A host reconnecting for this long hands the role to a connected member (AC-1.3) */
export const HOST_HANDOFF_MS = 60_000
/** A removed member's browser cannot join the room again for this long (AC-1.4) */
export const BAN_MS = 10 * 60_000
/** The most browsers a room keeps banned at once (the oldest ban goes first) */
export const MAX_BANS = 200
/** A browser turned away from the waiting room cannot ask again for this long (F2) */
export const DENY_COOLDOWN_MS = 60_000
/** Someone waiting this long without being admitted is sent away (F2) */
export const WAIT_TIMEOUT_MS = 15 * 60_000
/** An ended meeting's room answers CloseCode.ended, not roomNotFound, for this long (F3) */
export const ENDED_TOMBSTONE_MS = 10 * 60_000
/** A member who has not agreed to a recording this long is treated as declining (I4) */
export const CONSENT_TIMEOUT_MS = 60_000

/**
 * WebSocket close codes the server uses. The browser does not reconnect after the 44xx ones but
 * `stale` (a socket the server stopped hearing from, e.g. a phone that slept: the member is
 * reconnecting and comes back with its token)
 */
export const CloseCode = {
  /** The browser speaks another protocol version: reload the page */
  versionMismatch: 4400,
  /** No room with this id (never created, or closed) */
  roomNotFound: 4404,
  /** MAX_MEMBERS already connected */
  roomFull: 4409,
  /** No heartbeat for STALE_AFTER_MS, or no `join` within JOIN_TIMEOUT_MS */
  stale: 4408,
  /** The same session joined from another socket (a second tab, or a reload that beat the close) */
  replaced: 4410,
  /** The host removed this member, or its browser is still banned (BAN_MS, F1) */
  removed: 4403,
  /** The host ended the meeting: the room is closed (F1) */
  ended: 4411,
  /** The room is locked: nobody new gets in, not even into the waiting room (F2) */
  locked: 4423,
  /** The host turned this browser away from the waiting room, or it asked again too soon (F2) */
  denied: 4406,
  /** Waited WAIT_TIMEOUT_MS without being admitted (F2) */
  waitExpired: 4412,
  /** The room has a password and `join` carried none (F3) */
  passwordRequired: 4401,
  /** The password in `join` is wrong (F3) */
  passwordWrong: 4402,
  /** Too many wrong passwords: wait; the close reason is the milliseconds left (F3) */
  passwordWait: 4429,
  /**
   * Abuse protection (I1): too many upgrades from one network into this room
   * (ROOM_CONNECT_RATE), or too many frames on one socket (SOCKET_MESSAGE_RATE)
   */
  rateLimited: 4420,
  /**
   * The member did not agree to a recording within CONSENT_TIMEOUT_MS (I4): removed, not banned;
   * the browser does not reconnect (joining again asks again)
   */
  recordingDeclined: 4413,
} as const

/** What POST /api/rooms decides about a room */
export type RoomInit = {
  id: string
  createdAt: number
}

/** The room as everyone sees it */
export type RoomInfo = RoomInit & {
  /** Set by the host (`renameRoom`); null shows the default name, made from `createdBy` */
  name: string | null
  /** The first member's name when it joined (null until someone joins) */
  createdBy: string | null
  /** When the first member joined: the top bar's elapsed time counts from it */
  startedAt: number | null
  /** Who shares the screen now, by member id (D1; up to MAX_SHARES at once from H5, e3-t07) */
  shares: Record<string, ShareInfo>
  /** Nobody new may join, not even into the waiting room (F2, e1-t09) */
  locked: boolean
  /** Someone new waits until a host or co-host admits them (F2, e1-t10) */
  waitingRoom: boolean
  /** The member a host or co-host put in everyone's main area (G2, e4-t11); null for nobody */
  spotlight: string | null
  /**
   * When the host last set the password (F3, e1-t15); null when the room has none. The password
   * itself never leaves the room (only a digest is kept)
   */
  passwordSetAt: number | null
  /**
   * A personal persistent room (I2, e1-t13): it outlives its meetings, keeping its name, password,
   * waiting room and lock. Who owns it is never sent (the room knows; the owner joins as host).
   * Absent means false
   */
  persistent?: boolean
  /**
   * Who records the meeting now, by member id (I4, e8-t02): everyone sees it (the top bar's red
   * light, the pre-join notice), CLAUDE.md rule 4
   */
  recordings: Record<string, RecordingInfo>
  /** Who may draw on the shares and the whiteboard (J3, e7-t05; shared/roles.ts) */
  annotationPolicy: AnnotationPolicy
  /** The whiteboard on the stage (J3, e7-t06); null when it is closed */
  whiteboard: WhiteboardInfo | null
  /**
   * A persistent room's owner set these on /me (L5, e1-t18). `startMuted`: participants come in
   * with the microphone off (absent means false). `allowAnnotation`, `allowRecording`: false turns
   * the feature off in this room, for everyone (absent means true)
   */
  startMuted?: boolean
  allowAnnotation?: boolean
  allowRecording?: boolean
  /**
   * Whether anyone may ask to control a desktop agent here (N3, threat model Q4; absent means true).
   * A persistent room's owner turns it off on /me; off refuses every request and ends what is on
   */
  allowControl?: boolean
}

/** The room's whiteboard while it is open: who opened it (its owner, as a sharer is of a share) */
export type WhiteboardInfo = {
  by: string
  /** When it was opened (the server's clock): it sits among the shares in that order */
  since: number
}

/** One member's local recording (I4, e8-t01, e8-t02) */
export type RecordingInfo = {
  memberId: string
  /** When the room granted it (the server's clock) */
  since: number
  /**
   * Who agreed to this recording (I4, `consent`), by member id; the recorder is never listed (it
   * is their own). The recorder leaves everyone else out of the file until they are here
   */
  consented: string[]
}

/**
 * Whether `memberId` still has to agree to a recording on now (I4): someone else records and the
 * member is not in its `consented`
 */
export function consentPending(
  recordings: Readonly<Record<string, RecordingInfo>> | undefined,
  memberId: string | null,
): boolean {
  if (memberId === null) return false
  return Object.values(recordings ?? {}).some(
    (recording) =>
      recording.memberId !== memberId && !(recording.consented ?? []).includes(memberId),
  )
}

/** The recordings in the order they started, oldest first (ties by member id) */
export function recordingOrder(
  recordings: Readonly<Record<string, RecordingInfo>> | undefined,
): RecordingInfo[] {
  return Object.values(recordings ?? {}).sort(
    (a, b) => a.since - b.since || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0),
  )
}

/** One member's screen share (D1, e3-t02; several at once from H5, e3-t07) */
export type ShareInfo = {
  memberId: string
  /** When the member was granted the share */
  since: number
}

/** How many members may share their screens at the same time (H5, e3-t07) */
export const MAX_SHARES = 3

/** The shares in the order they started, oldest first (ties by member id, so every end agrees) */
export function shareOrder(shares: Readonly<Record<string, ShareInfo>> | undefined): ShareInfo[] {
  return Object.values(shares ?? {}).sort(
    (a, b) => a.since - b.since || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0),
  )
}

/** Someone in the waiting room (F2), as the members in the room see them */
export type WaitingEntry = {
  id: string
  name: string
  /** When they started waiting: the queue's order; WAIT_TIMEOUT_MS counts from it */
  since: number
  reconnecting: boolean
}

/** The waiting room's queue in order: first come, first in (ties by id, so every end agrees) */
export function waitingQueue(waiting: Readonly<Record<string, WaitingEntry>> | undefined) {
  return Object.values(waiting ?? {}).sort(
    (a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/** What a member may do in the room: shared/roles.ts (F1, e1-t06) */
export type { Role }

/** What GET /api/rooms/<id> answers, for the pre-join screen */
export type RoomSummary = RoomInfo & { memberCount: number }

/** What a published track is, as the room and the UI care about it (MediaTransport's TrackKind) */
export type TrackKind = 'mic' | 'cam' | 'screen' | 'screenAudio'

export const TRACK_KINDS: readonly TrackKind[] = ['mic', 'cam', 'screen', 'screenAudio']

/** One track a member publishes: its global address on the SFU and what it is */
export type MemberTrack = {
  /** The publisher's SFU session (always the member's current one) */
  sessionId: string
  trackName: string
  kind: TrackKind
  /** Published but not sending: the member turned the microphone or camera off (B2) */
  muted: boolean
}

/** Realtime session ids and our track names: short, URL-safe */
const SFU_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export const isSfuId = (value: unknown): value is string =>
  typeof value === 'string' && SFU_ID_PATTERN.test(value)

/**
 * One person in the room. The session token is never part of the view: only its owner gets it,
 * in `welcome`.
 */
export type Member = {
  id: string
  name: string
  /**
   * One member is the host whenever anyone is connected (C2, e1-t04); co-hosts are named by the
   * host (F3, e1-t16). Never `waiting` in the view: who waits is `RoomView.waiting` (F2)
   */
  role: Role
  joinedAt: number
  /** The socket dropped without `leave`; the member keeps its place for RECONNECT_GRACE_MS */
  reconnecting: boolean
  /** What the member publishes now, at most one track of each kind */
  tracks: MemberTrack[]
  /**
   * When the member raised their hand (G3, e5-t04; the server's clock): the queue's order
   * (shared/reactions.ts handQueue); null while it is down
   */
  hand: number | null
  /** How good the member's own connection is, as their browser judged it (H2); null: unknown */
  signal: SignalLevel | null
  /**
   * The host allowed this member to record (I4, `host` `allowRecord`); the host may record
   * anyway (worker/roles.ts `record`)
   */
  mayRecord: boolean
  /**
   * The breakout room the member is in (L3, e10-t04; shared/breakout.ts); null or absent: the main
   * room
   */
  group?: string | null
  /**
   * A desktop agent, not a person (N2, e9-t02): shown as 「<owner's name> 的電腦」. `owner` is the
   * member who issued its pairing code (null once they left), `device` the computer's own name
   */
  agent?: MemberAgent
}

/** What the room says about a desktop agent member (shared/control.ts AgentHelloMessage) */
export type MemberAgent = { owner: string | null; device: string; platform: AgentPlatform }

/** A nameplate's signal bars (e2-t13): 好／普通／差 */
export type SignalLevel = 'good' | 'fair' | 'poor'

export const SIGNAL_LEVELS: readonly SignalLevel[] = ['good', 'fair', 'poor']

export const isSignalLevel = (value: unknown): value is SignalLevel =>
  SIGNAL_LEVELS.includes(value as SignalLevel)

/** A browser sends `signal` at most this often (changes in between wait) */
export const SIGNAL_REPORT_MS = 5_000

/** The room drops `signal` beyond this per member (a browser keeping SIGNAL_REPORT_MS never hits it) */
export const SIGNAL_RATE = { count: 3, windowMs: 10_000 } as const

/** What every member sees of the room: the state `snapshot` sends and `patch` keeps up to date */
export type RoomView = {
  room: RoomInfo
  members: Record<string, Member>
  /** Who waits to be admitted (F2), by id; first come, first in (`since`) */
  waiting: Record<string, WaitingEntry>
  /** The month's Realtime egress state (shared/usage.ts); `normal` until the room hears otherwise */
  usage: UsageState
  // Not in RoomInfo: GET /api/rooms/<id> gives that to anyone with the link, before any password
  /** The poll on now (L5, e5-t07); absent or null when there is none */
  poll?: PollView | null
  /** The countdown (L5, e5-t08); absent or null when there is none */
  timer?: TimerInfo | null
  /** The agenda bar (L5, e5-t08); absent or null when there is none */
  agenda?: AgendaInfo | null
  /** The breakout rooms (L3, e10-t04); absent or null when they are not open */
  breakout?: BreakoutView | null
  /**
   * Remote control (N3, e9-t04): each agent's request or grant, by the agent's member id; absent or
   * null when there is none. No ids in it: those go only to who needs them
   */
  control?: ControlView | null
}

// ── Server → browser ─────────────────────────────────────────────────────────────────────────

export type WelcomeMessage = {
  t: 'welcome'
  v: typeof PROTOCOL_VERSION
  /** This connection's member id */
  you: string
  /** Send this in the next `join` (after a reload) to come back as the same member */
  token: string
  rev: number
  state: RoomView
}

export type SnapshotMessage = { t: 'snapshot'; rev: number; state: RoomView }

/** The changes from rev − 1 to `rev` */
export type PatchMessage = { t: 'patch'; rev: number; ops: PatchOp[] }

/**
 * - `forbidden`: the member may not do that (`renameRoom` from someone who is not the host)
 * - `share_full`: `share` while MAX_SHARES members already share (H5, e3-t07)
 * - `audio_only`: `share` in a month that is audio-only (shared/usage.ts)
 * - `rate_limited`: `chat` faster than CHAT_RATE (D3); the message was not kept
 * - `annotation_limit`: `annotate` faster than the limits (J2); a refused stroke comes back removed
 * - `poll_active`: `pollStart` while a poll is on (L5)
 * - `pair_busy`: `pairStart` from a member whose computer is already in the room (N2)
 * - `breakout_active`: `breakoutOpen` while breakout rooms are open, or `spotlight`, opening the
 *   whiteboard, `pollStart` or `record` while they are (L3)
 */
export type ErrorCode =
  | 'bad_message'
  | 'forbidden'
  | 'share_full'
  | 'audio_only'
  | 'rate_limited'
  | 'annotation_limit'
  | 'poll_active'
  | 'breakout_active'
  | 'pair_busy'
  | ControlErrorCode

/**
 * What a host (or co-host) did to this member (F1): `muted` (the microphone; `all` when it was
 * 全員靜音), `camOff`, `shareStopped`. `by` is that member's id. The browser turns its microphone
 * or camera off on `muted` / `camOff` (the room already lists the track muted) and says what
 * happened.
 */
export type NoticeKind =
  | 'muted'
  | 'camOff'
  | 'shareStopped'
  // F3 (e1-t16): the host made this member a co-host, a participant again, or the host
  | 'madeCohost'
  | 'cohostRevoked'
  | 'madeHost'
  // G3 (e5-t04): a host or co-host lowered this member's raised hand
  | 'handLowered'
  // I4 (e8-t02): the host stopped this member's recording (its browser stops and saves it),
  // allowed this member to record, or took that back
  | 'recordingStopped'
  | 'recordAllowed'
  | 'recordRevoked'
  // J3 (e7-t05): a host or co-host changed who may annotate (`policy`), for everyone else; someone
  // cleared marks of this member's, or on this member's share (`all`: the whole layer; `layer`: which)
  | 'annotationPolicy'
  | 'annotationsCleared'
  // L5 (e1-t18): this persistent room has participants come in muted; `by` is the member themselves
  | 'startMuted'
  // N2 (e9-t02): a computer joined with this member's pairing code (`by`: the agent's member id);
  // too many wrong codes voided this member's open code
  | 'agentPaired'
  | 'pairingVoided'
  // N3 (e9-t04): to everyone in the room, `by` the controller and `agent` the controlled computer:
  // control started, or ended (`reason`)
  | 'controlStarted'
  | 'controlEnded'

export type NoticeMessage = {
  t: 'notice'
  notice: NoticeKind
  by: string
  all?: true
  policy?: AnnotationPolicy
  layer?: string
  /** `controlStarted`, `controlEnded`: the agent's member id */
  agent?: string
  /** `controlEnded`: why */
  reason?: ControlEndReason
}

export type ErrorMessage = { t: 'error'; code: ErrorCode }

/**
 * What someone in the waiting room gets instead of `welcome` (F2), on joining and whenever it
 * changes: its member id and token (a reload comes back to the same place), its place in the
 * queue (1 is next) out of `count`, the room's name, and whether a host or co-host is connected
 * to admit it.
 */
export type LobbyMessage = {
  t: 'lobby'
  v: typeof PROTOCOL_VERSION
  you: string
  token: string
  position: number
  count: number
  room: Pick<RoomInfo, 'name' | 'createdBy'>
  hostPresent: boolean
  /** The meeting is being recorded (I4): the waiting screen says so */
  recording: boolean
}

/**
 * Chat messages (D3, shared/chat.ts), oldest first. `reset`: the first frame of the history the
 * room sends after every `welcome`; replace every message you have with these (more frames of
 * the history may follow without it). Without `reset`: new messages, append them.
 */
/**
 * The pairing code `pairStart` asked for (N2), to this member alone: show it formatted
 * (formatPairingCode), hidden until asked for. `code` null: the code was used, voided or ran out
 */
export type PairCodeMessage = { t: 'pairCode'; code: string | null; expiresAt: number | null }

export type ChatServerMessage = {
  t: 'chat'
  messages: ChatMessage[]
  reset?: true
  /** A history sent because the member changed breakout rooms (L3): none of it is new */
  regroup?: true
}

/** Someone in the room reacted (G3, e5-t03): `from` is their member id (maybe our own) */
export type ReactionMessage = { t: 'reaction'; from: string; emoji: Reaction }

/**
 * What was done to a share's layer (J2, e7-t04): by the member `by`, or by the room itself (null:
 * strokes that fell out or were refused, the share stopping)
 */
export type AnnotationMessage = {
  t: 'annotation'
  /** The sharer: which share's layer */
  share: string
  by: string | null
  ops: AnnotationOp[]
}

/**
 * The strokes on the shares, after every `welcome` (J2): `reset` on the first frame (forget what you
 * have), `done` on the last; `share` is null on a frame with no strokes. Oldest first.
 */
export type AnnotationsMessage = {
  t: 'annotations'
  share: string | null
  strokes: Stroke[]
  reset?: true
  done?: true
}

/** What this member answered to the poll on now (L5): the view does not say on an anonymous one */
export type PollVotedMessage = { t: 'pollVoted'; poll: number; choices: number[] }

export type ServerMessage =
  | PollVotedMessage
  | AnnotationMessage
  | AnnotationsMessage
  | WelcomeMessage
  | SnapshotMessage
  | PatchMessage
  | ErrorMessage
  | ChatServerMessage
  | NoticeMessage
  | LobbyMessage
  | ReactionMessage
  | PairCodeMessage
  | ControllerServerMessage

// ── Browser → server ─────────────────────────────────────────────────────────────────────────

/**
 * The first message on every socket; `token` is null for someone new. `client` is this browser's
 * own random id (localStorage, src/room/session.ts), what a ban is kept against (F1); null when
 * missing or malformed. `password` (F3): the room's password as typed (shared/password.ts), for
 * someone new to a room that has one; null otherwise. Only ever sent here, never in a URL.
 */
export type JoinMessage = {
  t: 'join'
  name: string
  token: string | null
  client: string | null
  password?: string | null
}

export type ResyncMessage = { t: 'resync' }

/**
 * Leaving on purpose: the member is removed at once instead of waiting for RECONNECT_GRACE_MS.
 * `host` (F3): a host leaving names who takes over (a connected member); without it, the room's
 * own rule decides (the earliest-joined connected co-host, else member).
 */
export type LeaveMessage = { t: 'leave'; host?: string }

/**
 * Everything this member publishes now on its SFU session (replaces the previous list). Ignored
 * unless `sessionId` is the session the member created through the proxy last.
 */
export type TracksMessage = {
  t: 'tracks'
  sessionId: string
  tracks: { trackName: string; kind: TrackKind; muted: boolean }[]
}

/**
 * The transport's cumulative bytes received on `sessionId` (the SFU's egress to this browser),
 * and whether the selected candidate pair goes through a TURN relay (B3)
 */
export type StatsMessage = { t: 'stats'; sessionId: string; bytesReceived: number; relay: boolean }

/** The member's own display name from now on (C2, e1-t05) */
export type RenameMessage = { t: 'rename'; name: string }

/** The room's name (host only, C2, e1-t05) */
export type RenameRoomMessage = { t: 'renameRoom'; name: string }

/** Start sharing the screen (D1): sent once the member picked what to share */
export type ShareMessage = { t: 'share' }

/** Stop sharing (the member's own share) */
export type UnshareMessage = { t: 'unshare' }

/** Spotlight a member for everyone, or (null) end the spotlight (G2, e4-t11; host or co-host) */
export type SpotlightMessage = { t: 'spotlight'; memberId: string | null }

/** A chat message to everyone in the room (D3); `text` is normalizeChatText's */
export type ChatClientMessage = { t: 'chat'; text: string }

/** A reaction to everyone in the room (G3, e5-t03) */
export type ReactClientMessage = { t: 'react'; emoji: Reaction }

/** Raise (`up`) or lower the member's own hand (G3, e5-t04) */
export type HandMessage = { t: 'hand'; up: boolean }

/** The member's own connection, as their browser judges it (H2, e2-t13) */
export type SignalMessage = { t: 'signal'; level: SignalLevel }

/** Start (`on`) or stop the member's own local recording (I4, e8-t02) */
export type RecordMessage = { t: 'record'; on: boolean }

/** Agree to every recording on now (I4, rule 4 「明確同意」) */
export type ConsentMessage = { t: 'consent' }

/**
 * The host controls that act on one member (F1; `lowerHand` G3; `stopRecording` I4); `memberId`
 * says who
 */
export type HostMemberAction =
  | 'muteMember'
  | 'camOff'
  | 'stopShare'
  | 'remove'
  | 'lowerHand'
  | 'stopRecording'
  // N3: end the remote control of this agent (`memberId`: the agent)
  | 'stopControl'

/** The host controls that act on the whole room (F1; `admitAll` F2) */
export type HostRoomAction = 'muteAll' | 'endMeeting' | 'admitAll'

/** Admit or turn away one person in the waiting room (F2); `memberId` says who */
export type HostWaitingAction = 'admit' | 'deny'

/** The room's switches (F2): `on` says which way */
export type HostSwitchAction = 'lock' | 'waitingRoom'

/** The room's password (F3): a new one, or null to clear it */
export type HostPasswordAction = 'setPassword'

/** Making a member a co-host (`on`) or a participant again (F3) */
export type HostCohostAction = 'setCohost'

/** Allowing a member to record (`on`) or taking that back (I4) */
export type HostAllowRecordAction = 'allowRecord'

/** Handing the host role to a member (F3) */
export type HostHandoverAction = 'makeHost'

/** Who may annotate (J3, e7-t05) */
export type HostAnnotationPolicyAction = 'annotationPolicy'

export type HostAction =
  | HostMemberAction
  | HostRoomAction
  | HostWaitingAction
  | HostSwitchAction
  | HostPasswordAction
  | HostCohostAction
  | HostHandoverAction
  | HostAllowRecordAction
  | HostAnnotationPolicyAction

const HOST_MEMBER_ACTIONS: readonly string[] = [
  'muteMember',
  'camOff',
  'stopShare',
  'remove',
  'lowerHand',
  'stopRecording',
  'stopControl',
]
const HOST_ROOM_ACTIONS: readonly string[] = ['muteAll', 'endMeeting', 'admitAll']
const HOST_WAITING_ACTIONS: readonly string[] = ['admit', 'deny']
const HOST_SWITCH_ACTIONS: readonly string[] = ['lock', 'waitingRoom']

/** A host control (F1, e1-t07; F2); the room checks the member may (worker/roles.ts) */
export type HostMessage =
  | { t: 'host'; action: HostMemberAction; memberId: string }
  | { t: 'host'; action: HostRoomAction }
  | { t: 'host'; action: HostWaitingAction; memberId: string }
  | { t: 'host'; action: HostSwitchAction; on: boolean }
  | { t: 'host'; action: HostPasswordAction; password: string | null }
  | { t: 'host'; action: HostCohostAction; memberId: string; on: boolean }
  | { t: 'host'; action: HostAllowRecordAction; memberId: string; on: boolean }
  | { t: 'host'; action: HostHandoverAction; memberId: string }
  | { t: 'host'; action: HostAnnotationPolicyAction; policy: AnnotationPolicy }

/** What the member did to a layer since its last frame (J2, e7-t03, e7-t04; J3: the whiteboard's) */
export type AnnotateMessage = { t: 'annotate'; share: string; ops: AnnotationOp[] }

/** Clear a layer, or (`by`) one member's strokes on it, for everyone (J3, e7-t05) */
export type ClearAnnotationsMessage = { t: 'clearAnnotations'; share: string; by: string | null }

/** Open or close the room's whiteboard (J3, e7-t06) */
export type WhiteboardMessage = { t: 'whiteboard'; open: boolean }

/** Start a poll (L5, e5-t07; a host or co-host); checked as parsePollStart does */
export type PollStartMessage = {
  t: 'pollStart'
  question: string
  options: string[]
  multi: boolean
  anonymous: boolean
}

/** The member's answer to the poll `poll`, replacing an earlier one */
export type PollVoteMessage = { t: 'pollVote'; poll: number; choices: number[] }

/** End the poll `poll`; its results go to the chat */
export type PollEndMessage = { t: 'pollEnd'; poll: number }

/** Start the countdown over, or (null) end it (L5, e5-t08; a host or co-host) */
export type TimerMessage = { t: 'timer'; seconds: number | null }

/** The agenda's items, replacing what was there; none: no agenda (L5, e5-t08) */
export type AgendaMessage = { t: 'agenda'; items: AgendaItem[] }

/** Which of the agenda's items is on now */
export type AgendaCurrentMessage = { t: 'agendaCurrent'; index: number }

/**
 * Open breakout rooms (L3, e10-t04; a host or co-host): their names (ids `g1` … in this order),
 * who goes where (member id → index into `groups`; anyone not named stays in the main room) and
 * how long, in minutes (null: until recalled). Checked as parseBreakoutOpen does
 */
export type BreakoutOpenMessage = {
  t: 'breakoutOpen'
  groups: string[]
  assign: Record<string, number>
  minutes: number | null
}

/** Put a member (the actor too) in a breakout room, or (null) back in the main room */
export type BreakoutMoveMessage = { t: 'breakoutMove'; memberId: string; group: string | null }

/** A message to every breakout room, replacing the last one */
export type BreakoutBroadcastMessage = { t: 'breakoutBroadcast'; text: string }

/**
 * Start the recall (BREAKOUT_RECALL_MS), or (`now`) bring everyone back at once. Without `now` a
 * recall already under way is left alone: two co-hosts pressing 全部召回 never skip the warning
 */
export type BreakoutCloseMessage = { t: 'breakoutClose'; now: boolean }

/** Ask for a one-time code to pair this member's computer (N2, e9-t02) */
export type PairStartMessage = { t: 'pairStart' }

/** Void this member's open pairing code */
export type PairCancelMessage = { t: 'pairCancel' }

/** Remove this member's own computer from the room (「這不是我」 or 「中斷我的電腦」) */
export type AgentRemoveMessage = { t: 'agentRemove'; memberId: string }

export type ClientMessage =
  | ControlClientMessage
  | PairStartMessage
  | PairCancelMessage
  | AgentRemoveMessage
  | BreakoutOpenMessage
  | BreakoutMoveMessage
  | BreakoutBroadcastMessage
  | BreakoutCloseMessage
  | PollStartMessage
  | PollVoteMessage
  | PollEndMessage
  | TimerMessage
  | AgendaMessage
  | AgendaCurrentMessage
  | AnnotateMessage
  | ClearAnnotationsMessage
  | WhiteboardMessage
  | ChatClientMessage
  | HostMessage
  | JoinMessage
  | ResyncMessage
  | LeaveMessage
  | TracksMessage
  | StatsMessage
  | RenameMessage
  | RenameRoomMessage
  | ShareMessage
  | UnshareMessage
  | SpotlightMessage
  | ReactClientMessage
  | HandMessage
  | SignalMessage
  | RecordMessage
  | ConsentMessage

// ── POST /api/rooms ──────────────────────────────────────────────────────────────────────────

export type CreateRoomResponse = { id: string }

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

function parseObject(raw: string, maxChars: number): Record<string, unknown> | null {
  if (raw.length > maxChars) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// Control characters and the bidirectional overrides that could make a name render as someone
// else's (U+202A–202E, U+2066–2069)
const UNSAFE_NAME_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu

/**
 * A display name (or, with MAX_ROOM_NAME_CHARS, a room name) as the room stores it: unsafe
 * characters removed, runs of whitespace collapsed, trimmed; null when nothing is left or it is
 * longer than `maxChars`. The browser uses it before sending, the server again on receipt.
 */
export function normalizeName(raw: unknown, maxChars: number = MAX_NAME_CHARS): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim()
  if (name === '' || [...name].length > maxChars) return null
  return name
}

/** 32 random bytes, base64url without padding */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value)
}

/** A browser's own id (F1): 16–64 URL-safe characters */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_ID_PATTERN.test(value)
}

/** Member ids are the room's own (crypto.randomUUID): anything else is not worth a lookup */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const isMemberId = (value: unknown): value is string =>
  typeof value === 'string' && MEMBER_ID_PATTERN.test(value)

/** A new session token (crypto.getRandomValues, in the Worker) */
export function newSessionToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const isIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

/** `pollStart`'s fields, normalized as the room stores them; null when any does not fit */
export function parsePollStart(value: Record<string, unknown>): PollStartMessage | null {
  const question = normalizeName(value.question, MAX_POLL_QUESTION_CHARS)
  if (question === null || !Array.isArray(value.options)) return null
  if (value.options.length < MIN_POLL_OPTIONS || value.options.length > MAX_POLL_OPTIONS)
    return null
  const options: string[] = []
  for (const raw of value.options as unknown[]) {
    const option = normalizeName(raw, MAX_POLL_OPTION_CHARS)
    // The same choice twice could only split the votes
    if (option === null || options.includes(option)) return null
    options.push(option)
  }
  if (typeof value.multi !== 'boolean' || typeof value.anonymous !== 'boolean') return null
  return { t: 'pollStart', question, options, multi: value.multi, anonymous: value.anonymous }
}

/** The answers a `pollVote` names: at least one, none twice (the poll decides the rest) */
function parseChoices(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_POLL_OPTIONS) return null
  if (!value.every(isIndex) || new Set(value).size !== value.length) return null
  return value as number[]
}

/** The agenda's items, normalized as the room stores them; null when any does not fit */
export function parseAgendaItems(value: unknown): AgendaItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_AGENDA_ITEMS) return null
  const items: AgendaItem[] = []
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return null
    const { title, minutes } = raw as Record<string, unknown>
    const name = normalizeName(title, MAX_AGENDA_TITLE_CHARS)
    if (name === null || !isIndex(minutes) || minutes < 1 || minutes > MAX_AGENDA_MINUTES)
      return null
    items.push({ title: name, minutes })
  }
  return items
}

/** A breakout room id as the room gives them (shared/breakout.ts groupId) */
const isGroupIdText = (value: unknown): value is string =>
  typeof value === 'string' && /^g[1-9][0-9]?$/.test(value)

/** `breakoutOpen`'s fields, normalized as the room stores them; null when any does not fit */
export function parseBreakoutOpen(value: Record<string, unknown>): BreakoutOpenMessage | null {
  if (!Array.isArray(value.groups)) return null
  if (value.groups.length < 1 || value.groups.length > MAX_BREAKOUT_GROUPS) return null
  const groups: string[] = []
  for (const raw of value.groups as unknown[]) {
    const name = normalizeName(raw, MAX_BREAKOUT_NAME_CHARS)
    if (name === null) return null
    groups.push(name)
  }
  const rawAssign = value.assign
  if (typeof rawAssign !== 'object' || rawAssign === null || Array.isArray(rawAssign)) return null
  const assign: Record<string, number> = {}
  for (const [memberId, index] of Object.entries(rawAssign as Record<string, unknown>)) {
    if (!isMemberId(memberId) || !isIndex(index) || index >= groups.length) return null
    assign[memberId] = index
  }
  const minutes = value.minutes
  if (minutes !== null && !(isIndex(minutes) && minutes >= 1 && minutes <= MAX_BREAKOUT_MINUTES)) {
    return null
  }
  return { t: 'breakoutOpen', groups, assign, minutes }
}

/** A browser's message, or null when it is not one this version understands */
export function parseClientMessage(raw: string): ClientMessage | null {
  const value = parseObject(raw, MAX_CLIENT_MESSAGE_CHARS)
  switch (value?.t) {
    case 'join': {
      const name = normalizeName(value.name)
      if (name === null) return null
      // A malformed token is someone new, not an error: the browser may hold one from an
      // older version
      // A malformed password is no password: the room asks for it
      const password = normalizePassword(value.password)
      return {
        t: 'join',
        name,
        token: isSessionToken(value.token) ? value.token : null,
        client: isClientId(value.client) ? value.client : null,
        ...(password === null ? {} : { password }),
      }
    }
    case 'resync':
      return { t: 'resync' }
    case 'leave':
      return isMemberId(value.host) ? { t: 'leave', host: value.host } : { t: 'leave' }
    case 'tracks':
      return parseTracks(value)
    case 'rename': {
      const name = normalizeName(value.name)
      return name === null ? null : { t: 'rename', name }
    }
    case 'renameRoom': {
      const name = normalizeName(value.name, MAX_ROOM_NAME_CHARS)
      return name === null ? null : { t: 'renameRoom', name }
    }
    case 'share':
      return { t: 'share' }
    case 'unshare':
      return { t: 'unshare' }
    case 'spotlight':
      return value.memberId === null || isMemberId(value.memberId)
        ? { t: 'spotlight', memberId: value.memberId }
        : null
    case 'chat': {
      const text = normalizeChatText(value.text)
      return text === null ? null : { t: 'chat', text }
    }
    case 'react':
      return isReaction(value.emoji) ? { t: 'react', emoji: value.emoji } : null
    case 'hand':
      return typeof value.up === 'boolean' ? { t: 'hand', up: value.up } : null
    case 'signal':
      return isSignalLevel(value.level) ? { t: 'signal', level: value.level } : null
    case 'record':
      return typeof value.on === 'boolean' ? { t: 'record', on: value.on } : null
    case 'consent':
      return { t: 'consent' }
    case 'annotate': {
      // The share or the whiteboard: its points must be in that layer's range
      const ops = isMemberId(value.share)
        ? parseAnnotationOps(value.ops, spaceOf(value.share))
        : null
      return ops === null ? null : { t: 'annotate', share: value.share as string, ops }
    }
    case 'clearAnnotations':
      return isMemberId(value.share) && (value.by === null || isMemberId(value.by))
        ? { t: 'clearAnnotations', share: value.share, by: value.by }
        : null
    case 'whiteboard':
      return typeof value.open === 'boolean' ? { t: 'whiteboard', open: value.open } : null
    case 'pollStart':
      return parsePollStart(value)
    case 'pollVote': {
      const choices = parseChoices(value.choices)
      return isIndex(value.poll) && choices ? { t: 'pollVote', poll: value.poll, choices } : null
    }
    case 'pollEnd':
      return isIndex(value.poll) ? { t: 'pollEnd', poll: value.poll } : null
    case 'timer':
      return value.seconds === null ||
        (isIndex(value.seconds) && value.seconds >= 1 && value.seconds <= MAX_TIMER_SECONDS)
        ? { t: 'timer', seconds: value.seconds }
        : null
    case 'agenda': {
      const items = parseAgendaItems(value.items)
      return items ? { t: 'agenda', items } : null
    }
    case 'agendaCurrent':
      return isIndex(value.index) ? { t: 'agendaCurrent', index: value.index } : null
    case 'breakoutOpen':
      return parseBreakoutOpen(value)
    case 'breakoutMove':
      return isMemberId(value.memberId) && (value.group === null || isGroupIdText(value.group))
        ? { t: 'breakoutMove', memberId: value.memberId, group: value.group }
        : null
    case 'breakoutBroadcast': {
      const text = normalizeName(value.text, MAX_BROADCAST_CHARS)
      return text === null ? null : { t: 'breakoutBroadcast', text }
    }
    case 'pairStart':
      return { t: 'pairStart' }
    case 'pairCancel':
      return { t: 'pairCancel' }
    case 'agentRemove':
      return isMemberId(value.memberId) ? { t: 'agentRemove', memberId: value.memberId } : null
    case 'breakoutClose':
      return typeof value.now === 'boolean' ? { t: 'breakoutClose', now: value.now } : null
    case 'controlRequest':
    case 'controlCancel':
    case 'controlEvent':
    case 'controlStop':
      return parseControlClientMessage(value)
    case 'host': {
      const action = value.action
      if (typeof action !== 'string') return null
      if (HOST_ROOM_ACTIONS.includes(action)) {
        return { t: 'host', action: action as HostRoomAction }
      }
      if (HOST_MEMBER_ACTIONS.includes(action) && isMemberId(value.memberId)) {
        return { t: 'host', action: action as HostMemberAction, memberId: value.memberId }
      }
      if (HOST_WAITING_ACTIONS.includes(action) && isMemberId(value.memberId)) {
        return { t: 'host', action: action as HostWaitingAction, memberId: value.memberId }
      }
      if (HOST_SWITCH_ACTIONS.includes(action) && typeof value.on === 'boolean') {
        return { t: 'host', action: action as HostSwitchAction, on: value.on }
      }
      if (action === 'setPassword') {
        if (value.password === null) return { t: 'host', action, password: null }
        const password = normalizePassword(value.password)
        return password === null ? null : { t: 'host', action, password }
      }
      if (
        (action === 'setCohost' || action === 'allowRecord') &&
        isMemberId(value.memberId) &&
        typeof value.on === 'boolean'
      ) {
        return { t: 'host', action, memberId: value.memberId, on: value.on }
      }
      if (action === 'makeHost' && isMemberId(value.memberId)) {
        return { t: 'host', action, memberId: value.memberId }
      }
      if (action === 'annotationPolicy' && isAnnotationPolicy(value.policy)) {
        return { t: 'host', action, policy: value.policy }
      }
      return null
    }
    case 'stats':
      return isSfuId(value.sessionId) &&
        Number.isSafeInteger(value.bytesReceived) &&
        (value.bytesReceived as number) >= 0 &&
        typeof value.relay === 'boolean'
        ? {
            t: 'stats',
            sessionId: value.sessionId,
            bytesReceived: value.bytesReceived as number,
            relay: value.relay,
          }
        : null
    default:
      return null
  }
}

function parseTracks(value: Record<string, unknown>): TracksMessage | null {
  if (!isSfuId(value.sessionId) || !Array.isArray(value.tracks)) return null
  if (value.tracks.length > TRACK_KINDS.length) return null
  const tracks: TracksMessage['tracks'] = []
  const kinds = new Set<TrackKind>()
  for (const item of value.tracks as unknown[]) {
    if (typeof item !== 'object' || item === null) return null
    const { trackName, kind, muted } = item as Record<string, unknown>
    if (!isSfuId(trackName) || !TRACK_KINDS.includes(kind as TrackKind)) return null
    if (typeof muted !== 'boolean') return null
    // One track of each kind
    if (kinds.has(kind as TrackKind)) return null
    kinds.add(kind as TrackKind)
    tracks.push({ trackName, kind: kind as TrackKind, muted })
  }
  return { t: 'tracks', sessionId: value.sessionId, tracks }
}

const isRev = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

function isRoomView(value: unknown): value is RoomView {
  if (typeof value !== 'object' || value === null) return false
  const view = value as Record<string, unknown>
  return (
    typeof view.room === 'object' &&
    view.room !== null &&
    typeof view.members === 'object' &&
    view.members !== null &&
    typeof view.usage === 'string'
  )
}

/**
 * The server's message, or null when it is not one this version understands. Checks the shape
 * the browser relies on, not every field: the server is trusted, the check guards against
 * version skew and proxies, not attackers.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  const value = parseObject(raw, Number.POSITIVE_INFINITY)
  if (!value) return null
  switch (value.t) {
    case 'welcome':
      return value.v === PROTOCOL_VERSION &&
        typeof value.you === 'string' &&
        typeof value.token === 'string' &&
        isRev(value.rev) &&
        isRoomView(value.state)
        ? (value as WelcomeMessage)
        : null
    case 'snapshot':
      return isRev(value.rev) && isRoomView(value.state) ? (value as SnapshotMessage) : null
    case 'patch':
      return isRev(value.rev) && Array.isArray(value.ops) ? (value as PatchMessage) : null
    case 'error':
      return value as ErrorMessage
    case 'chat':
      return Array.isArray(value.messages) && value.messages.every(isChatMessage)
        ? (value as ChatServerMessage)
        : null
    case 'notice':
      return typeof value.notice === 'string' && typeof value.by === 'string'
        ? (value as NoticeMessage)
        : null
    case 'lobby':
      return value.v === PROTOCOL_VERSION &&
        typeof value.you === 'string' &&
        typeof value.token === 'string' &&
        isRev(value.position) &&
        isRev(value.count) &&
        typeof value.room === 'object' &&
        value.room !== null &&
        typeof value.hostPresent === 'boolean'
        ? (value as LobbyMessage)
        : null
    case 'pairCode':
      return (value.code === null || typeof value.code === 'string') &&
        (value.expiresAt === null || typeof value.expiresAt === 'number')
        ? (value as PairCodeMessage)
        : null
    case 'reaction':
      return typeof value.from === 'string' && isReaction(value.emoji)
        ? (value as ReactionMessage)
        : null
    case 'annotation':
      return typeof value.share === 'string' && Array.isArray(value.ops)
        ? (value as AnnotationMessage)
        : null
    case 'annotations':
      return Array.isArray(value.strokes) ? (value as AnnotationsMessage) : null
    case 'pollVoted':
      return typeof value.poll === 'number' && Array.isArray(value.choices)
        ? (value as PollVotedMessage)
        : null
    case 'controlRequested':
      return typeof value.request === 'string' && typeof value.agent === 'string'
        ? (value as ControllerServerMessage)
        : null
    case 'controlRefused':
      return typeof value.request === 'string' && typeof value.reason === 'string'
        ? (value as ControllerServerMessage)
        : null
    case 'controlGranted':
      return typeof value.grant === 'string' &&
        typeof value.agent === 'string' &&
        (value.until === null || typeof value.until === 'number')
        ? (value as ControllerServerMessage)
        : null
    case 'controlEnd':
      return typeof value.grant === 'string' && typeof value.reason === 'string'
        ? (value as ControllerServerMessage)
        : null
    default:
      return null
  }
}

/** GET: the room's RoomSummary, or 404 */
export function roomInfoPath(roomId: string): string {
  return `/api/rooms/${roomId}`
}

/** The WebSocket path for a room (relative to the site's origin) */
export function roomSocketPath(roomId: string): string {
  return `/api/rooms/${roomId}/ws?v=${PROTOCOL_VERSION}`
}

/** Typed helper so a view can be diffed and patched (shared/patch.ts) */
export const viewAsJson = (view: RoomView): JsonValue => view

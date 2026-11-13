import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import type { BreakoutView } from '../../shared/breakout.ts'
import type { HostMemberAction, Member, WaitingEntry } from '../../shared/protocol.ts'
import { handQueue } from '../../shared/reactions.ts'
import {
  ANNOTATION_POLICIES,
  DEFAULT_ANNOTATION_POLICY,
  RANK,
  can,
  canActOn,
  type AnnotationPolicy,
  type Role,
} from '../../shared/roles.ts'
import { VOLUME_MAX, VOLUME_MIN, VOLUME_STEP } from '../media/memberVolume.ts'
import { speakingMonitor } from '../media/speaking.ts'
import { shareVolumeKey } from '../room/memberVolumes.ts'
import {
  PARTICIPANT_FILTERS,
  SEARCH_FROM,
  filterCounts,
  filterMembers,
  micOn as micIsOn,
  type ParticipantFilter,
} from '../room/participantFilter.ts'
import { strings } from '../strings.ts'
import { avatar, avatarColor, color, fontSize, motion, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import {
  CamIcon,
  CamOffIcon,
  ComputerIcon,
  HandIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  ScreenShareIcon,
} from './icons.tsx'
import { Menu, type MenuItem } from './Menu.tsx'

export interface ParticipantsPanelProps {
  members: Member[]
  /** Our own member id */
  you: string | null
  /** Who shares the screen now (several at once from H5) */
  sharerIds: readonly string[]
  /** The desktop agents someone controls now (N3): a host or co-host may stop it */
  controlledIds?: readonly string[]
  /** A host control on one member (the room decides whether it is allowed, worker/roles.ts) */
  onAction: (action: HostMemberAction, memberId: string) => void
  onMuteAll: () => void
  /**
   * Mute who the search or the filter left listed (O1, e10-t06): only their ids whose microphone is
   * on and whom our role may mute; RoomDO checks each again
   */
  onMuteMembers?: (memberIds: string[]) => void
  onEndMeeting: () => void
  /** Who waits to be admitted (F2), in the queue's order */
  waiting?: WaitingEntry[]
  /** The room's switches (F2) */
  locked?: boolean
  waitingRoom?: boolean
  onLock?: (on: boolean) => void
  /** Participants who come in start muted (O1, e10-t06; the owner's /me switch is the same one) */
  startMuted?: boolean
  onStartMuted?: (on: boolean) => void
  /** Turning it off admits everyone waiting (the panel asks first when anyone does) */
  onWaitingRoom?: (on: boolean) => void
  onAdmit?: (memberId: string) => void
  onDeny?: (memberId: string) => void
  onAdmitAll?: () => void
  /** The room has a password (F3): the host's settings say so and open the password dialog */
  passwordSet?: boolean
  onPassword?: () => void
  /** Who may annotate (J3, e7-t05): the three states, for who may set them */
  annotationPolicy?: AnnotationPolicy
  onAnnotationPolicy?: (policy: AnnotationPolicy) => void
  /** The owner turned annotation off in this persistent room (L5, e1-t18): only /me changes it */
  annotationLocked?: boolean
  /** The owner turned recording off in this persistent room (L5, e1-t18): nothing to allow */
  recordingOff?: boolean
  /** Co-hosts and handing over (F3, e1-t16); handing over asks first */
  onRole?: (change: RoleChange, memberId: string) => void
  /** Who records the meeting now (I4): a 錄影中 tag for everyone */
  recorderIds?: readonly string[]
  /** The host allows someone to record, takes it back, or stops their recording (I4) */
  onRecordAction?: (action: RecordAction, memberId: string) => void
  /** Each person's level meter and receive volume (e6-t08); left out where nothing plays */
  audio?: PanelAudio
  /**
   * The breakout rooms while they are open (L3, e10-t05), for a host or co-host: `members` is then
   * the whole room's and the list is grouped by room, the main room first
   */
  breakout?: BreakoutView | null
  /**
   * Remove our own computer (N2, e9-t02; `agentRemove`): 中斷 on its row, for its owner only. A
   * host removes anyone's computer from the menu, like anyone else
   */
  onAgentRemove?: (memberId: string) => void
  /**
   * Private messages (O4, e5-t09): whom we may write to (their menu offers 私訊, which opens the
   * chat addressed to them), and for a host or co-host the room's switch
   */
  messageable?: readonly string[]
  onPrivateMessage?: (memberId: string) => void
  privateChat?: boolean
  onPrivateChat?: (on: boolean) => void
}

/** What the panel shows of each person's sound (e6-t08): local to this browser */
export interface PanelAudio {
  /** Their microphone as it plays here (ours as it is sent); null while it sends nothing */
  levelOf: (memberId: string) => MediaStreamTrack | null
  /** <audio>.volume can be changed here (capabilities.ts canSetMemberVolume) */
  volumeSupported: boolean
  /** Percent, by member id or shareVolumeKey */
  volumeOf: (id: string) => number
  onVolume: (id: string, percent: number) => void
  /** Their share has its own sound right now */
  sharesSound: (memberId: string) => boolean
}

/** What the host may do about someone's recording (I4, e8-t02) */
export type RecordAction = 'allow' | 'revoke' | 'stop'

/** What the host may change about someone's role (F3, e1-t16) */
export type RoleChange = 'makeCohost' | 'revokeCohost' | 'makeHost'

const noop = () => {}

/**
 * What the per-person menu offers, in order, with the role table's action for each (a function:
 * the labels follow the language chosen now, strings.ts)
 */
const memberActions = (): readonly {
  action: Exclude<HostMemberAction, 'stopRecording'>
  label: string
  danger?: true
}[] => [
  { action: 'lowerHand', label: strings.reactions.lowerHand },
  { action: 'muteMember', label: strings.participants.mute },
  { action: 'camOff', label: strings.participants.camOffAction },
  { action: 'stopShare', label: strings.participants.stopShare },
  { action: 'stopControl', label: strings.control.stopTheirs },
  { action: 'remove', label: strings.participants.remove, danger: true },
]

/**
 * The participants list (e1-t08, DESIGN.md §4.3): everyone in the room with their role, whether
 * their microphone and camera are on and whether they share; for a host, a menu per person
 * (mute, camera off, stop share, remove) and 全員靜音 / 結束會議 at the bottom. What is offered
 * follows shared/roles.ts for our role; RoomDO decides again on every action (CLAUDE.md rule 1).
 * Removing someone and ending the meeting ask first. Shown in the desktop SidePanel and the
 * phone's full-screen Drawer.
 *
 * For a host or co-host (F2, e1-t09 – e1-t11) it also has the room's switches at the top (lock,
 * waiting room; turning the waiting room off with people in it asks first, since they all come
 * in) and, while anyone waits, 「等候中 N」 with 放行 / 拒絕 per person and 全部放行.
 *
 * For the host (F3, e1-t15, e1-t16): the room's password among the switches, and in each
 * person's menu 設為／取消共同主持人 and 設為主持人 (asks first).
 *
 * Raised hands (G3, e5-t04): whoever has a hand up comes first, in the order they raised it,
 * with a numbered hand; a host or co-host can lower it from the person's menu (放下手, first).
 *
 * Large rooms (O1, e10-t06): from SEARCH_FROM people a search box and filters (raised hand, muted,
 * camera off) narrow the list here only; while narrowed a host or co-host may mute who is listed
 * (`onMuteMembers`), and the settings have 預設靜音進入.
 */
export function ParticipantsPanel({
  members,
  you,
  sharerIds,
  controlledIds = [],
  onAction,
  onMuteAll,
  onMuteMembers = noop,
  onEndMeeting,
  waiting = [],
  locked = false,
  startMuted = false,
  onStartMuted = noop,
  waitingRoom = false,
  annotationPolicy = DEFAULT_ANNOTATION_POLICY,
  onAnnotationPolicy = noop,
  annotationLocked = false,
  recordingOff = false,
  onLock = noop,
  onWaitingRoom = noop,
  onAdmit = noop,
  onDeny = noop,
  onAdmitAll = noop,
  passwordSet = false,
  onPassword = noop,
  onRole = noop,
  recorderIds = [],
  onRecordAction = noop,
  audio,
  breakout = null,
  onAgentRemove = noop,
  messageable = [],
  onPrivateMessage,
  privateChat = true,
  onPrivateChat = noop,
}: ParticipantsPanelProps) {
  const [confirm, setConfirm] = useState<
    | { type: 'remove'; member: Member }
    | { type: 'makeHost'; member: Member }
    | { type: 'end' }
    | { type: 'waitingOff' }
    | null
  >(null)
  const role: Role = members.find((member) => member.id === you)?.role ?? 'participant'
  // Search and filters (O1, e10-t06): only once the list is long, or while one is in use
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ParticipantFilter>('all')
  const narrowed = query.trim() !== '' || filter !== 'all'
  const showTools = members.length >= SEARCH_FROM || narrowed
  // Raised hands first, in the queue's order (G3); then ourselves, by role, by arrival
  const hands = handQueue(members)
  const handPlace = new Map(hands.map((member, index) => [member.id, index + 1]))
  const rest = members
    .filter((member) => !handPlace.has(member.id))
    .sort(
      (a, b) =>
        Number(b.id === you) - Number(a.id === you) ||
        RANK[b.role] - RANK[a.role] ||
        a.joinedAt - b.joinedAt,
    )
  const sorted = [...hands, ...rest]
  const counts = filterCounts(members)
  const shown = narrowed ? filterMembers(sorted, query, filter) : sorted
  // Who 靜音列出的人 would mute: listed, microphone on, someone our role may mute
  const muteTargets = shown.filter(
    (member) =>
      member.id !== you && micIsOn(member) && canActOn(role, 'muteMember', member.role, false),
  )
  const canMuteAll = can(role, 'muteAll')
  const canEnd = can(role, 'endMeeting')
  const canLock = can(role, 'lockRoom')
  const canStartMuted = can(role, 'startMuted')
  const canWaitingRoom = can(role, 'waitingRoom')
  const canAdmit = can(role, 'admit')
  const canSetPassword = can(role, 'setPassword')
  const canSetPolicy = can(role, 'annotationPolicy')
  const canSetPrivateChat = can(role, 'privateChatPolicy')
  const toggleWaitingRoom = () => {
    if (waitingRoom && waiting.length > 0) setConfirm({ type: 'waitingOff' })
    else onWaitingRoom(!waitingRoom)
  }

  const itemsFor = (member: Member): MenuItem[] => {
    const mic = member.tracks.find((t) => t.kind === 'mic')
    const cam = member.tracks.find((t) => t.kind === 'cam')
    // Only what would change something: an unmuted microphone, a camera that is on, a share
    const applies: Record<Exclude<HostMemberAction, 'stopRecording'>, boolean> = {
      muteMember: !!mic && !mic.muted,
      camOff: !!cam && !cam.muted,
      stopShare: sharerIds.includes(member.id),
      stopControl: controlledIds.includes(member.id),
      remove: true,
      lowerHand: member.hand != null,
    }
    const self = member.id === you
    // Co-hosts and handing over (F3): only the host, never on oneself; handing over only to
    // someone connected
    const roles: MenuItem[] = []
    // A computer (N2) is nobody's co-host, host or recorder: only stopping its share and removing it
    const person = !member.agent
    if (person && canActOn(role, 'setCohost', member.role, self)) {
      roles.push(
        member.role === 'cohost'
          ? {
              id: 'revokeCohost',
              label: strings.participants.revokeCohost,
              onSelect: () => onRole('revokeCohost', member.id),
            }
          : {
              id: 'makeCohost',
              label: strings.participants.makeCohost,
              onSelect: () => onRole('makeCohost', member.id),
            },
      )
    }
    if (person && canActOn(role, 'makeHost', member.role, self) && !member.reconnecting) {
      roles.push({
        id: 'makeHost',
        label: strings.participants.makeHost,
        onSelect: () => setConfirm({ type: 'makeHost', member }),
      })
    }
    // Recording (I4): the host stops someone's, and allows or stops allowing someone to record
    const recording: MenuItem[] = []
    if (!self && recorderIds.includes(member.id) && can(role, 'record')) {
      recording.push({
        id: 'stopRecording',
        label: strings.record.stopTheirs,
        onSelect: () => onRecordAction('stop', member.id),
      })
    }
    if (
      person &&
      !recordingOff &&
      member.role !== 'host' &&
      canActOn(role, 'allowRecord', member.role, self)
    ) {
      recording.push(
        member.mayRecord
          ? {
              id: 'revokeRecord',
              label: strings.record.revoke,
              onSelect: () => onRecordAction('revoke', member.id),
            }
          : {
              id: 'allowRecord',
              label: strings.record.allow,
              onSelect: () => onRecordAction('allow', member.id),
            },
      )
    }
    const controls = memberActions()
      .filter(({ action }) => applies[action] && canActOn(role, action, member.role, self))
      .map(({ action, label, danger }): MenuItem => ({
        id: action,
        label,
        tone: danger ? 'danger' : 'neutral',
        onSelect: () =>
          action === 'remove'
            ? setConfirm({ type: 'remove', member })
            : onAction(action, member.id),
      }))
    // 私訊 (O4) first: it is for everyone, not only hosts
    const write: MenuItem[] =
      onPrivateMessage && messageable.includes(member.id)
        ? [
            {
              id: 'privateMessage',
              label: strings.chat.private.menu,
              onSelect: () => onPrivateMessage(member.id),
            },
          ]
        : []
    // Removing stays last (the dangerous one)
    const remove = controls.filter((item) => item.id === 'remove')
    return [
      ...write,
      ...controls.filter((item) => item.id !== 'remove'),
      ...recording,
      ...roles,
      ...remove,
    ]
  }

  const rowOf = (member: Member) => {
    const mic = member.tracks.find((t) => t.kind === 'mic')
    const cam = member.tracks.find((t) => t.kind === 'cam')
    const micOn = !!mic && !mic.muted
    const camOn = !!cam && !cam.muted
    const items = itemsFor(member)
    // A desktop agent (N2): a computer for an avatar, the computer's own name and system under
    // its name, no microphone or camera to show, and 中斷 for whoever paired it
    const agent = member.agent
    const ours = agent !== undefined && agent.owner !== null && agent.owner === you
    const roleLabel =
      member.role === 'host'
        ? strings.participants.host
        : member.role === 'cohost'
          ? strings.participants.cohost
          : null
    return (
      <Row key={member.id} aria-label={member.name} $away={member.reconnecting}>
        {agent ? (
          <Avatar aria-hidden="true" $computer>
            <ComputerIcon />
          </Avatar>
        ) : (
          <Avatar aria-hidden="true" style={{ background: avatarColor(member.name) }}>
            {[...member.name][0]?.toUpperCase()}
          </Avatar>
        )}
        <Who>
          <Name>{member.name}</Name>
          {agent && (
            <Hint>
              {strings.agent.device(agent.device, strings.agent.platforms[agent.platform])}
            </Hint>
          )}
          <Tags>
            {handPlace.has(member.id) && (
              <HandTag
                role="img"
                aria-label={strings.reactions.handPosition(handPlace.get(member.id)!)}
              >
                <HandIcon />
                <span aria-hidden="true">{handPlace.get(member.id)}</span>
              </HandTag>
            )}
            {member.id === you && <Tag>{strings.participants.you}</Tag>}
            {roleLabel && <Tag $strong>{roleLabel}</Tag>}
            {member.reconnecting && <Tag $warn>{strings.participants.reconnecting}</Tag>}
            {recorderIds.includes(member.id) && <Tag $danger>{strings.record.tag}</Tag>}
          </Tags>
          {audio && !agent && <LevelBar track={audio.levelOf(member.id)} />}
          {audio?.volumeSupported && member.id !== you && !agent && (
            <VolumeSlider
              label={strings.participants.volumeOf(member.name)}
              value={audio.volumeOf(member.id)}
              onChange={(percent) => audio.onVolume(member.id, percent)}
            />
          )}
          {audio?.volumeSupported && member.id !== you && audio.sharesSound(member.id) && (
            <VolumeSlider
              label={strings.participants.shareVolumeOf(member.name)}
              value={audio.volumeOf(shareVolumeKey(member.id))}
              onChange={(percent) => audio.onVolume(shareVolumeKey(member.id), percent)}
            />
          )}
        </Who>
        <States>
          {sharerIds.includes(member.id) && (
            <State
              role="img"
              aria-label={strings.participants.sharing}
              title={strings.participants.sharing}
              $on
            >
              <ScreenShareIcon />
            </State>
          )}
          {!agent && (
            <>
              <State
                role="img"
                aria-label={micOn ? strings.participants.micOn : strings.participants.micOff}
                title={micOn ? strings.participants.micOn : strings.participants.micOff}
                $off={!micOn}
              >
                {micOn ? <MicIcon /> : <MicOffIcon />}
              </State>
              <State
                role="img"
                aria-label={camOn ? strings.participants.camOn : strings.participants.camOff}
                title={camOn ? strings.participants.camOn : strings.participants.camOff}
                $off={!camOn}
              >
                {camOn ? <CamIcon /> : <CamOffIcon />}
              </State>
            </>
          )}
        </States>
        {ours && (
          <Button
            variant="secondary"
            aria-label={strings.agent.disconnectLabel(member.name)}
            onClick={() => onAgentRemove(member.id)}
          >
            {strings.agent.disconnect}
          </Button>
        )}
        {items.length > 0 && (
          <Menu
            label={strings.participants.actions(member.name)}
            icon={<MoreIcon />}
            items={items}
            align="end"
          />
        )}
      </Row>
    )
  }

  // While breakout rooms are open (L3): the main room, then each room in the host's order
  const rooms: { id: string | null; name: string }[] = breakout
    ? [{ id: null, name: strings.breakout.mainRoom }, ...breakout.groups]
    : []

  return (
    <Root>
      {(canLock ||
        canWaitingRoom ||
        canStartMuted ||
        canSetPassword ||
        canSetPolicy ||
        canSetPrivateChat) && (
        <Settings aria-label={strings.participants.settings}>
          {canLock && (
            <Switch
              label={strings.participants.lock}
              hint={strings.participants.lockHint}
              on={locked}
              onToggle={() => onLock(!locked)}
            />
          )}
          {canWaitingRoom && (
            <Switch
              label={strings.participants.waitingRoom}
              hint={strings.participants.waitingRoomHint}
              on={waitingRoom}
              onToggle={toggleWaitingRoom}
            />
          )}
          {canStartMuted && (
            <Switch
              label={strings.participants.startMuted}
              hint={strings.participants.startMutedHint}
              on={startMuted}
              onToggle={() => onStartMuted(!startMuted)}
            />
          )}
          {canSetPrivateChat && (
            <Switch
              label={strings.chat.private.switch}
              hint={strings.chat.private.switchHint}
              on={privateChat}
              onToggle={() => onPrivateChat(!privateChat)}
            />
          )}
          {canSetPolicy && (
            <SwitchRow>
              <SwitchText>
                <Name id="annotation-policy-label">{strings.annotation.policy.label}</Name>
                <Hint>
                  {annotationLocked
                    ? strings.annotation.policy.lockedByOwner
                    : strings.annotation.policy.hint[annotationPolicy]}
                </Hint>
              </SwitchText>
              <PolicySelect
                aria-labelledby="annotation-policy-label"
                value={annotationPolicy}
                disabled={annotationLocked}
                onChange={(event) => onAnnotationPolicy(event.target.value as AnnotationPolicy)}
              >
                {ANNOTATION_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {strings.annotation.policy.options[policy]}
                  </option>
                ))}
              </PolicySelect>
            </SwitchRow>
          )}
          {canSetPassword && (
            <SwitchRow>
              <SwitchText>
                <Name>{strings.participants.password}</Name>
                <Hint>
                  {passwordSet ? strings.participants.passwordOn : strings.participants.passwordOff}
                </Hint>
              </SwitchText>
              <Button
                variant="secondary"
                aria-label={passwordSet ? strings.password.changeTitle : strings.password.setTitle}
                onClick={onPassword}
              >
                {passwordSet
                  ? strings.participants.passwordChange
                  : strings.participants.passwordSet}
              </Button>
            </SwitchRow>
          )}
        </Settings>
      )}
      {canAdmit && waiting.length > 0 && (
        <Waiting aria-labelledby="waiting-title">
          <WaitingHead>
            <h3 id="waiting-title">{strings.participants.waiting(waiting.length)}</h3>
            {waiting.length > 1 && (
              <Button variant="secondary" onClick={onAdmitAll}>
                {strings.participants.admitAll}
              </Button>
            )}
          </WaitingHead>
          <WaitingList aria-label={strings.participants.waitingList}>
            {waiting.map((entry) => (
              <Row key={entry.id} aria-label={entry.name} $away={entry.reconnecting}>
                <Avatar aria-hidden="true" style={{ background: avatarColor(entry.name) }}>
                  {[...entry.name][0]?.toUpperCase()}
                </Avatar>
                <Who>
                  <Name>{entry.name}</Name>
                  {entry.reconnecting && (
                    <Tags>
                      <Tag $warn>{strings.participants.reconnecting}</Tag>
                    </Tags>
                  )}
                </Who>
                <Decide>
                  <Button
                    variant="secondary"
                    aria-label={strings.participants.denyLabel(entry.name)}
                    onClick={() => onDeny(entry.id)}
                  >
                    {strings.participants.deny}
                  </Button>
                  <Button
                    aria-label={strings.participants.admitLabel(entry.name)}
                    onClick={() => onAdmit(entry.id)}
                  >
                    {strings.participants.admit}
                  </Button>
                </Decide>
              </Row>
            ))}
          </WaitingList>
        </Waiting>
      )}
      {/* The settings can leave it short enough to scroll, and a row may have nothing to tab to */}
      {audio && !audio.volumeSupported && members.length > 1 && (
        <VolumeNote>{strings.participants.volumeUnsupported}</VolumeNote>
      )}
      {showTools && (
        <Tools>
          <Search
            type="search"
            value={query}
            placeholder={strings.participants.searchPlaceholder}
            aria-label={strings.participants.search}
            enterKeyHint="search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query !== '') {
                // Clears the box first; a second Escape closes the panel as usual
                event.stopPropagation()
                setQuery('')
              }
            }}
          />
          <Filters role="group" aria-label={strings.participants.filters}>
            {PARTICIPANT_FILTERS.map((option) => (
              <Chip
                key={option}
                type="button"
                aria-pressed={filter === option}
                $on={filter === option}
                onClick={() => setFilter(option)}
              >
                {strings.participants.filterCount(
                  strings.participants.filter[option],
                  counts[option],
                )}
              </Chip>
            ))}
          </Filters>
          {narrowed && (
            <ShownCount role="status">
              {shown.length === 0
                ? strings.participants.noMatch
                : strings.participants.shownCount(shown.length, members.length)}
            </ShownCount>
          )}
          {narrowed && canMuteAll && muteTargets.length > 0 && (
            <Button
              variant="secondary"
              block
              title={strings.participants.muteShownHint}
              onClick={() => onMuteMembers(muteTargets.map((member) => member.id))}
            >
              {strings.participants.muteShown(muteTargets.length)}
            </Button>
          )}
        </Tools>
      )}
      <List aria-label={strings.participants.list} tabIndex={0}>
        {breakout
          ? rooms.map((room) => {
              const people = shown.filter((member) => (member.group ?? null) === room.id)
              // While searching, a room with nobody listed is left out
              if (narrowed && people.length === 0) return null
              const headingId = `participants-room-${room.id ?? 'main'}`
              return (
                <RoomItem key={room.id ?? 'main'}>
                  <RoomHeading id={headingId}>
                    {room.name}
                    <span>{strings.breakout.roomCount(people.length)}</span>
                  </RoomHeading>
                  <RoomList aria-labelledby={headingId}>{people.map(rowOf)}</RoomList>
                </RoomItem>
              )
            })
          : shown.map(rowOf)}
      </List>
      {(canMuteAll || canEnd) && (
        <Footer>
          {canMuteAll && (
            <Button
              variant="secondary"
              block
              title={strings.participants.muteAllHint}
              onClick={onMuteAll}
            >
              {strings.participants.muteAll}
            </Button>
          )}
          {canEnd && (
            <Button variant="danger" block onClick={() => setConfirm({ type: 'end' })}>
              {strings.participants.endMeeting}
            </Button>
          )}
        </Footer>
      )}
      {confirm?.type === 'remove' && (
        <ConfirmDialog
          title={strings.participants.removeTitle(confirm.member.name)}
          body={strings.participants.removeBody(confirm.member.name)}
          confirmLabel={strings.participants.removeConfirm}
          onConfirm={() => {
            setConfirm(null)
            onAction('remove', confirm.member.id)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.type === 'makeHost' && (
        <ConfirmDialog
          title={strings.participants.makeHostTitle(confirm.member.name)}
          body={strings.participants.makeHostBody(confirm.member.name)}
          confirmLabel={strings.participants.makeHostConfirm}
          onConfirm={() => {
            setConfirm(null)
            onRole('makeHost', confirm.member.id)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.type === 'waitingOff' && (
        <ConfirmDialog
          title={strings.participants.waitingOffTitle}
          body={strings.participants.waitingOffBody(waiting.length)}
          confirmLabel={strings.participants.waitingOffConfirm(waiting.length)}
          onConfirm={() => {
            setConfirm(null)
            onWaitingRoom(false)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.type === 'end' && (
        <ConfirmDialog
          title={strings.participants.endTitle}
          body={strings.participants.endBody}
          confirmLabel={strings.participants.endConfirm}
          onConfirm={() => {
            setConfirm(null)
            onEndMeeting()
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Root>
  )
}

/**
 * How loud someone is now (e6-t08). Read from the speaking monitor (its one analyser per microphone
 * and one timer), written straight to the element: no re-render, however many people. Not named to
 * a screen reader, like the speaking outline: a value that changes ten times a second is not
 * something to hear.
 */
function LevelBar({ track }: { track: MediaStreamTrack | null }) {
  const fill = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = fill.current
    if (!element) return
    element.style.transform = 'scaleX(0)'
    if (!track) return
    return speakingMonitor().watchLevel(track, (level) => {
      element.style.transform = `scaleX(${level.toFixed(2)})`
    })
  }, [track])
  return (
    <LevelTrack aria-hidden="true" data-level-meter="">
      <LevelFill ref={fill} />
    </LevelTrack>
  )
}

function VolumeSlider({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (percent: number) => void
}) {
  const text = strings.participants.volumeValue(value)
  return (
    <VolumeRow>
      <input
        type="range"
        min={VOLUME_MIN}
        max={VOLUME_MAX}
        step={VOLUME_STEP}
        value={value}
        aria-label={label}
        aria-valuetext={text}
        title={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span aria-hidden="true">{text}</span>
    </VolumeRow>
  )
}

/** One of the room's switches: what it is, what it does, on or off */
function Switch({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string
  hint: string
  on: boolean
  onToggle: () => void
}) {
  return (
    <SwitchRow>
      <SwitchText>
        <Name>{label}</Name>
        <Hint>{hint}</Hint>
      </SwitchText>
      <Toggle type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle}>
        <Knob $on={on} />
      </Toggle>
    </SwitchRow>
  )
}

/** The search box and the filters (O1): above the list, not scrolling with it */
const Tools = styled.div`
  display: grid;
  gap: ${space(2)};
  padding: ${space(3)} ${space(4)};
  border-bottom: 1px solid ${color.line};
`

const Search = styled.input`
  width: 100%;
  min-height: 40px;
  padding: ${space(1)} ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface};
  color: ${color.fg};
  font: inherit;
  font-size: ${fontSize.small};

  &::placeholder {
    color: ${color.muted};
  }
  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 1px;
  }
`

const Filters = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${space(1.5)};
`

/** 32 px tall: four fit a phone's row; the pressed one filled */
const Chip = styled.button<{ $on: boolean }>`
  min-height: 32px;
  padding: 0 ${space(2.5)};
  border: 1px solid ${({ $on }) => ($on ? color.primary : color.line)};
  border-radius: ${radius.pill};
  background: ${({ $on }) => ($on ? color.primarySoft : 'transparent')};
  color: ${({ $on }) => ($on ? color.primary : color.fg)};
  font: inherit;
  font-size: ${fontSize.toolbarLabel};
  font-weight: ${({ $on }) => ($on ? 700 : 400)};
  cursor: pointer;

  &:hover {
    background: ${({ $on }) => ($on ? color.primarySoft : color.hover)};
  }
  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 2px;
  }
`

const ShownCount = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`

const Root = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
`

const List = styled.ul`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: ${space(2)};
  list-style: none;
`

/** One breakout room in the list (L3): its name and head count, then its people */
const RoomItem = styled.li`
  & + & {
    margin-top: ${space(2)};
  }
`

const RoomHeading = styled.h3`
  display: flex;
  align-items: baseline;
  gap: ${space(2)};
  margin: 0;
  padding: ${space(1)} ${space(2)};
  font-size: ${fontSize.small};
  font-weight: 700;
  overflow-wrap: anywhere;

  span {
    color: ${color.muted};
    font-weight: 400;
  }
`

const RoomList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
`

const Row = styled.li<{ $away: boolean }>`
  display: flex;
  align-items: center;
  gap: ${space(3)};
  padding: ${space(2)};
  border-radius: ${radius.button};
  opacity: ${({ $away }) => ($away ? 0.6 : 1)};

  &:hover {
    background: ${color.hover};
  }
`

const Avatar = styled.span<{ $computer?: boolean }>`
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: ${radius.pill};
  background: ${({ $computer }) => ($computer ? color.surface2 : 'transparent')};
  color: ${({ $computer }) => ($computer ? color.fg : avatar.text)};
  font-size: ${fontSize.small};
  font-weight: 700;

  svg {
    width: 18px;
    height: 18px;
  }
`

const Who = styled.span`
  display: grid;
  flex: 1;
  min-width: 0;
  gap: ${space(0.5)};
`

const Name = styled.span`
  overflow: hidden;
  font-size: ${fontSize.small};
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
`

const Tags = styled.span`
  display: flex;
  flex-wrap: wrap;
  gap: ${space(1)};

  &:empty {
    display: none;
  }
`

const Tag = styled.span<{ $strong?: boolean; $warn?: boolean; $danger?: boolean }>`
  padding: 0 ${space(1.5)};
  border-radius: ${radius.pill};
  background: ${({ $strong }) => ($strong ? color.primarySoft : color.surface2)};
  color: ${({ $strong, $warn, $danger }) =>
    $danger ? color.danger : $warn ? color.warn : $strong ? color.primary : color.muted};
  font-weight: ${({ $danger }) => ($danger ? 700 : 400)};
  font-size: ${fontSize.badge};
  line-height: 1.6;
`

/** A raised hand and its place in the queue (G3): amber, like the tile's */
const HandTag = styled.span`
  display: inline-flex;
  align-items: center;
  gap: ${space(0.5)};
  padding: 0 ${space(1.5)};
  border-radius: ${radius.pill};
  background: ${color.warn};
  color: ${color.onWarn};
  font-size: ${fontSize.badge};
  font-weight: 700;
  line-height: 1.6;

  svg {
    width: 12px;
    height: 12px;
  }
`

const LevelTrack = styled.span`
  display: block;
  height: 4px;
  overflow: hidden;
  border-radius: ${radius.pill};
  background: ${color.surface2};
`

const LevelFill = styled.span`
  display: block;
  height: 100%;
  background: ${color.speaking};
  transform: scaleX(0);
  transform-origin: left;
`

/** 24 px tall to touch (WCAG 2.5.8) */
const VolumeRow = styled.span`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  min-height: 24px;
  color: ${color.muted};
  font-size: ${fontSize.badge};

  input {
    flex: 1;
    min-width: 0;
    height: 24px;
    margin: 0;
    accent-color: ${color.primary};
    cursor: pointer;
  }
  input:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 2px;
  }
  span {
    flex: none;
  }
`

const VolumeNote = styled.p`
  margin: 0;
  padding: ${space(2)} ${space(4)};
  border-bottom: 1px solid ${color.line};
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`

const States = styled.span`
  display: flex;
  flex: none;
  gap: ${space(1.5)};
`

const State = styled.span<{ $off?: boolean; $on?: boolean }>`
  display: inline-flex;
  color: ${({ $off, $on }) => ($off ? color.danger : $on ? color.primary : color.muted)};

  svg {
    width: 18px;
    height: 18px;
  }
`

const Settings = styled.section`
  display: grid;
  gap: ${space(2)};
  padding: ${space(3)} ${space(4)};
  border-bottom: 1px solid ${color.line};
`

const PolicySelect = styled.select`
  flex: none;
  max-width: 45%;
  min-height: 36px;
  padding: ${space(1)} ${space(2)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface};
  color: ${color.fg};
  font: inherit;
  font-size: ${fontSize.small};
`

const SwitchRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(3)};
`

const SwitchText = styled.span`
  display: grid;
  flex: 1;
  min-width: 0;
  gap: ${space(0.5)};
`

const Hint = styled.span`
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`

/** 44 px tall to touch, a 40 × 24 track inside */
const Toggle = styled.button`
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 52px;
  height: 44px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 2px;
    border-radius: ${radius.button};
  }
`

const Knob = styled.span<{ $on: boolean }>`
  position: relative;
  width: 40px;
  height: 24px;
  border-radius: ${radius.pill};
  background: ${({ $on }) => ($on ? color.primary : color.surface2)};
  box-shadow: inset 0 0 0 1px ${color.line};
  transition: background ${motion.fast};

  &::after {
    content: '';
    position: absolute;
    top: 3px;
    left: ${({ $on }) => ($on ? '19px' : '3px')};
    width: 18px;
    height: 18px;
    border-radius: ${radius.pill};
    background: ${({ $on }) => ($on ? color.onPrimary : color.muted)};
    transition: left ${motion.fast};
  }
`

const Waiting = styled.section`
  padding: ${space(2)} 0 0;
  border-bottom: 1px solid ${color.line};

  h3 {
    margin: 0;
    color: ${color.warn};
    font-size: ${fontSize.small};
  }
`

const WaitingHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${space(2)};
  min-height: 44px;
  padding: 0 ${space(4)};
`

const WaitingList = styled.ul`
  max-height: 40vh;
  overflow-y: auto;
  margin: 0;
  padding: 0 ${space(2)} ${space(2)};
  list-style: none;
`

const Decide = styled.span`
  display: flex;
  flex: none;
  gap: ${space(2)};
`

const Footer = styled.div`
  display: grid;
  gap: ${space(2)};
  padding: ${space(3)} ${space(4)};
  border-top: 1px solid ${color.line};
`

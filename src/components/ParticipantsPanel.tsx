import { useState } from 'react'
import styled from 'styled-components'
import type { HostMemberAction, Member, WaitingEntry } from '../../shared/protocol.ts'
import { RANK, can, canActOn, type Role } from '../../shared/roles.ts'
import { strings } from '../strings.ts'
import { avatar, avatarColor, color, fontSize, motion, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { CamIcon, CamOffIcon, MicIcon, MicOffIcon, MoreIcon, ScreenShareIcon } from './icons.tsx'
import { Menu, type MenuItem } from './Menu.tsx'

const text = strings.participants

export interface ParticipantsPanelProps {
  members: Member[]
  /** Our own member id */
  you: string | null
  /** Who shares the screen now, if anyone */
  sharerId: string | null
  /** A host control on one member (the room decides whether it is allowed, worker/roles.ts) */
  onAction: (action: HostMemberAction, memberId: string) => void
  onMuteAll: () => void
  onEndMeeting: () => void
  /** Who waits to be admitted (F2), in the queue's order */
  waiting?: WaitingEntry[]
  /** The room's switches (F2) */
  locked?: boolean
  waitingRoom?: boolean
  onLock?: (on: boolean) => void
  /** Turning it off admits everyone waiting (the panel asks first when anyone does) */
  onWaitingRoom?: (on: boolean) => void
  onAdmit?: (memberId: string) => void
  onDeny?: (memberId: string) => void
  onAdmitAll?: () => void
}

const noop = () => {}

/** What the per-person menu offers, in order, with the role table's action for each */
const MEMBER_ACTIONS: readonly { action: HostMemberAction; label: string; danger?: true }[] = [
  { action: 'muteMember', label: text.mute },
  { action: 'camOff', label: text.camOffAction },
  { action: 'stopShare', label: text.stopShare },
  { action: 'remove', label: text.remove, danger: true },
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
 */
export function ParticipantsPanel({
  members,
  you,
  sharerId,
  onAction,
  onMuteAll,
  onEndMeeting,
  waiting = [],
  locked = false,
  waitingRoom = false,
  onLock = noop,
  onWaitingRoom = noop,
  onAdmit = noop,
  onDeny = noop,
  onAdmitAll = noop,
}: ParticipantsPanelProps) {
  const [confirm, setConfirm] = useState<
    { type: 'remove'; member: Member } | { type: 'end' } | { type: 'waitingOff' } | null
  >(null)
  const role: Role = members.find((member) => member.id === you)?.role ?? 'participant'
  const sorted = [...members].sort(
    (a, b) =>
      Number(b.id === you) - Number(a.id === you) ||
      RANK[b.role] - RANK[a.role] ||
      a.joinedAt - b.joinedAt,
  )
  const canMuteAll = can(role, 'muteAll')
  const canEnd = can(role, 'endMeeting')
  const canLock = can(role, 'lockRoom')
  const canWaitingRoom = can(role, 'waitingRoom')
  const canAdmit = can(role, 'admit')
  const toggleWaitingRoom = () => {
    if (waitingRoom && waiting.length > 0) setConfirm({ type: 'waitingOff' })
    else onWaitingRoom(!waitingRoom)
  }

  const itemsFor = (member: Member): MenuItem[] => {
    const mic = member.tracks.find((t) => t.kind === 'mic')
    const cam = member.tracks.find((t) => t.kind === 'cam')
    // Only what would change something: an unmuted microphone, a camera that is on, a share
    const applies: Record<HostMemberAction, boolean> = {
      muteMember: !!mic && !mic.muted,
      camOff: !!cam && !cam.muted,
      stopShare: member.id === sharerId,
      remove: true,
    }
    return MEMBER_ACTIONS.filter(
      ({ action }) => applies[action] && canActOn(role, action, member.role, member.id === you),
    ).map(({ action, label, danger }) => ({
      id: action,
      label,
      tone: danger ? 'danger' : 'neutral',
      onSelect: () =>
        action === 'remove' ? setConfirm({ type: 'remove', member }) : onAction(action, member.id),
    }))
  }

  return (
    <Root>
      {(canLock || canWaitingRoom) && (
        <Settings aria-label={text.settings}>
          {canLock && (
            <Switch
              label={text.lock}
              hint={text.lockHint}
              on={locked}
              onToggle={() => onLock(!locked)}
            />
          )}
          {canWaitingRoom && (
            <Switch
              label={text.waitingRoom}
              hint={text.waitingRoomHint}
              on={waitingRoom}
              onToggle={toggleWaitingRoom}
            />
          )}
        </Settings>
      )}
      {canAdmit && waiting.length > 0 && (
        <Waiting aria-labelledby="waiting-title">
          <WaitingHead>
            <h3 id="waiting-title">{text.waiting(waiting.length)}</h3>
            {waiting.length > 1 && (
              <Button variant="secondary" onClick={onAdmitAll}>
                {text.admitAll}
              </Button>
            )}
          </WaitingHead>
          <WaitingList aria-label={text.waitingList}>
            {waiting.map((entry) => (
              <Row key={entry.id} aria-label={entry.name} $away={entry.reconnecting}>
                <Avatar aria-hidden="true" style={{ background: avatarColor(entry.name) }}>
                  {[...entry.name][0]?.toUpperCase()}
                </Avatar>
                <Who>
                  <Name>{entry.name}</Name>
                  {entry.reconnecting && (
                    <Tags>
                      <Tag $warn>{text.reconnecting}</Tag>
                    </Tags>
                  )}
                </Who>
                <Decide>
                  <Button
                    variant="secondary"
                    aria-label={text.denyLabel(entry.name)}
                    onClick={() => onDeny(entry.id)}
                  >
                    {text.deny}
                  </Button>
                  <Button
                    aria-label={text.admitLabel(entry.name)}
                    onClick={() => onAdmit(entry.id)}
                  >
                    {text.admit}
                  </Button>
                </Decide>
              </Row>
            ))}
          </WaitingList>
        </Waiting>
      )}
      <List aria-label={text.list}>
        {sorted.map((member) => {
          const mic = member.tracks.find((t) => t.kind === 'mic')
          const cam = member.tracks.find((t) => t.kind === 'cam')
          const micOn = !!mic && !mic.muted
          const camOn = !!cam && !cam.muted
          const items = itemsFor(member)
          const roleLabel =
            member.role === 'host' ? text.host : member.role === 'cohost' ? text.cohost : null
          return (
            <Row key={member.id} aria-label={member.name} $away={member.reconnecting}>
              <Avatar aria-hidden="true" style={{ background: avatarColor(member.name) }}>
                {[...member.name][0]?.toUpperCase()}
              </Avatar>
              <Who>
                <Name>{member.name}</Name>
                <Tags>
                  {member.id === you && <Tag>{text.you}</Tag>}
                  {roleLabel && <Tag $strong>{roleLabel}</Tag>}
                  {member.reconnecting && <Tag $warn>{text.reconnecting}</Tag>}
                </Tags>
              </Who>
              <States>
                {member.id === sharerId && (
                  <State role="img" aria-label={text.sharing} title={text.sharing} $on>
                    <ScreenShareIcon />
                  </State>
                )}
                <State
                  role="img"
                  aria-label={micOn ? text.micOn : text.micOff}
                  title={micOn ? text.micOn : text.micOff}
                  $off={!micOn}
                >
                  {micOn ? <MicIcon /> : <MicOffIcon />}
                </State>
                <State
                  role="img"
                  aria-label={camOn ? text.camOn : text.camOff}
                  title={camOn ? text.camOn : text.camOff}
                  $off={!camOn}
                >
                  {camOn ? <CamIcon /> : <CamOffIcon />}
                </State>
              </States>
              {items.length > 0 && (
                <Menu
                  label={text.actions(member.name)}
                  icon={<MoreIcon />}
                  items={items}
                  align="end"
                />
              )}
            </Row>
          )
        })}
      </List>
      {(canMuteAll || canEnd) && (
        <Footer>
          {canMuteAll && (
            <Button variant="secondary" block title={text.muteAllHint} onClick={onMuteAll}>
              {text.muteAll}
            </Button>
          )}
          {canEnd && (
            <Button variant="danger" block onClick={() => setConfirm({ type: 'end' })}>
              {text.endMeeting}
            </Button>
          )}
        </Footer>
      )}
      {confirm?.type === 'remove' && (
        <ConfirmDialog
          title={text.removeTitle(confirm.member.name)}
          body={text.removeBody(confirm.member.name)}
          confirmLabel={text.removeConfirm}
          onConfirm={() => {
            setConfirm(null)
            onAction('remove', confirm.member.id)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.type === 'waitingOff' && (
        <ConfirmDialog
          title={text.waitingOffTitle}
          body={text.waitingOffBody(waiting.length)}
          confirmLabel={text.waitingOffConfirm(waiting.length)}
          onConfirm={() => {
            setConfirm(null)
            onWaitingRoom(false)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.type === 'end' && (
        <ConfirmDialog
          title={text.endTitle}
          body={text.endBody}
          confirmLabel={text.endConfirm}
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

const Avatar = styled.span`
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: ${radius.pill};
  color: ${avatar.text};
  font-size: ${fontSize.small};
  font-weight: 700;
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

const Tag = styled.span<{ $strong?: boolean; $warn?: boolean }>`
  padding: 0 ${space(1.5)};
  border-radius: ${radius.pill};
  background: ${({ $strong }) => ($strong ? color.primarySoft : color.surface2)};
  color: ${({ $strong, $warn }) => ($warn ? color.warn : $strong ? color.primary : color.muted)};
  font-size: ${fontSize.badge};
  line-height: 1.6;
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

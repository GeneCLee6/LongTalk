import { useState } from 'react'
import styled from 'styled-components'
import type { HostMemberAction, Member } from '../../shared/protocol.ts'
import { RANK, can, canActOn, type Role } from '../../shared/roles.ts'
import { strings } from '../strings.ts'
import { avatar, avatarColor, color, fontSize, radius, space } from '../styles/tokens.ts'
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
}

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
 */
export function ParticipantsPanel({
  members,
  you,
  sharerId,
  onAction,
  onMuteAll,
  onEndMeeting,
}: ParticipantsPanelProps) {
  const [confirm, setConfirm] = useState<
    { type: 'remove'; member: Member } | { type: 'end' } | null
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

const Footer = styled.div`
  display: grid;
  gap: ${space(2)};
  padding: ${space(3)} ${space(4)};
  border-top: 1px solid ${color.line};
`

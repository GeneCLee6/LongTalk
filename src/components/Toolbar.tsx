import styled from 'styled-components'
import { strings } from '../strings.ts'
import { space } from '../styles/tokens.ts'
import { IconButton } from './IconButton.tsx'
import { ChatIcon, LeaveIcon, MoreIcon, PeopleIcon, ScreenShareIcon } from './icons.tsx'
import { usePhoneLayout } from './layoutContext.ts'
import { MediaControls, type MediaControlsProps } from './MediaControls.tsx'
import { Menu, type MenuItem } from './Menu.tsx'
import { ReactionsButton, type ReactionsButtonProps } from './ReactionsButton.tsx'

export interface ToolbarProps extends Omit<MediaControlsProps, 'children'> {
  /** Members in the room, on the participants button */
  memberCount: number
  /**
   * People in the waiting room, for a host or co-host (F2): while any wait, the participants
   * button's badge counts them, in amber
   */
  waitingCount?: number
  /** This browser can share the screen (getDisplayMedia exists; not on phones) */
  canShareScreen: boolean
  /** We share the screen now: the button stops it (e3-t03) */
  sharing?: boolean
  /** 分享螢幕 pressed (or 停止分享 while sharing) */
  onToggleShare: () => void
  /** The chat is open (desktop side panel or phone drawer, D3) */
  chatOpen?: boolean
  /** Unread chat messages: the badge on 聊天 (none at 0) */
  chatUnread?: number
  /** 聊天 pressed: open or close the chat */
  onToggleChat: () => void
  /** The participants list is open (desktop side panel or phone drawer, F1) */
  participantsOpen?: boolean
  /** 參與者 pressed: open or close the participants list */
  onToggleParticipants: () => void
  /** What 更多 offers (rename the room, change my name, share the link); share comes first */
  moreItems: MenuItem[]
  /** Leave the room (on phones the top bar has the button instead) */
  onLeave: () => void
  /**
   * 反應 (G3): the reactions and the raised hand. On a phone it takes the fifth key and
   * participants moves into 更多 (DESIGN.md §4.3)
   */
  reactions?: ReactionsButtonProps
}

/**
 * The room's bottom toolbar (e4-t06, DESIGN.md §4.3): microphone and camera (MediaControls),
 * share, chat, participants, more, leave. Share works from D1 (e3-t03: while sharing it is
 * 停止分享, in red); chat from D3 (e5-t02: opens the side panel or drawer, with the unread count
 * as its badge); participants from F1 (e1-t08: the same panel or drawer, with the member count
 * as its badge).
 *
 * On a phone (e4-t07) it is one row of icons within a thumb's reach: microphone, camera,
 * reactions, chat, more (DESIGN.md §4.3; participants held the reactions' place until G3 and is
 * now in 更多, and a tab away in the chat drawer; 更多 carries the waiting room's badge for a
 * host), and 離開 moves to the top bar's right end, away from the thumb, so nobody leaves by
 * accident. Reactions come before chat on a desktop too, after share (DESIGN.md's toolbar).
 *
 * Where there is no 分享螢幕 button (e3-t10, AC-3.6) 更多 says why, as its first item, greyed
 * out with the reason under it: phone browsers cannot share; neither can a desktop browser
 * without getDisplayMedia. A desktop window as narrow as a phone gets the phone layout but can
 * share: there 分享螢幕 (or 停止分享) moves into 更多 instead.
 */
export function Toolbar({
  memberCount,
  waitingCount = 0,
  canShareScreen,
  sharing = false,
  onToggleShare,
  chatOpen = false,
  chatUnread = 0,
  onToggleChat,
  participantsOpen = false,
  onToggleParticipants,
  moreItems,
  onLeave,
  reactions,
  ...media
}: ToolbarProps) {
  const phone = usePhoneLayout() !== null
  // On a phone 反應 takes participants' key; participants is the first of 更多 then
  const participantsInMore = phone && reactions !== undefined
  const participantsLabel =
    waitingCount > 0
      ? strings.toolbar.participantsWaiting(memberCount, waitingCount)
      : strings.toolbar.participantsCount(memberCount)
  const shareLabel = sharing ? strings.screenShare.stop : strings.toolbar.share
  const shareItem: MenuItem | null = !canShareScreen
    ? {
        id: 'share-screen',
        label: strings.toolbar.share,
        disabled: true,
        hint: phone ? strings.screenShare.unavailablePhone : strings.screenShare.unavailableBrowser,
        onSelect: () => undefined,
      }
    : phone
      ? {
          id: 'share-screen',
          label: shareLabel,
          tone: sharing ? 'danger' : 'neutral',
          onSelect: onToggleShare,
        }
      : null
  const participantsItem: MenuItem[] = participantsInMore
    ? [{ id: 'participants', label: participantsLabel, onSelect: onToggleParticipants }]
    : []
  const more = [...(shareItem ? [shareItem] : []), ...participantsItem, ...moreItems]
  return (
    <MediaControls {...media}>
      {canShareScreen && !phone && (
        <IconButton
          label={shareLabel}
          icon={<ScreenShareIcon />}
          showLabel
          tone={sharing ? 'danger' : 'neutral'}
          onClick={onToggleShare}
        />
      )}
      {reactions && <ReactionsButton {...reactions} />}
      <IconButton
        label={strings.toolbar.chatUnread(chatUnread)}
        caption={strings.toolbar.chat}
        icon={<ChatIcon />}
        badge={chatUnread > 0 ? chatUnread : undefined}
        showLabel
        aria-expanded={chatOpen}
        onClick={onToggleChat}
      />
      {!participantsInMore && (
        <IconButton
          label={participantsLabel}
          caption={strings.toolbar.participants}
          icon={<PeopleIcon />}
          badge={waitingCount > 0 ? waitingCount : memberCount}
          badgeTone={waitingCount > 0 ? 'warn' : 'primary'}
          showLabel
          aria-expanded={participantsOpen}
          onClick={onToggleParticipants}
        />
      )}
      {more.length > 0 && (
        <Menu
          label={strings.toolbar.more}
          triggerLabel={
            participantsInMore && waitingCount > 0
              ? strings.toolbar.moreWaiting(waitingCount)
              : undefined
          }
          badge={participantsInMore && waitingCount > 0 ? waitingCount : undefined}
          badgeTone="warn"
          icon={<MoreIcon />}
          items={more}
          placement="above"
          align="end"
          showLabel
        />
      )}
      {!phone && (
        <Leave>
          <IconButton
            label={strings.toolbar.leave}
            icon={<LeaveIcon />}
            tone="danger"
            showLabel
            onClick={onLeave}
          />
        </Leave>
      )}
    </MediaControls>
  )
}

const Leave = styled.span`
  display: inline-flex;
  margin-left: ${space(2)};
`

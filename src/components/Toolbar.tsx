import styled from 'styled-components'
import { strings } from '../strings.ts'
import { space } from '../styles/tokens.ts'
import { IconButton } from './IconButton.tsx'
import { ChatIcon, LeaveIcon, MoreIcon, PeopleIcon, ScreenShareIcon } from './icons.tsx'
import { usePhoneLayout } from './layoutContext.ts'
import { MediaControls, type MediaControlsProps } from './MediaControls.tsx'
import { Menu, type MenuItem } from './Menu.tsx'

export interface ToolbarProps extends Omit<MediaControlsProps, 'children'> {
  /** Members in the room, on the participants button */
  memberCount: number
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
  /** A button whose feature is not there yet was pressed: say it is coming */
  onComingSoon: (feature: string) => void
  /** What 更多 offers (rename the room, change my name, share the link); share comes first */
  moreItems: MenuItem[]
  /** Leave the room (on phones the top bar has the button instead) */
  onLeave: () => void
}

/**
 * The room's bottom toolbar (e4-t06, DESIGN.md §4.3): microphone and camera (MediaControls),
 * share, chat, participants, more, leave. Share works from D1 (e3-t03: while sharing it is
 * 停止分享, in red); chat from D3 (e5-t02: opens the side panel or drawer, with the unread count
 * as its badge); participants lands in F1: until then it is shown dimmed (aria-disabled) and a
 * press says it is coming.
 *
 * On a phone (e4-t07) it is one row of icons within a thumb's reach: microphone, camera, chat,
 * participants, more (DESIGN.md §4.3's fifth key, reactions, comes with E5; participants holds
 * its place until then), and 離開 moves to the top bar's right end, away from the thumb, so nobody
 * leaves by accident.
 *
 * Where there is no 分享螢幕 button (e3-t10, AC-3.6) 更多 says why, as its first item, greyed
 * out with the reason under it: phone browsers cannot share; neither can a desktop browser
 * without getDisplayMedia. A desktop window as narrow as a phone gets the phone layout but can
 * share: there 分享螢幕 (or 停止分享) moves into 更多 instead.
 */
export function Toolbar({
  memberCount,
  canShareScreen,
  sharing = false,
  onToggleShare,
  chatOpen = false,
  chatUnread = 0,
  onToggleChat,
  onComingSoon,
  moreItems,
  onLeave,
  ...media
}: ToolbarProps) {
  const phone = usePhoneLayout() !== null
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
  const more = shareItem ? [shareItem, ...moreItems] : moreItems
  const soon = (feature: string) => ({
    'aria-disabled': true,
    title: strings.toolbar.comingSoon(feature),
    onClick: () => onComingSoon(feature),
  })
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
      <IconButton
        label={strings.toolbar.chatUnread(chatUnread)}
        caption={strings.toolbar.chat}
        icon={<ChatIcon />}
        badge={chatUnread > 0 ? chatUnread : undefined}
        showLabel
        aria-expanded={chatOpen}
        onClick={onToggleChat}
      />
      <IconButton
        label={strings.toolbar.participantsCount(memberCount)}
        caption={strings.toolbar.participants}
        icon={<PeopleIcon />}
        badge={memberCount}
        showLabel
        {...soon(strings.toolbar.participants)}
      />
      {more.length > 0 && (
        <Menu
          label={strings.toolbar.more}
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

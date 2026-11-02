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
  /** Show 分享螢幕 (getDisplayMedia exists; not on phones) */
  canShareScreen: boolean
  /** We share the screen now: the button stops it (e3-t03) */
  sharing?: boolean
  /** 分享螢幕 pressed (or 停止分享 while sharing) */
  onToggleShare: () => void
  /** A button whose feature is not there yet was pressed: say it is coming */
  onComingSoon: (feature: string) => void
  /** What 更多 offers (rename the room, change my name, share the link) */
  moreItems: MenuItem[]
  /** Leave the room (on phones the top bar has the button instead) */
  onLeave: () => void
}

/**
 * The room's bottom toolbar (e4-t06, DESIGN.md §4.3): microphone and camera (MediaControls),
 * share, chat, participants, more, leave. Share works from D1 (e3-t03: while sharing it is
 * 停止分享, in red); chat and participants land in D3 and F1: until then they are shown dimmed
 * (aria-disabled) and a press says they are coming.
 *
 * On a phone (e4-t07) it is one row of icons within a thumb's reach: microphone, camera, chat,
 * participants, more (DESIGN.md §4.3's fifth key, reactions, comes with E5; participants holds
 * its place until then). No screen sharing (phones cannot), and 離開 moves to the top bar's right
 * end, away from the thumb, so nobody leaves by accident.
 */
export function Toolbar({
  memberCount,
  canShareScreen,
  sharing = false,
  onToggleShare,
  onComingSoon,
  moreItems,
  onLeave,
  ...media
}: ToolbarProps) {
  const phone = usePhoneLayout() !== null
  const soon = (feature: string) => ({
    'aria-disabled': true,
    title: strings.toolbar.comingSoon(feature),
    onClick: () => onComingSoon(feature),
  })
  return (
    <MediaControls {...media}>
      {canShareScreen && !phone && (
        <IconButton
          label={sharing ? strings.screenShare.stop : strings.toolbar.share}
          icon={<ScreenShareIcon />}
          showLabel
          tone={sharing ? 'danger' : 'neutral'}
          onClick={onToggleShare}
        />
      )}
      <IconButton
        label={strings.toolbar.chat}
        icon={<ChatIcon />}
        showLabel
        {...soon(strings.toolbar.chat)}
      />
      <IconButton
        label={strings.toolbar.participantsCount(memberCount)}
        caption={strings.toolbar.participants}
        icon={<PeopleIcon />}
        badge={memberCount}
        showLabel
        {...soon(strings.toolbar.participants)}
      />
      {moreItems.length > 0 && (
        <Menu
          label={strings.toolbar.more}
          icon={<MoreIcon />}
          items={moreItems}
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

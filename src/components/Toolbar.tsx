import styled from 'styled-components'
import { strings } from '../strings.ts'
import { space } from '../styles/tokens.ts'
import { IconButton } from './IconButton.tsx'
import { ChatIcon, LeaveIcon, MoreIcon, PeopleIcon, ScreenShareIcon } from './icons.tsx'
import { MediaControls, type MediaControlsProps } from './MediaControls.tsx'
import { Menu, type MenuItem } from './Menu.tsx'

export interface ToolbarProps extends Omit<MediaControlsProps, 'children'> {
  /** Members in the room, on the participants button */
  memberCount: number
  /** Show 分享螢幕 (getDisplayMedia exists; not on phones) */
  canShareScreen: boolean
  /** A button whose feature is not there yet was pressed: say it is coming */
  onComingSoon: (feature: string) => void
  /** What 更多 offers (rename the room, change my name, share the link) */
  moreItems: MenuItem[]
  onLeave: () => void
}

/**
 * The room's bottom toolbar (e4-t06, DESIGN.md §4.3): microphone and camera (MediaControls),
 * share, chat, participants, more, leave. Share, chat and participants land in D1, D3 and F1:
 * until then they are shown dimmed (aria-disabled) and a press says they are coming.
 */
export function Toolbar({
  memberCount,
  canShareScreen,
  onComingSoon,
  moreItems,
  onLeave,
  ...media
}: ToolbarProps) {
  const soon = (feature: string) => ({
    'aria-disabled': true,
    title: strings.toolbar.comingSoon(feature),
    onClick: () => onComingSoon(feature),
  })
  return (
    <MediaControls {...media}>
      {canShareScreen && (
        <IconButton
          label={strings.toolbar.share}
          icon={<ScreenShareIcon />}
          showLabel
          {...soon(strings.toolbar.share)}
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
      <Leave>
        <IconButton
          label={strings.toolbar.leave}
          icon={<LeaveIcon />}
          tone="danger"
          showLabel
          onClick={onLeave}
        />
      </Leave>
    </MediaControls>
  )
}

const Leave = styled.span`
  display: inline-flex;
  margin-left: ${space(2)};
`

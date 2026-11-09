import { useState } from 'react'
import styled from 'styled-components'
import type { BreakoutView } from '../../shared/breakout.ts'
import { formatElapsed } from '../room/elapsed.ts'
import { strings } from '../strings.ts'
import { color, fontSize, media, radius, space } from '../styles/tokens.ts'
import { secondsOf, useBreakoutRemaining } from './useBreakoutClock.ts'

export interface BreakoutBarProps {
  breakout: BreakoutView
  /** The name of the room we are in; null: the main room */
  room: string | null
  /** A host or co-host (shared/roles.ts `breakout`): the button that opens the panel */
  onManage?: () => void
  /** For tests: the clock */
  now?: () => number
}

/**
 * The breakout rooms over the stage (L3, e10-t05), for everyone while they are open: in a room, its
 * name and the time left; in the main room, that they are on; during a recall, how long until
 * everyone is back. The host's last broadcast under it, until dismissed. The countdown is a timer
 * (not read out every second); what changes is said once, by a toast (useBreakoutNotices).
 */
export function BreakoutBar({ breakout, room, onManage, now = Date.now }: BreakoutBarProps) {
  const { phase, ms } = useBreakoutRemaining(breakout, now)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const broadcast =
    breakout.broadcast && breakout.broadcast.at !== dismissed ? breakout.broadcast : null
  return (
    <Wrap>
      <Bar aria-label={strings.breakout.label}>
        <Where $room={room !== null}>
          {room !== null ? strings.breakout.inRoom(room) : strings.breakout.inProgress}
        </Where>
        {phase === 'closing' && ms !== null ? (
          <Count role="timer" aria-label={strings.breakout.timerLabel} $warn>
            {room !== null
              ? strings.breakout.backIn(secondsOf(ms))
              : strings.breakout.closing(secondsOf(ms))}
          </Count>
        ) : (
          room !== null &&
          ms !== null && (
            <Count role="timer" aria-label={strings.breakout.timerLabel} $warn={false}>
              {strings.breakout.remaining(formatElapsed(secondsOf(ms) * 1000))}
            </Count>
          )
        )}
        {onManage && (
          <Manage type="button" onClick={onManage}>
            {strings.breakout.manage}
          </Manage>
        )}
      </Bar>
      {broadcast && (
        <Broadcast aria-label={strings.breakout.broadcastFrom(broadcast.by)}>
          <From>{strings.breakout.broadcastFrom(broadcast.by)}</From>
          <Text>{broadcast.text}</Text>
          <Dismiss
            type="button"
            aria-label={strings.breakout.dismissBroadcast}
            title={strings.breakout.dismissBroadcast}
            onClick={() => setDismissed(broadcast.at)}
          >
            ×
          </Dismiss>
        </Broadcast>
      )}
    </Wrap>
  )
}

const Wrap = styled.div`
  display: grid;
  flex: none;
  gap: ${space(1)};
`

const Bar = styled.section`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(2)};
  padding: ${space(1)} ${space(2)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface};
  font-size: ${fontSize.small};
`

const Where = styled.span<{ $room: boolean }>`
  min-width: 0;
  overflow: hidden;
  color: ${({ $room }) => ($room ? color.fg : color.muted)};
  font-weight: ${({ $room }) => ($room ? 700 : 400)};
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Count = styled.span<{ $warn: boolean }>`
  flex: none;
  padding: 0 ${space(2)};
  border: 1px solid ${({ $warn }) => ($warn ? color.warn : color.line)};
  border-radius: ${radius.pill};
  color: ${({ $warn }) => ($warn ? color.warn : color.fg)};
  font-weight: ${({ $warn }) => ($warn ? 700 : 400)};
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
`

const Manage = styled.button`
  flex: none;
  min-height: 32px;
  margin-left: auto;
  padding: 0 ${space(2)};
  border: none;
  border-radius: ${space(2)};
  background: transparent;
  color: ${color.primary};
  font: inherit;
  white-space: nowrap;
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }

  @media ${media.phone} {
    min-height: 44px;
  }
`

const Broadcast = styled.section`
  display: flex;
  align-items: flex-start;
  gap: ${space(2)};
  padding: ${space(2)};
  border-radius: ${radius.button};
  background: ${color.primarySoft};
  color: ${color.fg};
  font-size: ${fontSize.small};
`

const From = styled.span`
  flex: none;
  font-weight: 700;
`

const Text = styled.span`
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
`

const Dismiss = styled.button`
  flex: none;
  min-width: 32px;
  min-height: 32px;
  border: none;
  border-radius: ${space(2)};
  background: transparent;
  color: ${color.fg};
  font: inherit;
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }

  @media ${media.phone} {
    min-width: 44px;
    min-height: 44px;
  }
`

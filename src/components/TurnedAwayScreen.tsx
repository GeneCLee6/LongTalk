import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, media, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { LockIcon, HourglassIcon } from './icons.tsx'
import { LogoMark } from './Logo.tsx'

const text = strings.turnedAway

/**
 * - `locked`: the room is locked (F2, e1-t09)
 * - `denied`: the host turned us away from the waiting room, or we asked again too soon
 * - `waitExpired`: waited WAIT_TIMEOUT_MS without being admitted
 * - `leftWaiting`: we left the waiting room ourselves
 */
export type TurnedAwayReason = 'locked' | 'denied' | 'waitExpired' | 'leftWaiting'

export interface TurnedAwayScreenProps {
  reason: TurnedAwayReason
  /** The room's name, when known */
  roomName: string
  /** Back through the pre-join screen (a new attempt to join) */
  onRetry: () => void
  onHome: () => void
}

/**
 * Not let into the meeting (F2): what happened and what to do, 再試一次 and 回首頁. No rating
 * question: the person was never in the call (the after-leave screen, LeftScreen, has it).
 */
export function TurnedAwayScreen({ reason, roomName, onRetry, onHome }: TurnedAwayScreenProps) {
  const heading = {
    locked: text.lockedTitle,
    denied: text.deniedTitle,
    waitExpired: text.expiredTitle,
    leftWaiting: text.leftTitle,
  }[reason]
  const body = {
    locked: text.lockedBody,
    denied: text.deniedBody,
    waitExpired: text.expiredBody,
    leftWaiting: text.leftBody(roomName),
  }[reason]
  return (
    <Card aria-labelledby="turned-away-title">
      {reason === 'locked' ? (
        <Mark $warn>
          <LockIcon />
        </Mark>
      ) : reason === 'waitExpired' ? (
        <Mark $warn>
          <HourglassIcon />
        </Mark>
      ) : (
        <LogoMark size={40} />
      )}
      <h1 id="turned-away-title">{heading}</h1>
      <Body role={reason === 'leftWaiting' ? undefined : 'alert'}>{body}</Body>
      <Actions>
        <Button onClick={onRetry}>{text.retry}</Button>
        <Button variant="secondary" onClick={onHome}>
          {text.home}
        </Button>
      </Actions>
    </Card>
  )
}

const Card = styled.section`
  display: grid;
  justify-items: center;
  gap: ${space(4)};
  width: min(100% - ${space(8)}, 440px);
  padding: ${space(8)} ${space(6)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  text-align: center;

  h1 {
    margin: 0;
    font-size: 22px;
  }

  @media ${media.phone} {
    padding: ${space(6)} ${space(4)};
  }
`

const Mark = styled.span<{ $warn?: boolean }>`
  display: inline-grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: ${radius.pill};
  background: ${color.surface2};
  color: ${({ $warn }) => ($warn ? color.warn : color.primary)};

  svg {
    width: 28px;
    height: 28px;
  }
`

const Body = styled.p`
  margin: 0;
  color: ${color.muted};
  line-height: 1.6;
  overflow-wrap: anywhere;
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: ${space(3)};
`

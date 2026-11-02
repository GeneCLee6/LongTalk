import { useEffect, useState } from 'react'
import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, media, radius, size, space } from '../styles/tokens.ts'
import { formatElapsed } from '../room/elapsed.ts'
import { LinkIcon } from './icons.tsx'
import { usePhoneLayout } from './layoutContext.ts'

export interface TopBarProps {
  /** The room's name as shown (the default one until the host renames it) */
  title: string
  /** When the meeting started (the first member joined), epoch ms; null hides the clock */
  startedAt: number | null
  /** The connection's state, in words (members online, or reconnecting) */
  status: string
  /** The status is something to act on (reconnecting, lost): amber, bold */
  warn: boolean
  onCopyLink: () => void
  /** Leave the room: the button sits here on phones (e4-t07), in the toolbar elsewhere */
  onLeave?: () => void
  /** For tests: the clock */
  now?: () => number
}

/** The meeting's running time, ticking every second (only this re-renders) */
function Elapsed({ startedAt, now }: { startedAt: number; now: () => number }) {
  const [at, setAt] = useState(now)
  useEffect(() => {
    const timer = setInterval(() => setAt(now()), 1000)
    return () => clearInterval(timer)
  }, [now])
  return (
    <Time role="timer" aria-label={strings.topBar.elapsed}>
      {formatElapsed(at - startedAt)}
    </Time>
  )
}

/**
 * The room's top bar (e4-t06, DESIGN.md §4.3 / §5 TopBar): room name, the meeting's elapsed
 * time, copy link, and on the right the connection state (amber while reconnecting).
 *
 * On a phone (e4-t07, the mockup's phone): 離開 at the right end, out of the thumb's way; the
 * head count is on the participants button, so the status only shows when it is a warning
 * (screen readers still hear it).
 */
export function TopBar({
  title,
  startedAt,
  status,
  warn,
  onCopyLink,
  onLeave,
  now = Date.now,
}: TopBarProps) {
  const phone = usePhoneLayout() !== null
  return (
    <Bar aria-label={strings.topBar.label}>
      <Title title={title}>{title}</Title>
      {startedAt !== null && <Elapsed startedAt={startedAt} now={now} />}
      <Copy type="button" aria-label={strings.topBar.copyLink} onClick={onCopyLink}>
        <LinkIcon />
        <span aria-hidden="true">{strings.topBar.copyLink}</span>
      </Copy>
      <Status role="status" $warn={warn} $hidden={phone && !warn}>
        {status}
      </Status>
      {phone && onLeave && (
        <Leave type="button" $afterStatus={warn} onClick={onLeave}>
          {strings.toolbar.leave}
        </Leave>
      )}
    </Bar>
  )
}

const Bar = styled.header`
  display: flex;
  align-items: center;
  gap: ${space(3)};
  min-height: calc(44px + env(safe-area-inset-top));
  /* Below the status bar and clear of a sideways notch (viewport-fit=cover) */
  padding: env(safe-area-inset-top) max(${space(4)}, env(safe-area-inset-right)) 0
    max(${space(4)}, env(safe-area-inset-left));
  border-bottom: 1px solid ${color.line};
  background: ${color.surface};
  font-size: ${fontSize.nameplate};
  color: ${color.muted};

  @media ${media.phone} {
    gap: ${space(2)};
    padding-left: max(${space(2)}, env(safe-area-inset-left));
    padding-right: max(${space(2)}, env(safe-area-inset-right));
  }
`

const Title = styled.h1`
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: ${fontSize.small};
  font-weight: 700;
  color: ${color.fg};
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Time = styled.span`
  font-variant-numeric: tabular-nums;
  color: ${color.fg};
`

/** Icon and words on desktop, the icon alone (a 44 px target) on phones */
const Copy = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: ${space(1)};
  min-height: 32px;
  padding: 0 ${space(2)};
  border: none;
  border-radius: ${space(2)};
  background: transparent;
  color: ${color.primary};
  font: inherit;
  white-space: nowrap;
  cursor: pointer;

  svg {
    width: 16px;
    height: 16px;
    flex: none;
  }
  &:hover {
    background: ${color.hover};
  }

  @media ${media.phone} {
    min-width: ${size.toolbarButton};
    min-height: ${size.toolbarButton};
    padding: 0;

    svg {
      width: 20px;
      height: 20px;
    }
    span {
      display: none;
    }
  }
`

const Status = styled.p<{ $warn: boolean; $hidden: boolean }>`
  margin: 0 0 0 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${({ $warn }) => ($warn ? color.warn : color.muted)};
  font-weight: ${({ $warn }) => ($warn ? 600 : 400)};

  /* Heard, not seen (a live region must stay in the page to be announced) */
  ${({ $hidden }) =>
    $hidden &&
    `position: absolute;
    width: 1px;
    height: 1px;
    clip-path: inset(50%);`}
`

/** The mockup's red pill, at the right end (after the status when it shows) */
const Leave = styled.button<{ $afterStatus: boolean }>`
  flex: none;
  margin-left: ${({ $afterStatus }) => ($afterStatus ? space(1) : 'auto')};
  min-height: 36px;
  padding: 0 ${space(3)};
  border: none;
  border-radius: ${radius.pill};
  background: ${color.danger};
  color: ${color.onDanger};
  font: inherit;
  font-weight: 700;
  cursor: pointer;
`

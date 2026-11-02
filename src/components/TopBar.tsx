import { useEffect, useState } from 'react'
import styled from 'styled-components'
import { strings } from '../strings.ts'
import { breakpoint, color, fontSize, size, space } from '../styles/tokens.ts'
import { formatElapsed } from '../room/elapsed.ts'
import { LinkIcon } from './icons.tsx'

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
 */
export function TopBar({ title, startedAt, status, warn, onCopyLink, now = Date.now }: TopBarProps) {
  return (
    <Bar aria-label={strings.topBar.label}>
      <Title title={title}>{title}</Title>
      {startedAt !== null && <Elapsed startedAt={startedAt} now={now} />}
      <Copy type="button" aria-label={strings.topBar.copyLink} onClick={onCopyLink}>
        <LinkIcon />
        <span aria-hidden="true">{strings.topBar.copyLink}</span>
      </Copy>
      <Status role="status" $warn={warn}>
        {status}
      </Status>
    </Bar>
  )
}

const Bar = styled.header`
  display: flex;
  align-items: center;
  gap: ${space(3)};
  min-height: 44px;
  padding: 0 ${space(4)};
  border-bottom: 1px solid ${color.line};
  background: ${color.surface};
  font-size: ${fontSize.nameplate};
  color: ${color.muted};

  @media (max-width: ${breakpoint.phone}) {
    gap: ${space(2)};
    padding: 0 ${space(2)};
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

  @media (max-width: ${breakpoint.phone}) {
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

const Status = styled.p<{ $warn: boolean }>`
  margin: 0 0 0 auto;
  white-space: nowrap;
  color: ${({ $warn }) => ($warn ? color.warn : color.muted)};
  font-weight: ${({ $warn }) => ($warn ? 600 : 400)};
`

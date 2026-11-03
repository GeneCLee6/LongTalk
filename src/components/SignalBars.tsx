import styled from 'styled-components'
import type { SignalLevel } from '../../shared/protocol.ts'
import { strings } from '../strings.ts'
import { color } from '../styles/tokens.ts'

const FILLED: Record<SignalLevel, number> = { good: 3, fair: 2, poor: 1 }

/**
 * Three bars for a connection's level (e2-t13, DESIGN.md §5 Nameplate): all three green for
 * 好, two amber for 普通, one red for 差. Not colour alone: the number of bars says it too, and
 * the name (訊號好…) is the image's accessible name and tooltip.
 */
export function SignalBars({ level }: { level: SignalLevel }) {
  const label = strings.stats.signal[level]
  const filled = FILLED[level]
  return (
    <Bars role="img" aria-label={label} title={label} data-signal={level} $level={level}>
      {[1, 2, 3].map((bar) => (
        <Bar key={bar} $height={bar} $on={bar <= filled} />
      ))}
    </Bars>
  )
}

const tone = (level: SignalLevel) =>
  level === 'good' ? color.speaking : level === 'fair' ? color.warn : color.danger

const Bars = styled.span<{ $level: SignalLevel }>`
  display: inline-flex;
  flex: none;
  align-items: flex-end;
  gap: 2px;
  width: 14px;
  height: 12px;
  color: ${({ $level }) => tone($level)};
`

const Bar = styled.span<{ $height: number; $on: boolean }>`
  width: 3px;
  height: ${({ $height }) => $height * 4}px;
  border-radius: 1px;
  background: ${({ $on }) => ($on ? 'currentColor' : color.muted)};
  opacity: ${({ $on }) => ($on ? 1 : 0.45)};
`

import styled from 'styled-components'
import { color, radius } from '../styles/tokens.ts'

/** A horizontal level bar, 0–1; exposed as a meter so screen readers can read it */
export function LevelMeter({ level, label }: { level: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, level)) * 100)
  return (
    <Track
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <Bar style={{ width: `${percent}%` }} />
    </Track>
  )
}

const Track = styled.div`
  height: 6px;
  border-radius: ${radius.pill};
  background: ${color.surface2};
  overflow: hidden;
`

const Bar = styled.div`
  height: 100%;
  border-radius: inherit;
  background: ${color.speaking};
  transition: width 80ms linear;
`

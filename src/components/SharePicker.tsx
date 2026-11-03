import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'

export interface SharePickerProps {
  /** Everyone else who shares, in the order they started */
  shares: readonly { id: string; name: string }[]
  /** The one in the main area */
  main: string
  onPick: (id: string) => void
}

/**
 * Whose share is in the main area (H5, e3-t07, AC-3.5): one button per share, the one shown
 * pressed, over the main share's top right. Only when more than one other member shares; the
 * choice is this viewer's alone (RoomPage keeps it for the session).
 */
export function SharePicker({ shares, main, onPick }: SharePickerProps) {
  return (
    <Group role="group" aria-label={strings.screenShare.picker}>
      {shares.map((share) => (
        <Choice
          key={share.id}
          type="button"
          aria-pressed={share.id === main}
          onClick={() => onPick(share.id)}
        >
          {strings.screenShare.label(share.name)}
        </Choice>
      ))}
    </Group>
  )
}

const Group = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: ${space(1)};
  padding: ${space(1)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
`

const Choice = styled.button`
  min-height: 32px;
  max-width: 14em;
  padding: ${space(1)} ${space(3)};
  border: 0;
  border-radius: ${radius.pill};
  background: transparent;
  color: ${color.fg};
  font: inherit;
  font-size: ${fontSize.nameplate};
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }

  &[aria-pressed='true'] {
    background: ${color.primary};
    color: ${color.onPrimary};
  }
`

import styled from 'styled-components'
import { strings } from '../strings.ts'
import { annotation, color, fontSize, radius, space } from '../styles/tokens.ts'
import { WhiteboardIcon } from './icons.tsx'

/**
 * The whiteboard while something else has the main area (J3, e7-t06): one button that brings it
 * back, the way a strip share is. No canvas: the board's chunk loads only when it is looked at.
 */
export function BoardStripTile({ onShowMain }: { onShowMain: () => void }) {
  return (
    <Tile type="button" aria-label={strings.whiteboard.show} onClick={onShowMain}>
      <WhiteboardIcon />
      {strings.whiteboard.label}
    </Tile>
  )
}

const Tile = styled.button`
  display: grid;
  place-content: center;
  justify-items: center;
  gap: ${space(1)};
  width: 100%;
  height: 100%;
  padding: ${space(1)};
  border: 0;
  border-radius: ${radius.tile};
  background: ${annotation.boardPaper};
  color: ${annotation.colors.ink};
  font-size: ${fontSize.nameplate};
  font-weight: 700;
  cursor: pointer;

  svg {
    width: 28px;
    height: 28px;
  }
  &:hover {
    background: ${annotation.boardGrid};
  }
  &:focus-visible {
    outline-color: ${color.focus};
  }
`

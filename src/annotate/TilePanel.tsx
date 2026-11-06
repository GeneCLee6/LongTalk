import styled from 'styled-components'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'

// A small dialog over a share tile or the whiteboard: inside the tile, so it comes along into
// fullscreen (J3: ClearMarks; J4: ExportMarks). Fixed, so it is the size of the screen, not the tile.

export const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${layer.menu};
  display: grid;
  place-items: center;
  padding: ${space(4)};
  background: ${color.overlay};
  cursor: default;
`

export const Panel = styled.div`
  display: grid;
  gap: ${space(3)};
  width: min(100%, 360px);
  max-height: 100%;
  overflow-y: auto;
  padding: ${space(5)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  color: ${color.fg};
  box-shadow: 0 8px 24px ${color.shadow};

  h2 {
    margin: 0;
    font-size: ${fontSize.base};
  }
`

export const Choices = styled.div`
  display: grid;
  gap: ${space(2)};
`

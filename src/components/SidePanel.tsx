import { useId, type KeyboardEvent, type ReactNode } from 'react'
import styled from 'styled-components'
import { color, fontSize, radius, size, space } from '../styles/tokens.ts'
import { CloseIcon } from './icons.tsx'

export interface SidePanelProps {
  /** The heading, and the region's accessible name */
  title: string
  /** The close button's accessible name */
  closeLabel: string
  onClose: () => void
  children: ReactNode
}

/**
 * The room's right-hand panel on desktop (DESIGN.md §5 SidePanel, 320 px): chat from D3,
 * participants from F1. Not modal: the stage shrinks beside it and stays usable; Escape inside it
 * closes it. Phones get the full-screen Drawer instead.
 */
export function SidePanel({ title, closeLabel, onClose, children }: SidePanelProps) {
  const titleId = useId()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    onClose()
  }
  return (
    <Aside aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <Header>
        <h2 id={titleId}>{title}</h2>
        <Close type="button" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
          <CloseIcon />
        </Close>
      </Header>
      {children}
    </Aside>
  )
}

const Aside = styled.aside`
  display: flex;
  flex-direction: column;
  width: ${size.sidePanel};
  min-height: 0;
  border-left: 1px solid ${color.line};
  background: ${color.surface};
`

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  padding: ${space(2)} ${space(2)} ${space(2)} ${space(4)};
  border-bottom: 1px solid ${color.line};

  h2 {
    flex: 1;
    margin: 0;
    font-size: ${fontSize.base};
    font-weight: 700;
  }
`

const Close = styled.button`
  display: inline-grid;
  place-items: center;
  width: ${size.toolbarButton};
  height: ${size.toolbarButton};
  border: none;
  border-radius: ${radius.button};
  background: transparent;
  color: ${color.muted};
  cursor: pointer;

  svg {
    width: 20px;
    height: 20px;
  }
  &:hover {
    background: ${color.hover};
  }
`

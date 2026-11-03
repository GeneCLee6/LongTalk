import { useId, type KeyboardEvent, type ReactNode } from 'react'
import styled from 'styled-components'
import { color, fontSize, radius, size, space } from '../styles/tokens.ts'
import { CloseIcon } from './icons.tsx'
import { panelId, tabId } from './tabIds.ts'

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

export interface PanelTab {
  id: string
  label: string
}

export interface PanelTabsProps {
  /** The switch's accessible name */
  label: string
  tabs: readonly PanelTab[]
  selected: string
  onSelect: (id: string) => void
  /**
   * Ids for the tabs and their panels (`<prefix>-tab-<id>`, `<prefix>-panel-<id>`): with it each
   * tab names the panel it controls (the settings panel, H3); panelId() gives the panel's id
   */
  idPrefix?: string
}

/**
 * The switch at the top of the side panel and the phone drawer between what they show (F1: chat
 * and participants, the mockup's segmented control). Arrow keys move between the tabs, focus
 * following.
 */
export function PanelTabs({ label, tabs, selected, onSelect, idPrefix }: PanelTabsProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const at = tabs.findIndex((tab) => tab.id === selected)
    const index = (at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
    onSelect(tabs[index].id)
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus()
  }
  return (
    <Tabs role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          type="button"
          role="tab"
          id={idPrefix ? tabId(idPrefix, tab.id) : undefined}
          aria-controls={idPrefix ? panelId(idPrefix, tab.id) : undefined}
          aria-selected={tab.id === selected}
          tabIndex={tab.id === selected ? 0 : -1}
          $on={tab.id === selected}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </Tab>
      ))}
    </Tabs>
  )
}

const Tabs = styled.div`
  display: flex;
  gap: ${space(1)};
  padding: ${space(2)} ${space(3)};
  border-bottom: 1px solid ${color.line};
`

const Tab = styled.button<{ $on: boolean }>`
  flex: 1;
  padding: ${space(1.5)};
  border: none;
  border-radius: ${space(2)};
  background: ${({ $on }) => ($on ? color.surface2 : 'transparent')};
  color: ${({ $on }) => ($on ? color.fg : color.muted)};
  font-size: ${fontSize.small};
  font-weight: ${({ $on }) => ($on ? 700 : 400)};
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }
  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: -2px;
  }
`

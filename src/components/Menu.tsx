import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import styled, { css } from 'styled-components'
import { color, fontSize, layer, radius, size, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { Drawer } from './Drawer.tsx'
import { IconButton } from './IconButton.tsx'
import { usePhoneLayout } from './layoutContext.ts'

export interface MenuItem {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  tone?: 'neutral' | 'danger'
  /** A choice among several (device menus): a radio item, checked when it is the current one */
  checked?: boolean
  /** A heading shown before the first item of each section (e.g. 麥克風, 喇叭) */
  section?: string
}

export interface MenuProps {
  /** Trigger's accessible name (and its text when there is no icon) */
  label: string
  /** With an icon the trigger is an IconButton (toolbar "more"); without, a secondary Button */
  icon?: ReactNode
  items: MenuItem[]
  /** Open upwards (from the bottom toolbar) */
  placement?: 'below' | 'above'
  /** Line the list up with the trigger's left edge (start) or right edge (end) */
  align?: 'start' | 'end'
  /** The icon trigger shows its caption (the toolbar's 更多) */
  showLabel?: boolean
}

/**
 * Menu button (WAI-ARIA menu pattern): Enter, Space or Down opens and focuses the first item;
 * Up, Down, Home, End move; Escape closes and returns focus to the trigger; Tab or a click
 * outside closes. In the room on a phone (e4-t07) the list opens in a bottom sheet with
 * thumb-sized items instead of a popover; the keys work the same.
 */
export function Menu({
  label,
  icon,
  items,
  placement = 'below',
  align = 'start',
  showLabel = false,
}: MenuProps) {
  const sheet = usePhoneLayout() !== null
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = items.flatMap((item, index) => (item.disabled ? [] : [index]))

  useEffect(() => {
    if (open) itemRefs.current[focusIndex]?.focus()
  }, [open, focusIndex])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  const openAt = (index: number | undefined) => {
    if (index === undefined) return
    setFocusIndex(index)
    setOpen(true)
  }

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) rootRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus()
  }

  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openAt(enabled[0])
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(enabled.at(-1))
    }
  }

  const onMenuKey = (event: KeyboardEvent) => {
    const position = enabled.indexOf(focusIndex)
    const move = (to: number | undefined) => {
      event.preventDefault()
      if (to !== undefined) setFocusIndex(to)
    }
    if (event.key === 'ArrowDown') move(enabled[(position + 1) % enabled.length])
    else if (event.key === 'ArrowUp')
      move(enabled[(position - 1 + enabled.length) % enabled.length])
    else if (event.key === 'Home') move(enabled[0])
    else if (event.key === 'End') move(enabled.at(-1))
    else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') close(false)
  }

  const triggerProps = {
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => (open ? close(false) : openAt(enabled[0])),
    onKeyDown: onTriggerKey,
  }

  const list = (
    <List
      id={menuId}
      role="menu"
      aria-label={label}
      $placement={placement}
      $align={align}
      $sheet={sheet}
      onKeyDown={onMenuKey}
    >
      {items.map((item, index) => [
        item.section && item.section !== items[index - 1]?.section && (
          <Heading key={`section-${item.section}`} role="presentation">
            {item.section}
          </Heading>
        ),
        <Item
          key={item.id}
          ref={(el) => {
            itemRefs.current[index] = el
          }}
          type="button"
          role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked}
          tabIndex={index === focusIndex ? 0 : -1}
          disabled={item.disabled}
          $danger={item.tone === 'danger'}
          onClick={() => {
            close(true)
            item.onSelect()
          }}
        >
          <Check aria-hidden="true">{item.checked ? '✓' : ''}</Check>
          {item.label}
        </Item>,
      ])}
    </List>
  )

  return (
    <Root ref={rootRef}>
      {icon ? (
        <IconButton label={label} icon={icon} showLabel={showLabel} {...triggerProps} />
      ) : (
        <Button variant="secondary" {...triggerProps}>
          {label}
        </Button>
      )}
      {open &&
        (sheet ? (
          <Drawer title={label} onClose={() => close(true)}>
            {list}
          </Drawer>
        ) : (
          list
        ))}
    </Root>
  )
}

const Root = styled.div`
  position: relative;
  display: inline-block;
`

const List = styled.div<{
  $placement: 'below' | 'above'
  $align: 'start' | 'end'
  $sheet: boolean
}>`
  display: flex;
  flex-direction: column;

  ${({ $sheet, $placement, $align }) =>
    $sheet
      ? css`
          /* In a bottom sheet: the full width, items a thumb can hit (48 px) */
          button {
            min-height: ${size.toolbarButtonTouch};
            font-size: ${fontSize.base};
          }
        `
      : css`
          position: absolute;
          ${$placement === 'below' ? 'top' : 'bottom'}: calc(100% + ${space(1)});
          ${$align === 'start' ? 'left' : 'right'}: 0;
          z-index: ${layer.menu};
          min-width: 200px;
          padding: ${space(1)};
          background: ${color.surface};
          border: 1px solid ${color.line};
          border-radius: ${radius.button};
          box-shadow: 0 8px 24px ${color.shadow};
        `}
`

const Heading = styled.div`
  padding: ${space(2)} ${space(3)} ${space(1)};
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`

const Check = styled.span`
  display: inline-block;
  width: 1.25em;
`

const Item = styled.button<{ $danger: boolean }>`
  padding: ${space(2)} ${space(3)};
  border: none;
  border-radius: ${space(2)};
  background: transparent;
  color: ${({ $danger }) => ($danger ? color.danger : color.fg)};
  font-size: ${fontSize.small};
  text-align: left;
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    background: ${color.hover};
  }
  &:disabled {
    color: ${color.muted};
    cursor: not-allowed;
  }
`

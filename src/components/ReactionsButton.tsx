import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import styled, { css } from 'styled-components'
import { REACTIONS, type Reaction } from '../../shared/reactions.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, size, space } from '../styles/tokens.ts'
import { Drawer } from './Drawer.tsx'
import { HandIcon, SmileIcon } from './icons.tsx'
import { IconButton } from './IconButton.tsx'
import { usePhoneLayout } from './layoutContext.ts'

export interface ReactionsButtonProps {
  /** Our hand is up (RoomDO's `Member.hand`): the button shows the hand, the picker 放下手 */
  handUp: boolean
  onReact: (emoji: Reaction) => void
  onToggleHand: () => void
  /** The raise-hand key (G4, e4-t13), shown on 舉手 / 放下手 */
  handShortcut?: string
}

/**
 * The toolbar's 反應 (G3, e5-t03, e5-t04; DESIGN.md §4.3): opens a small panel with the six
 * reactions in a row and 舉手 / 放下手 under them. On a desktop the panel stays open after a
 * reaction (a burst of 👏 is common) and closes with Escape, a click outside or the button; on a
 * phone it is a bottom sheet that closes after each choice, so the stage is visible again for
 * the float. While our hand is up the button shows the hand, in amber.
 */
export function ReactionsButton({
  handUp,
  onReact,
  onToggleHand,
  handShortcut,
}: ReactionsButtonProps) {
  const sheet = usePhoneLayout() !== null
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open && !sheet) first.current?.focus()
  }, [open, sheet])

  useEffect(() => {
    if (!open || sheet) return
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open, sheet])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    // Left and right move along the row of reactions
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const buttons = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('[data-reaction]') ?? []),
    ]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : -1
    buttons[(at + step + buttons.length) % buttons.length]?.focus()
  }

  const panel = (
    <Panel
      id={panelId}
      // On a desktop a non-modal popover; in the phone's sheet the Drawer is the dialog
      role={sheet ? 'group' : 'dialog'}
      aria-label={strings.reactions.picker}
      $sheet={sheet}
      onKeyDown={sheet ? undefined : onKeyDown}
    >
      <Row>
        {REACTIONS.map((emoji, index) => (
          <Emoji
            key={emoji}
            ref={index === 0 ? first : undefined}
            type="button"
            data-reaction
            aria-label={strings.reactions.send(strings.reactions.names[emoji])}
            title={strings.reactions.names[emoji]}
            $sheet={sheet}
            onClick={() => {
              onReact(emoji)
              if (sheet) setOpen(false)
            }}
          >
            {emoji}
          </Emoji>
        ))}
      </Row>
      <Hand
        type="button"
        aria-pressed={handUp}
        aria-keyshortcuts={handShortcut}
        title={
          handShortcut
            ? strings.shortcuts.tooltip(
                handUp ? strings.reactions.lower : strings.reactions.raise,
                handShortcut,
              )
            : undefined
        }
        $up={handUp}
        $sheet={sheet}
        onClick={() => {
          onToggleHand()
          close(!sheet)
        }}
      >
        <HandIcon />
        {handUp ? strings.reactions.lower : strings.reactions.raise}
      </Hand>
    </Panel>
  )

  return (
    <Root ref={root}>
      <Trigger $up={handUp}>
        <IconButton
          label={handUp ? strings.reactions.buttonHandUp : strings.reactions.button}
          caption={strings.reactions.button}
          icon={handUp ? <HandIcon /> : <SmileIcon />}
          showLabel
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? close(false) : setOpen(true))}
        />
      </Trigger>
      {open &&
        (sheet ? (
          <Drawer title={strings.reactions.picker} onClose={() => setOpen(false)}>
            {panel}
          </Drawer>
        ) : (
          panel
        ))}
    </Root>
  )
}

const Root = styled.div`
  position: relative;
  display: inline-block;
`

/** While our hand is up, the button's icon is the hand, in amber */
const Trigger = styled.span<{ $up: boolean }>`
  display: inline-flex;

  ${({ $up }) =>
    $up &&
    css`
      svg {
        color: ${color.warn};
      }
    `}
`

const Panel = styled.div<{ $sheet: boolean }>`
  display: grid;
  gap: ${space(2)};

  ${({ $sheet }) =>
    $sheet
      ? css`
          padding: ${space(1)} 0;
        `
      : css`
          position: absolute;
          bottom: calc(100% + ${space(1)});
          left: 50%;
          transform: translateX(-50%);
          z-index: ${layer.menu};
          padding: ${space(2)};
          background: ${color.surface};
          border: 1px solid ${color.line};
          border-radius: ${radius.panel};
          box-shadow: 0 8px 24px ${color.shadow};
        `}
`

const Row = styled.div`
  display: flex;
  justify-content: space-between;
  gap: ${space(1)};
`

const Emoji = styled.button<{ $sheet: boolean }>`
  display: inline-grid;
  place-items: center;
  width: ${({ $sheet }) => ($sheet ? size.toolbarButtonTouch : size.toolbarButton)};
  height: ${({ $sheet }) => ($sheet ? size.toolbarButtonTouch : size.toolbarButton)};
  padding: 0;
  border: none;
  border-radius: ${radius.button};
  background: transparent;
  font-size: 26px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }
  &:active {
    background: ${color.pressed};
  }
  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 1px;
  }
`

const Hand = styled.button<{ $up: boolean; $sheet: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: ${space(2)};
  min-height: ${({ $sheet }) => ($sheet ? size.toolbarButtonTouch : size.toolbarButton)};
  padding: 0 ${space(3)};
  border: none;
  border-radius: ${radius.button};
  background: ${({ $up }) => ($up ? color.warn : color.surface2)};
  color: ${({ $up }) => ($up ? color.onWarn : color.fg)};
  font: inherit;
  font-size: ${fontSize.small};
  font-weight: 600;
  cursor: pointer;

  svg {
    width: 18px;
    height: 18px;
  }
  &:hover {
    box-shadow: inset 0 0 0 999px ${color.hover};
  }
  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 1px;
  }
`

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import styled, { css, keyframes } from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, layer, motion, radius, size, space } from '../styles/tokens.ts'
import { CloseIcon } from './icons.tsx'

export type DrawerVariant = 'sheet' | 'full'

export interface DrawerProps {
  /** The heading, and the dialog's accessible name */
  title: string
  onClose: () => void
  children: ReactNode
  /**
   * sheet: slides up from the bottom, as tall as its content (menus on phones); full: covers the
   * whole screen (chat and participants on phones, D3 / F1)
   */
  variant?: DrawerVariant
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * A modal panel for phones (e4-t07, DESIGN.md §5 SidePanel): a bottom sheet or a full-screen
 * drawer, with a heading and a close button. Escape, the close button or a tap on the backdrop
 * closes it; Tab stays inside; focus goes back where it was. Its bottom clears the home
 * indicator (safe-area insets). The slide-in follows prefers-reduced-motion (GlobalStyle).
 */
export function Drawer({ title, onClose, children, variant = 'sheet' }: DrawerProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    // Whatever inside asked for focus first (a menu's first item) keeps it
    if (!panel.current?.contains(document.activeElement)) {
      const first = panel.current?.querySelector<HTMLElement>(`[data-drawer-body] ${FOCUSABLE}`)
      ;(first ?? panel.current)?.focus()
    }
    return () => {
      if (before?.isConnected) before.focus?.()
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent) => {
    // A menu inside handles its own Escape (and returns focus to its trigger)
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Tab' && panel.current) {
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <Backdrop
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <Panel
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        $variant={variant}
        onKeyDown={onKeyDown}
      >
        {variant === 'sheet' && <Handle aria-hidden="true" />}
        <Header>
          <h2 id={titleId}>{title}</h2>
          <Close type="button" aria-label={strings.common.close} onClick={onClose}>
            <CloseIcon />
          </Close>
        </Header>
        <Body data-drawer-body="">{children}</Body>
      </Panel>
    </Backdrop>
  )
}

const slideUp = keyframes`
  from { transform: translateY(100%); }
  to { transform: none; }
`

const fade = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${layer.drawer};
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  background: ${color.overlay};
  animation: ${fade} ${motion.base} ease-out;
`

const Panel = styled.div<{ $variant: DrawerVariant }>`
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: ${color.surface};
  color: ${color.fg};
  animation: ${slideUp} ${motion.base} ease-out;
  outline: none;
  /* Clear the notch and the home indicator */
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
  padding-bottom: env(safe-area-inset-bottom);

  ${({ $variant }) =>
    $variant === 'sheet'
      ? css`
          max-height: 85dvh;
          border-radius: ${radius.panel} ${radius.panel} 0 0;
          box-shadow: 0 -8px 24px ${color.shadow};
        `
      : css`
          height: 100%;
          padding-top: env(safe-area-inset-top);
        `}
`

const Handle = styled.span`
  align-self: center;
  width: 36px;
  height: 4px;
  margin-top: ${space(2)};
  border-radius: ${radius.pill};
  background: ${color.line};
`

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  padding: ${space(2)} ${space(2)} ${space(1)} ${space(4)};

  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: ${fontSize.base};
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

const Close = styled.button`
  display: inline-grid;
  place-items: center;
  width: ${size.toolbarButtonTouch};
  height: ${size.toolbarButtonTouch};
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

const Body = styled.div`
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 ${space(2)} ${space(3)};
`

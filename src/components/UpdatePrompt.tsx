import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import styled from 'styled-components'
import { updates, useUpdateState } from '../pwa/pwa.ts'
import type { UpdateState } from '../pwa/update.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, media, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { RefreshIcon } from './icons.tsx'

export interface UpdateCardProps {
  state: UpdateState
  /** In a meeting: the text says a reload goes straight back in */
  inRoom: boolean
  onReload: () => void
  onLater: () => void
}

/**
 * 「有新版本，重新整理」 (G4, e4-t12, AC-4.7): a small card in the bottom-left corner, never a
 * modal, never a reload by itself. 稍後 hides it; the next change of page takes the new version.
 */
export function UpdateCard({ state, inRoom, onReload, onLater }: UpdateCardProps) {
  if (state !== 'available' && state !== 'applying') return null
  return (
    <Card
      role="status"
      aria-label={strings.pwa.updateLabel}
      $room={inRoom}
      // The room is dark whatever the system scheme (DESIGN.md §1.2): so is its card
      data-theme={inRoom ? 'dark' : undefined}
    >
      <RefreshIcon />
      <p>{inRoom ? strings.pwa.updateRoom : strings.pwa.update}</p>
      <Actions>
        <Button variant="ghost" onClick={onLater} disabled={state === 'applying'}>
          {strings.pwa.updateLater}
        </Button>
        <Button onClick={onReload} disabled={state === 'applying'}>
          {strings.pwa.updateReload}
        </Button>
      </Actions>
    </Card>
  )
}

/** The app's update prompt (App.tsx): follows update.ts, and applies a dismissed update on the
 * next change of page */
export function UpdatePrompt() {
  const state = useUpdateState()
  const { pathname } = useLocation()
  const last = useRef(pathname)
  useEffect(() => {
    if (last.current === pathname) return
    last.current = pathname
    updates.navigated()
  }, [pathname])
  return (
    <UpdateCard
      state={state}
      inRoom={pathname.startsWith('/r/')}
      onReload={() => updates.apply()}
      onLater={() => updates.dismiss()}
    />
  )
}

const Card = styled.section<{ $room: boolean }>`
  position: fixed;
  left: max(${space(4)}, env(safe-area-inset-left));
  /* In the room, above the toolbar */
  bottom: calc(${({ $room }) => ($room ? space(24) : space(4))} + env(safe-area-inset-bottom));
  z-index: ${layer.toast};
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(2)} ${space(3)};
  max-width: min(480px, calc(100vw - ${space(8)}));
  padding: ${space(3)} ${space(4)};
  border: 1px solid ${color.line};
  border-left: 4px solid ${color.primary};
  border-radius: ${radius.button};
  background: ${color.surface};
  color: ${color.fg};
  box-shadow: 0 8px 24px ${color.shadow};
  font-size: ${fontSize.small};

  > svg {
    flex: none;
    width: 20px;
    height: 20px;
    color: ${color.primary};
  }
  p {
    flex: 1 1 200px;
    margin: 0;
    line-height: 1.5;
  }

  @media ${media.phone} {
    left: max(${space(2)}, env(safe-area-inset-left));
    right: max(${space(2)}, env(safe-area-inset-right));
    max-width: none;
    bottom: calc(${({ $room }) => ($room ? space(18) : space(2))} + env(safe-area-inset-bottom));
  }
`

const Actions = styled.div`
  display: flex;
  margin-left: auto;
  gap: ${space(2)};
`

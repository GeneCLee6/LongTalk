import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'

export interface ConfirmDialogProps {
  title: string
  body: string
  /** The yes button's text (the question's verb: 接手分享) */
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A small modal yes / no question (D1: take over the share?). The yes button has focus; Escape or
 * a click outside is no; focus goes back where it was when it closes. The yes click is a user
 * gesture, so it may open the browser's screen picker.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId()
  const bodyId = useId()
  // Where focus was before the yes button took it (autoFocus runs before effects)
  const [before] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => before?.focus?.(), [before])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onCancel()}>
      <Panel
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        <Actions>
          <Button variant="secondary" onClick={onCancel}>
            {strings.common.cancel}
          </Button>
          <Button autoFocus onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </Actions>
      </Panel>
    </Backdrop>
  )
}

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${layer.menu};
  display: grid;
  place-items: center;
  padding: ${space(4)};
  background: ${color.overlay};
`

const Panel = styled.div`
  display: grid;
  gap: ${space(3)};
  width: min(100%, 420px);
  padding: ${space(5)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  color: ${color.fg};
  box-shadow: 0 8px 24px ${color.shadow};

  h2 {
    margin: 0;
    font-size: 18px;
  }
  p {
    margin: 0;
    color: ${color.muted};
    font-size: ${fontSize.small};
    line-height: 1.6;
  }
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: ${space(2)};
`

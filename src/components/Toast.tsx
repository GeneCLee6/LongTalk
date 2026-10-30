import styled, { keyframes } from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, layer, motion, radius, space } from '../styles/tokens.ts'
import type { ToastMessage, ToastTone } from './useToasts.ts'

export interface ToastViewportProps {
  toasts: ToastMessage[]
  onDismiss: (id: number) => void
}

/** Top-right stack in a polite live region, so screen readers announce each toast */
export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  return (
    <Region aria-label={strings.toast.region}>
      <Stack role="status" aria-live="polite">
        {toasts.map((toast) => (
          <Card key={toast.id} $tone={toast.tone}>
            <span>{toast.text}</span>
            <Close
              type="button"
              aria-label={strings.common.close}
              onClick={() => onDismiss(toast.id)}
            >
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </Close>
          </Card>
        ))}
      </Stack>
    </Region>
  )
}

const toneColor = { neutral: color.primary, warn: color.warn, danger: color.danger }

const enter = keyframes`
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
`

const Region = styled.section`
  position: fixed;
  top: ${space(4)};
  right: ${space(4)};
  z-index: ${layer.toast};
  pointer-events: none;
`

const Stack = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${space(2)};
`

const Card = styled.div<{ $tone: ToastTone }>`
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: ${space(3)};
  max-width: 360px;
  padding: ${space(3)} ${space(4)};
  background: ${color.surface};
  color: ${color.fg};
  border: 1px solid ${color.line};
  border-left: 4px solid ${({ $tone }) => toneColor[$tone]};
  border-radius: ${radius.button};
  box-shadow: 0 8px 24px ${color.shadow};
  font-size: ${fontSize.small};
  animation: ${enter} ${motion.base} ease-out;
`

const Close = styled.button`
  display: inline-flex;
  margin-left: auto;
  padding: ${space(1)};
  border: none;
  background: transparent;
  color: ${color.muted};
  cursor: pointer;
`

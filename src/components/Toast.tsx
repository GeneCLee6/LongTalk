import styled, { keyframes } from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, layer, media, motion, radius, space } from '../styles/tokens.ts'
import { AlertIcon, InfoIcon } from './icons.tsx'
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
            {/* The tone is the icon's shape too, not only the colour (G5, e4-t14) */}
            <ToneIcon $tone={toast.tone}>
              {toast.tone === 'neutral' ? <InfoIcon /> : <AlertIcon />}
            </ToneIcon>
            <span>{toast.text}</span>
            {toast.actions?.map((action) => (
              <Action
                key={action.label}
                type="button"
                onClick={() => {
                  onDismiss(toast.id)
                  action.onClick()
                }}
              >
                {action.label}
              </Action>
            ))}
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
  /* Below the room's top bar (44 px), so the status there stays readable */
  top: calc(${space(14)} + env(safe-area-inset-top));
  right: max(${space(4)}, env(safe-area-inset-right));
  z-index: ${layer.toast};
  pointer-events: none;

  /* Phones (e4-t07): across the top, inside the screen's edges */
  @media ${media.phone} {
    left: max(${space(2)}, env(safe-area-inset-left));
    right: max(${space(2)}, env(safe-area-inset-right));
  }
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

const ToneIcon = styled.span<{ $tone: ToastTone }>`
  display: inline-flex;
  flex: none;
  width: 18px;
  height: 18px;
  color: ${({ $tone }) => toneColor[$tone]};

  svg {
    width: 100%;
    height: 100%;
  }
`

/** A toast's own button (ToastAction): a text button in the brand colour, before the close */
const Action = styled.button`
  flex: none;
  min-height: 32px;
  padding: ${space(1)} ${space(2)};
  border: 1px solid ${color.primary};
  border-radius: ${radius.button};
  background: transparent;
  color: ${color.primary};
  font: inherit;
  font-weight: 600;
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }
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

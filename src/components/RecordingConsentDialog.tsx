import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { RecordIcon } from './icons.tsx'

export interface RecordingConsentDialogProps {
  /** Who records, as one phrase (strings.record.who) */
  who: string
  onAgree: () => void
  onLeave: () => void
}

/**
 * The recording question (I4, CLAUDE.md rule 4 「明確同意」): someone records the meeting and we
 * have not agreed. Modal and blocking: the rest of the room is inert behind it (the page sets
 * `inert`), focus stays in it (Tab cycles between the two buttons; Escape does nothing, there is
 * no "later"), and screen readers hear it as an alert dialog. 同意並留在會議 asks RoomDO, which
 * keeps the agreement (`consent`); 離開會議 leaves. No answer in CONSENT_TIMEOUT_MS: the room
 * treats it as no.
 */
export function RecordingConsentDialog({ who, onAgree, onLeave }: RecordingConsentDialogProps) {
  const titleId = useId()
  const bodyId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const agree = useRef<HTMLButtonElement>(null)
  const [sent, setSent] = useState(false)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    agree.current?.focus()
    return () => before?.focus?.()
  }, [])
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key !== 'Tab') return
    const buttons = [...(panel.current?.querySelectorAll('button') ?? [])].filter(
      (button) => !button.disabled,
    )
    if (buttons.length === 0) return
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  return (
    <Backdrop>
      <Panel
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
      >
        <Head>
          <RecordIcon />
          <h2 id={titleId}>{strings.record.consentTitle}</h2>
        </Head>
        <p id={bodyId}>{strings.record.consentBody(who)}</p>
        {sent && <p role="status">{strings.record.consentSent}</p>}
        <Actions>
          <Button variant="secondary" onClick={onLeave}>
            {strings.record.consentLeave}
          </Button>
          <Button
            ref={agree}
            disabled={sent}
            onClick={() => {
              setSent(true)
              onAgree()
            }}
          >
            {strings.record.consentAgree}
          </Button>
        </Actions>
      </Panel>
    </Backdrop>
  )
}

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${layer.toast + 1};
  display: grid;
  place-items: center;
  padding: ${space(4)};
  background: ${color.overlay};
`

const Panel = styled.div`
  display: grid;
  gap: ${space(3)};
  width: min(100%, 440px);
  padding: ${space(5)};
  border: 1px solid ${color.danger};
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

const Head = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(2)};

  svg {
    width: 22px;
    height: 22px;
    color: ${color.danger};
  }
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: ${space(2)};
`

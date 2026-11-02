import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import { normalizeName } from '../../shared/protocol.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { TextInput } from './Field.tsx'

export interface NameDialogProps {
  title: string
  label: string
  initial: string
  /** Longest name allowed, in characters (MAX_NAME_CHARS or MAX_ROOM_NAME_CHARS) */
  maxChars: number
  /** Called with the normalized name */
  onSave: (name: string) => void
  onCancel: () => void
}

/**
 * A small modal asking for one name (e1-t05: rename the room, change my name). Escape or a click
 * outside cancels; focus goes back where it was when it closes.
 */
export function NameDialog({ title, label, initial, maxChars, onSave, onCancel }: NameDialogProps) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const inputId = useId()
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    input.current?.select()
    return () => before?.focus?.()
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const name = normalizeName(value, maxChars)
    if (name === null) {
      setError(value.trim() === '' ? strings.rename.empty : strings.rename.tooLong(maxChars))
      return
    }
    onSave(name)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onCancel()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <form onSubmit={submit} noValidate>
          <h2 id={titleId}>{title}</h2>
          <Label htmlFor={inputId}>{label}</Label>
          <TextInput
            ref={input}
            id={inputId}
            value={value}
            autoFocus
            autoComplete="off"
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
          />
          {error && (
            <ErrorText id={errorId} role="alert">
              {error}
            </ErrorText>
          )}
          <Actions>
            <Button variant="secondary" onClick={onCancel}>
              {strings.common.cancel}
            </Button>
            <Button type="submit">{strings.rename.save}</Button>
          </Actions>
        </form>
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
  width: min(100%, 400px);
  padding: ${space(5)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  color: ${color.fg};
  box-shadow: 0 8px 24px ${color.shadow};

  form {
    display: grid;
    gap: ${space(3)};
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
`

const Label = styled.label`
  font-size: ${fontSize.small};
  color: ${color.muted};
`

const ErrorText = styled.p`
  margin: 0;
  color: ${color.danger};
  font-size: ${fontSize.small};
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: ${space(2)};
`

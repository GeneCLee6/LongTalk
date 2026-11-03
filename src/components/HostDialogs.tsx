import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import { MAX_PASSWORD_CHARS, normalizePassword } from '../../shared/password.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { Select, TextInput } from './Field.tsx'

export interface PasswordDialogProps {
  /** The room has a password now */
  hasPassword: boolean
  /** The current password, when this browser knows it (it was set or typed here) */
  current: string | null
  /** Called with the normalized password */
  onSave: (password: string) => void
  onClear: () => void
  onCancel: () => void
}

/** Escape cancels; focus goes back where it was when the dialog closes */
function useDialog(onCancel: () => void) {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    return () => before?.focus?.()
  }, [])
  return (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    }
  }
}

/**
 * The host sets, changes or clears the room's password (F3, e1-t15). The field shows what is
 * typed (it is the host's own code, to read out to others); RoomDO checks it again and keeps
 * only a digest.
 */
export function PasswordDialog({
  hasPassword,
  current,
  onSave,
  onClear,
  onCancel,
}: PasswordDialogProps) {
  const text = strings.password
  const [value, setValue] = useState(current ?? '')
  const [invalid, setInvalid] = useState(false)
  const titleId = useId()
  const inputId = useId()
  const hintId = useId()
  const input = useRef<HTMLInputElement>(null)
  const onKeyDown = useDialog(onCancel)
  useEffect(() => input.current?.select(), [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const password = normalizePassword(value)
    if (password === null) setInvalid(true)
    else onSave(password)
  }

  return (
    <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onCancel()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <form onSubmit={submit} noValidate>
          <h2 id={titleId}>{hasPassword ? text.changeTitle : text.setTitle}</h2>
          <Label htmlFor={inputId}>{text.label}</Label>
          <TextInput
            ref={input}
            id={inputId}
            value={value}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            // Room for full-width input, folded on save
            maxLength={MAX_PASSWORD_CHARS * 2}
            aria-invalid={invalid}
            aria-describedby={hintId}
            onChange={(event) => {
              setValue(event.target.value)
              setInvalid(false)
            }}
          />
          <Hint id={hintId} role={invalid ? 'alert' : undefined} $error={invalid}>
            {invalid ? text.invalid : text.hint}
          </Hint>
          <Actions>
            {hasPassword && (
              <Button variant="secondary" onClick={onClear}>
                {text.clear}
              </Button>
            )}
            <Spacer />
            <Button variant="secondary" onClick={onCancel}>
              {strings.common.cancel}
            </Button>
            <Button type="submit">{text.save}</Button>
          </Actions>
        </form>
      </Panel>
    </Backdrop>
  )
}

export interface LeaveDialogProps {
  /** Who could take over the host role: connected members in the meeting but us, in order */
  candidates: { id: string; name: string }[]
  /** Who the room would choose by itself (the first candidate by its rule) */
  automatic: string
  /** Leave, handing the host role to `hostId` */
  onLeave: (hostId: string) => void
  onEnd: () => void
  onCancel: () => void
}

/**
 * A host pressing 「離開」 (F3, e1-t17): only I leave (and who takes over: the room's own choice
 * first, or anyone else connected), or end the meeting for everyone.
 */
export function LeaveDialog({ candidates, automatic, onLeave, onEnd, onCancel }: LeaveDialogProps) {
  const text = strings.leave
  const [next, setNext] = useState(automatic)
  const titleId = useId()
  const bodyId = useId()
  const selectId = useId()
  const onKeyDown = useDialog(onCancel)
  const ordered = [
    ...candidates.filter((member) => member.id === automatic),
    ...candidates.filter((member) => member.id !== automatic),
  ]
  return (
    <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onCancel()}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onLeave(next)
          }}
        >
          <h2 id={titleId}>{text.title}</h2>
          <Body id={bodyId}>{text.body}</Body>
          <Label htmlFor={selectId}>{text.nextHost}</Label>
          <Select id={selectId} value={next} onChange={(event) => setNext(event.target.value)}>
            {ordered.map((member) => (
              <option key={member.id} value={member.id}>
                {member.id === automatic ? text.nextHostAuto(member.name) : member.name}
              </option>
            ))}
          </Select>
          <Choices>
            <Button type="submit" block autoFocus>
              {text.justMe}
            </Button>
            <Button variant="danger" block onClick={onEnd}>
              {text.endForAll}
            </Button>
            <Button variant="secondary" block onClick={onCancel}>
              {strings.common.cancel}
            </Button>
          </Choices>
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
  width: min(100%, 420px);
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

const Body = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.small};
  line-height: 1.6;
`

const Label = styled.label`
  font-size: ${fontSize.small};
  color: ${color.muted};
`

const Hint = styled.p<{ $error: boolean }>`
  margin: 0;
  color: ${({ $error }) => ($error ? color.danger : color.muted)};
  font-size: ${fontSize.small};
  line-height: 1.6;
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${space(2)};
`

const Spacer = styled.span`
  flex: 1;
`

const Choices = styled.div`
  display: grid;
  gap: ${space(2)};
  margin-top: ${space(1)};
`

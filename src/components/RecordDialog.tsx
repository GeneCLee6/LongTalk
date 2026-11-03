import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import { containerType, type RecordingSettings, type Resolution } from '../record/format.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'

export interface RecordDialogProps {
  /** What was chosen last time */
  initial: RecordingSettings
  /** The format this browser will write, per choice (format.ts pickMimeType); for the hint */
  formats: { video: string | null; audio: string | null }
  onStart: (settings: RecordingSettings) => void
  onCancel: () => void
}

/**
 * 錄影設定 before 開始錄影 (I4, e8-t03): picture and sound or sound only, 720p or 1080p, our own
 * camera or not; says that everyone will see it and where the file goes (CLAUDE.md rule 4).
 * Escape or a click outside cancels; focus goes back where it was.
 */
export default function RecordDialog({ initial, formats, onStart, onCancel }: RecordDialogProps) {
  const text = strings.record
  const [settings, setSettings] = useState(initial)
  const titleId = useId()
  const bodyId = useId()
  const contentName = useId()
  const resolutionName = useId()
  const selfHint = useId()
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    return () => before?.focus?.()
  }, [])
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    }
  }
  const update = (changes: Partial<RecordingSettings>) =>
    setSettings((current) => ({ ...current, ...changes }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onStart(settings)
  }
  const format = settings.audioOnly ? formats.audio : formats.video
  const resolutions: { value: Resolution; label: string }[] = [
    { value: '720p', label: text.resolution720 },
    { value: '1080p', label: text.resolution1080 },
  ]

  return (
    <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onCancel()}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
        onSubmit={submit}
      >
        <h2 id={titleId}>{text.dialogTitle}</h2>
        <p id={bodyId}>{text.dialogBody}</p>
        <Group>
          <legend>{text.content}</legend>
          <Choice>
            <input
              type="radio"
              name={contentName}
              checked={!settings.audioOnly}
              onChange={() => update({ audioOnly: false })}
            />
            {text.videoAndAudio}
          </Choice>
          <Choice>
            <input
              type="radio"
              name={contentName}
              checked={settings.audioOnly}
              disabled={formats.audio === null}
              onChange={() => update({ audioOnly: true })}
            />
            {text.audioOnly}
          </Choice>
        </Group>
        <Group disabled={settings.audioOnly}>
          <legend>{text.resolution}</legend>
          {resolutions.map(({ value, label }) => (
            <Choice key={value}>
              <input
                type="radio"
                name={resolutionName}
                checked={settings.resolution === value}
                onChange={() => update({ resolution: value })}
              />
              {label}
            </Choice>
          ))}
        </Group>
        <div>
          <Choice $disabled={settings.audioOnly}>
            <input
              type="checkbox"
              checked={settings.includeSelf}
              disabled={settings.audioOnly}
              aria-describedby={selfHint}
              onChange={() => update({ includeSelf: !settings.includeSelf })}
            />
            {text.includeSelf}
          </Choice>
          <Hint id={selfHint}>{text.includeSelfHint}</Hint>
        </div>
        {format && <Hint>{text.format(containerType(format))}</Hint>}
        <Actions>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {strings.common.cancel}
          </Button>
          <Button type="submit" autoFocus>
            {text.confirm}
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

const Panel = styled.form`
  display: grid;
  gap: ${space(3)};
  width: min(100%, 440px);
  max-height: 100%;
  overflow: auto;
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

const Group = styled.fieldset`
  display: grid;
  gap: ${space(1)};
  margin: 0;
  padding: 0;
  border: none;

  legend {
    margin-bottom: ${space(1)};
    padding: 0;
    font-weight: 700;
    font-size: ${fontSize.small};
  }
  &:disabled {
    opacity: 0.55;
  }
`

const Choice = styled.label<{ $disabled?: boolean }>`
  display: flex;
  align-items: flex-start;
  gap: ${space(2)};
  min-height: 32px;
  font-size: ${fontSize.small};
  opacity: ${({ $disabled }) => ($disabled ? 0.55 : 1)};
  cursor: pointer;

  input {
    margin: 3px 0 0;
    accent-color: ${color.primary};
  }
`

const Hint = styled.small`
  display: block;
  color: ${color.muted};
  font-size: ${fontSize.nameplate};
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: ${space(2)};
`

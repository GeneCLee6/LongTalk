import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import styled from 'styled-components'
import type { AudioProcessing, ProcessingKey } from '../media/audioProcessing.ts'
import type { DeviceLists } from '../media/devices.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { DeviceSelect, type DeviceChoice } from './DeviceSelect.tsx'
import { Drawer } from './Drawer.tsx'
import { PanelTabs } from './SidePanel.tsx'
import { panelId, tabId } from './tabIds.ts'

export type SettingsTab = 'audio' | 'video' | 'performance'

const TABS: readonly SettingsTab[] = ['audio', 'video', 'performance']

export interface SettingsDialogProps {
  /** A phone: a full-screen drawer instead of the dialog */
  phone: boolean
  onClose: () => void
  initialTab?: SettingsTab
  devices: DeviceLists
  /** The device in use (or chosen) per picker */
  selected: Record<DeviceChoice, string | null>
  onSelect: (choice: DeviceChoice, deviceId: string) => void
  speakerSupported: boolean
  /** The microphone's processing switches (e6-t01) */
  processing: AudioProcessing
  /** The switches this browser knows (capabilities.ts audioProcessingSupport): only these show */
  processingSupported: readonly ProcessingKey[]
  onProcessing: (processing: AudioProcessing) => void
  /** HD (e6-t04): on, and whether the uplink holds it back now */
  hd: boolean
  hdLimited?: boolean
  onHd: (on: boolean) => void
  /** 純音訊模式 (e6-t04) */
  audioOnly: boolean
  onAudioOnly: (on: boolean) => void
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * 設定 (H3, e6-t01): three tabs, 音訊 (devices and the microphone's processing), 視訊 (camera
 * and HD) and 效能 (純音訊模式; H4 adds 省電模式 and the advanced noise suppression). A modal
 * dialog on a computer (Escape, the close button or a click outside closes it, Tab stays inside,
 * focus goes back), the full-screen drawer on a phone. Every change applies at once: there is no
 * save button.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'audio')
  const prefix = useId()
  const labels: Record<SettingsTab, string> = {
    audio: strings.settings.audio,
    video: strings.settings.video,
    performance: strings.settings.performance,
  }
  const body = (
    <>
      <PanelTabs
        label={strings.settings.tabs}
        tabs={TABS.map((id) => ({ id, label: labels[id] }))}
        selected={tab}
        onSelect={(id) => setTab(id as SettingsTab)}
        idPrefix={prefix}
      />
      {TABS.map((id) => (
        <TabPanel
          key={id}
          role="tabpanel"
          id={panelId(prefix, id)}
          aria-labelledby={tabId(prefix, id)}
          hidden={id !== tab}
        >
          {id === 'audio' && <AudioTab {...props} />}
          {id === 'video' && <VideoTab {...props} />}
          {id === 'performance' && <PerformanceTab {...props} />}
        </TabPanel>
      ))}
    </>
  )
  if (props.phone) {
    return (
      <Drawer variant="full" title={strings.settings.title} onClose={props.onClose}>
        {body}
      </Drawer>
    )
  }
  return <Dialog onClose={props.onClose}>{body}</Dialog>
}

// Functions, not constants: the text follows the language chosen now (strings.ts)
const processingHint = (key: ProcessingKey): string =>
  key === 'noiseSuppression'
    ? strings.settings.noiseSuppressionHint
    : key === 'echoCancellation'
      ? strings.settings.echoCancellationHint
      : strings.settings.autoGainControlHint

function AudioTab(props: SettingsDialogProps) {
  const { devices, selected, onSelect, processing, processingSupported } = props
  return (
    <>
      <Fields>
        <DeviceSelect
          choice="mic"
          options={devices.audioinput}
          value={selected.mic}
          onSelect={onSelect}
        />
        {props.speakerSupported && devices.audiooutput.length > 0 && (
          <DeviceSelect
            choice="speaker"
            options={devices.audiooutput}
            value={selected.speaker}
            onSelect={onSelect}
          />
        )}
      </Fields>
      <Group>
        <h3>{strings.settings.processing}</h3>
        {processingSupported.length === 0 ? (
          <Hint>{strings.settings.processingNone}</Hint>
        ) : (
          processingSupported.map((key) => (
            <Toggle
              key={key}
              label={strings.settings[key]}
              hint={processingHint(key)}
              checked={processing[key]}
              onChange={(on) => props.onProcessing({ ...processing, [key]: on })}
            />
          ))
        )}
      </Group>
    </>
  )
}

function VideoTab(props: SettingsDialogProps) {
  return (
    <>
      <Fields>
        <DeviceSelect
          choice="cam"
          options={props.devices.videoinput}
          value={props.selected.cam}
          onSelect={props.onSelect}
        />
      </Fields>
      <Group>
        <Toggle
          label={strings.settings.hd}
          hint={strings.settings.hdHint}
          checked={props.hd}
          onChange={props.onHd}
          note={props.hd && props.hdLimited ? strings.settings.hdLimited : null}
        />
      </Group>
    </>
  )
}

function PerformanceTab(props: SettingsDialogProps) {
  return (
    <Group>
      <Toggle
        label={strings.settings.audioOnly}
        hint={strings.settings.audioOnlyHint}
        checked={props.audioOnly}
        onChange={props.onAudioOnly}
      />
    </Group>
  )
}

/** A switch with its label and a line under it (role="switch": on / off, applied at once) */
function Toggle({
  label,
  hint,
  checked,
  onChange,
  note,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (on: boolean) => void
  /** Something about its state now (HD held back), read as a status */
  note?: string | null
}) {
  const id = useId()
  return (
    <ToggleRow>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.checked)}
      />
      <div>
        <label htmlFor={id}>{label}</label>
        <Hint id={`${id}-hint`}>{hint}</Hint>
        {note && <Note role="status">{note}</Note>}
      </div>
    </ToggleRow>
  )
}

/** The computer's modal: like the shortcuts list (ShortcutsDialog), with Tab kept inside */
function Dialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
    return () => {
      if (before?.isConnected) before.focus?.()
    }
  }, [])
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Tab' && panel.current) {
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => !item.closest('[hidden]'),
      )
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
    <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <Panel
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{strings.settings.title}</h2>
        {children}
        <Actions>
          <Button variant="secondary" onClick={onClose}>
            {strings.common.close}
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
  align-content: start;
  gap: ${space(3)};
  width: min(100%, 520px);
  max-height: calc(100dvh - ${space(8)});
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
`

const TabPanel = styled.div`
  display: grid;
  gap: ${space(4)};
  padding: ${space(3)} ${space(1)};

  &[hidden] {
    display: none;
  }
`

const Fields = styled.div`
  display: grid;
  gap: ${space(3)};
`

const Group = styled.div`
  display: grid;
  gap: ${space(3)};

  h3 {
    margin: 0;
    font-size: ${fontSize.base};
  }
`

const ToggleRow = styled.div`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: ${space(3)};

  input {
    width: 20px;
    height: 20px;
    margin: ${space(0.5)} 0 0;
    accent-color: ${color.primary};
    cursor: pointer;
  }
  input:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 2px;
  }
  label {
    font-weight: 600;
    cursor: pointer;
  }
  div {
    display: grid;
    gap: ${space(1)};
  }
`

const Hint = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.small};
  line-height: 1.6;
`

const Note = styled.p`
  margin: 0;
  padding-left: ${space(2)};
  border-left: 3px solid ${color.warn};
  color: ${color.fg};
  font-size: ${fontSize.small};
  line-height: 1.6;
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
`

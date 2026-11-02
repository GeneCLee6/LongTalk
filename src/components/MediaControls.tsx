import type { ReactNode } from 'react'
import styled from 'styled-components'
import type { DeviceLists, DeviceOption } from '../media/devices.ts'
import { strings } from '../strings.ts'
import { breakpoint, color, radius, space } from '../styles/tokens.ts'
import { IconButton } from './IconButton.tsx'
import { CamIcon, CamOffIcon, ChevronUpIcon, MicIcon, MicOffIcon } from './icons.tsx'
import { Menu, type MenuItem } from './Menu.tsx'

export type DeviceMenuChoice = 'mic' | 'cam' | 'speaker'

export interface MediaControlsProps {
  micOn: boolean
  camOn: boolean
  /** A device is opening: its button waits */
  micBusy?: boolean
  camBusy?: boolean
  onToggleMic: () => void
  onToggleCam: () => void
  devices: DeviceLists
  /** The device in use (or chosen) per menu, to check it */
  selected: Record<DeviceMenuChoice, string | null>
  onSelect: (choice: DeviceMenuChoice, deviceId: string) => void
  /** Offer the speakers (HTMLMediaElement.setSinkId; not Safari or older Firefox) */
  speakerSupported: boolean
  /** More buttons after the media ones (Toolbar: share, chat, participants, more, leave) */
  children?: ReactNode
}

const kindName = {
  mic: strings.devices.mic,
  cam: strings.devices.cam,
  speaker: strings.devices.speaker,
} as const

function deviceItems(
  choice: DeviceMenuChoice,
  options: DeviceOption[],
  selected: string | null,
  onSelect: (choice: DeviceMenuChoice, deviceId: string) => void,
): MenuItem[] {
  // Nothing chosen yet: the browser's default is the first one listed
  const current = selected ?? options[0]?.deviceId ?? null
  return options.map((option, i) => ({
    id: `${choice}-${option.deviceId}`,
    label: option.label || strings.prejoin.deviceFallback(kindName[choice], i + 1),
    section: kindName[choice],
    checked: option.deviceId === current,
    onSelect: () => onSelect(choice, option.deviceId),
  }))
}

/**
 * The room's media buttons (e2-t05, e2-t06): microphone and camera on / off, each with a menu of
 * devices (the microphone's also lists the speakers). Off is the red button with the slashed icon
 * (DESIGN.md §5). The rest of the toolbar comes in as children (Toolbar.tsx, e4-t06).
 */
export function MediaControls(props: MediaControlsProps) {
  const { devices, selected, onSelect } = props
  const micItems = [
    ...deviceItems('mic', devices.audioinput, selected.mic, onSelect),
    ...(props.speakerSupported
      ? deviceItems('speaker', devices.audiooutput, selected.speaker, onSelect)
      : []),
  ]
  const camItems = deviceItems('cam', devices.videoinput, selected.cam, onSelect)
  return (
    <Bar role="toolbar" aria-label={strings.devices.controls} data-theme="dark">
      <Group>
        <IconButton
          label={props.micOn ? strings.toolbar.micOn : strings.toolbar.micOff}
          icon={props.micOn ? <MicIcon /> : <MicOffIcon />}
          showLabel
          pressed={props.micOn}
          disabled={props.micBusy}
          onClick={props.onToggleMic}
        />
        {micItems.length > 0 && (
          <Menu
            label={strings.devices.micMenu}
            icon={<ChevronUpIcon />}
            items={micItems}
            placement="above"
          />
        )}
      </Group>
      <Group>
        <IconButton
          label={props.camOn ? strings.toolbar.camOn : strings.toolbar.camOff}
          icon={props.camOn ? <CamIcon /> : <CamOffIcon />}
          showLabel
          pressed={props.camOn}
          disabled={props.camBusy}
          onClick={props.onToggleCam}
        />
        {camItems.length > 0 && (
          <Menu
            label={strings.devices.camMenu}
            icon={<ChevronUpIcon />}
            items={camItems}
            placement="above"
          />
        )}
      </Group>
      {props.children}
    </Bar>
  )
}

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: ${space(3)};
  padding: ${space(2)} ${space(3)};
  border-radius: ${radius.panel};
  background: ${color.surface};
  color: ${color.fg};

  @media (max-width: ${breakpoint.phone}) {
    gap: ${space(1)};
    padding: ${space(1)};
  }
`

const Group = styled.div`
  display: inline-flex;
  align-items: center;
  gap: ${space(1)};
`

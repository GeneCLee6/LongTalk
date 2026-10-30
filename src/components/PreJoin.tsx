import type { FormEvent } from 'react'
import styled from 'styled-components'
import { normalizeName, MAX_NAME_CHARS } from '../../shared/protocol.ts'
import type { DeviceLists, DeviceOption, MediaProblem } from '../media/devices.ts'
import { strings } from '../strings.ts'
import { breakpoint, color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { SelectField, TextField } from './Field.tsx'
import { IconButton } from './IconButton.tsx'
import { CamIcon, CamOffIcon, MicIcon, MicOffIcon } from './icons.tsx'
import { LevelMeter } from './LevelMeter.tsx'
import { VideoPreview } from './VideoPreview.tsx'

export type DeviceChoice = 'mic' | 'cam' | 'speaker'

export interface PreJoinProps {
  roomId: string
  /** Null while unknown */
  memberCount: number | null
  /** A notice under the room line (the summary could not be loaded) */
  roomNotice?: string | null
  name: string
  onNameChange: (name: string) => void
  mic: boolean
  cam: boolean
  onToggleMic: () => void
  onToggleCam: () => void
  stream: MediaStream | null
  opening: boolean
  level: number
  devices: DeviceLists
  /** The chosen device per menu (null: what the stream is using, or the first) */
  selected: Record<DeviceChoice, string | null>
  onSelect: (choice: DeviceChoice, deviceId: string) => void
  /** Hide the speaker menu where the browser cannot choose one */
  speakerSupported: boolean
  micProblem: MediaProblem | null
  camProblem: MediaProblem | null
  onRetry: () => void
  joining?: boolean
  onJoin: () => void
}

/** The message for what went wrong opening the devices, most actionable first */
function problemMessage(mic: MediaProblem | null, cam: MediaProblem | null): string | null {
  const either = (problem: MediaProblem) => mic === problem || cam === problem
  const { problems } = strings.prejoin
  if (either('denied')) return problems.denied
  if (either('unsupported')) return problems.unsupported
  if (either('inUse')) return problems.inUse
  if (mic === 'notFound' && cam === 'notFound')
    return `${problems.micNotFound}${problems.camNotFound}`
  if (mic === 'notFound') return problems.micNotFound
  if (cam === 'notFound') return problems.camNotFound
  if (either('unknown')) return problems.unknown
  return null
}

const kindName = {
  mic: strings.prejoin.micLabel,
  cam: strings.prejoin.camLabel,
  speaker: strings.prejoin.speakerLabel,
} as const

function DeviceSelect({
  choice,
  options,
  value,
  onSelect,
}: {
  choice: DeviceChoice
  options: DeviceOption[]
  value: string | null
  onSelect: (choice: DeviceChoice, deviceId: string) => void
}) {
  return (
    <SelectField
      label={kindName[choice]}
      value={options.length === 0 ? '' : (value ?? options[0].deviceId)}
      disabled={options.length === 0}
      onChange={(event) => onSelect(choice, event.target.value)}
    >
      {options.length === 0 ? (
        <option value="">{strings.prejoin.noDevices}</option>
      ) : (
        options.map((option, i) => (
          <option key={option.deviceId} value={option.deviceId}>
            {option.label || strings.prejoin.deviceFallback(kindName[choice], i + 1)}
          </option>
        ))
      )}
    </SelectField>
  )
}

/** The pre-join screen (DESIGN.md §4.2): preview and devices on the left, name and join on the right */
export function PreJoin(props: PreJoinProps) {
  const { roomId, memberCount, roomNotice, name, mic, cam, stream, devices, selected, onSelect } =
    props
  const problem = problemMessage(props.micProblem, props.camProblem)
  const showVideo = cam && stream !== null && stream.getVideoTracks().length > 0
  const canJoin = normalizeName(name) !== null && !props.joining

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (canJoin) props.onJoin()
  }

  return (
    <Layout>
      <Media>
        <Frame data-theme="dark">
          {showVideo ? (
            <>
              <VideoPreview stream={stream} label={strings.prejoin.preview} />
              <Badge>{strings.prejoin.mirrored}</Badge>
            </>
          ) : (
            <Placeholder>
              {cam && props.opening ? strings.prejoin.opening : strings.prejoin.camOffPreview}
            </Placeholder>
          )}
          <Controls>
            <IconButton
              label={mic ? strings.prejoin.micOn : strings.prejoin.micOff}
              icon={mic ? <MicIcon /> : <MicOffIcon />}
              pressed={mic}
              onClick={props.onToggleMic}
            />
            <IconButton
              label={cam ? strings.prejoin.camOn : strings.prejoin.camOff}
              icon={cam ? <CamIcon /> : <CamOffIcon />}
              pressed={cam}
              onClick={props.onToggleCam}
            />
          </Controls>
        </Frame>
        <LevelMeter level={mic ? props.level : 0} label={strings.prejoin.micLevel} />
        {problem && (
          <Problem role="alert">
            <span>{problem}</span>
            <Button variant="secondary" onClick={props.onRetry}>
              {strings.common.retry}
            </Button>
          </Problem>
        )}
        <Devices>
          <DeviceSelect
            choice="mic"
            options={devices.audioinput}
            value={selected.mic}
            onSelect={onSelect}
          />
          <DeviceSelect
            choice="cam"
            options={devices.videoinput}
            value={selected.cam}
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
        </Devices>
      </Media>
      <Form onSubmit={onSubmit}>
        <div>
          <h1>{strings.prejoin.title}</h1>
          <Muted>
            {strings.prejoin.roomCode(roomId)}
            {memberCount !== null && ` · ${strings.prejoin.memberCount(memberCount)}`}
          </Muted>
          {roomNotice && <Muted role="status">{roomNotice}</Muted>}
        </div>
        <TextField
          label={strings.prejoin.nameLabel}
          placeholder={strings.prejoin.namePlaceholder}
          value={name}
          maxLength={MAX_NAME_CHARS}
          autoComplete="nickname"
          autoFocus
          required
          onChange={(event) => props.onNameChange(event.target.value)}
        />
        <Button type="submit" block disabled={!canJoin}>
          {props.joining ? strings.prejoin.joining : strings.prejoin.join}
        </Button>
        <Muted>{strings.prejoin.joinState(mic, cam)}</Muted>
      </Form>
    </Layout>
  )
}

const Layout = styled.div`
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: ${space(7)};
  align-items: center;
  width: min(1040px, 100%);
  margin: 0 auto;
  padding: ${space(8)};

  @media (max-width: ${breakpoint.phone}) {
    grid-template-columns: 1fr;
    gap: ${space(5)};
    padding: ${space(4)};
  }
`

const Media = styled.section`
  display: grid;
  gap: ${space(3)};
  min-width: 0;
`

const Frame = styled.div`
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: ${radius.panel};
  overflow: hidden;
  background: linear-gradient(145deg, ${color.tileFrom}, ${color.tileTo});
  color: ${color.fg};
`

const Placeholder = styled.p`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: ${color.muted};
`

const Badge = styled.span`
  position: absolute;
  top: ${space(3)};
  left: ${space(3)};
  padding: ${space(1)} ${space(2)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  font-size: ${fontSize.toolbarLabel};
`

const Controls = styled.div`
  position: absolute;
  bottom: ${space(3)};
  left: 50%;
  z-index: ${layer.overlay};
  display: flex;
  gap: ${space(2)};
  padding: ${space(1)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  transform: translateX(-50%);
`

const Devices = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: ${space(3)};
`

const Problem = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${space(2)};
  padding: ${space(2)} ${space(3)};
  border: 1px solid ${color.warn};
  border-radius: ${radius.button};
  background: ${color.surface};
  font-size: ${fontSize.small};
`

const Form = styled.form`
  display: grid;
  gap: ${space(4)};

  h1 {
    margin: 0 0 ${space(1)};
    font-size: 22px;
  }
`

const Muted = styled.p`
  margin: 0;
  font-size: ${fontSize.small};
  color: ${color.muted};
`

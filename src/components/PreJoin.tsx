import type { FormEvent } from 'react'
import styled from 'styled-components'
import { MAX_PASSWORD_CHARS, normalizePassword } from '../../shared/password.ts'
import { normalizeName, MAX_NAME_CHARS } from '../../shared/protocol.ts'
import type { DeviceLists, MediaProblem } from '../media/devices.ts'
import { strings } from '../strings.ts'
import { breakpoint, color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { DeviceSelect, type DeviceChoice } from './DeviceSelect.tsx'
import { TextField } from './Field.tsx'
import { IconButton } from './IconButton.tsx'
import {
  CamIcon,
  CamOffIcon,
  HourglassIcon,
  MicIcon,
  MicOffIcon,
  RecordIcon,
  SettingsIcon,
  SoundIcon,
} from './icons.tsx'
import { LanguageSelect } from './LanguageSelect.tsx'
import { ThemeSelect } from './ThemeSelect.tsx'
import { LevelMeter } from './LevelMeter.tsx'
import { PermissionGuide, type PermissionGuideProps } from './PermissionGuide.tsx'
import { VideoPreview } from './VideoPreview.tsx'

export type { DeviceChoice }

/** The room's password field (F3, e1-t15), shown when the room has one */
export interface PasswordFieldProps {
  value: string
  onChange: (value: string) => void
  /** Under the field: why it is asked, or that the link brought it */
  hint: string
  /** What went wrong last time (wrong, too many tries); null when nothing did */
  error: string | null
  /** Too many wrong tries: joining waits until this passes */
  waiting?: boolean
}

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
  /** The room has a password (F3): the field above 加入 */
  password?: PasswordFieldProps | null
  /** The room has its waiting room on (F2): a status card, and 加入 becomes 要求加入 (G1) */
  waitingRoom?: boolean
  /** The speaker test (G1, e4-t09); null where the browser cannot choose the speaker */
  speakerTest?: { playing: boolean; onToggle: () => void } | null
  /** The microphone is on but has heard nothing for a while (G1) */
  micSilent?: boolean
  /** The browser blocked the devices: the permission tutorial instead of the short notice (G1) */
  permissionGuide?: PermissionGuideProps | null
  /** Opens the settings panel (H3): sound processing, HD, audio-only */
  onSettings?: () => void
  /** 純音訊模式 is chosen for joining (H3): a line under the join state says so */
  audioOnly?: boolean
  /**
   * The meeting is being recorded (I4, e8-t02, AC-8.2): said before joining, with a way not to
   * join (CLAUDE.md rule 4)
   */
  recording?: boolean
  /** 不加入，回首頁 in the recording notice */
  onHome?: () => void
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
  if (either('unknown') || either('lost')) return problems.unknown
  return null
}

/** The pre-join screen (DESIGN.md §4.2): preview and devices on the left, name and join on the right */
export function PreJoin(props: PreJoinProps) {
  const { roomId, memberCount, roomNotice, name, mic, cam, stream, devices, selected, onSelect } =
    props
  const problem = problemMessage(props.micProblem, props.camProblem)
  const showVideo = cam && stream !== null && stream.getVideoTracks().length > 0
  const pwd = props.password ?? null
  const passwordReady = pwd === null || (normalizePassword(pwd.value) !== null && !pwd.waiting)
  const canJoin = normalizeName(name) !== null && !props.joining && passwordReady

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
        {mic && props.micSilent && !problem && (
          <Muted role="status">{strings.prejoin.micSilent}</Muted>
        )}
        {props.permissionGuide ? (
          <PermissionGuide {...props.permissionGuide} />
        ) : (
          problem && (
            <Problem role="alert">
              <span>{problem}</span>
              <Button variant="secondary" onClick={props.onRetry}>
                {strings.common.retry}
              </Button>
            </Problem>
          )
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
        {props.speakerTest && (
          <SpeakerTest>
            <Button
              variant="secondary"
              aria-pressed={props.speakerTest.playing}
              onClick={props.speakerTest.onToggle}
            >
              <SoundIcon />
              {props.speakerTest.playing
                ? strings.prejoin.speakerTestStop
                : strings.prejoin.speakerTest}
            </Button>
            {props.speakerTest.playing && (
              <Muted role="status">{strings.prejoin.speakerTestHint}</Muted>
            )}
          </SpeakerTest>
        )}
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
        {props.recording && (
          <Recorded role="status">
            <RecordIcon />
            <div>
              <strong>{strings.record.prejoinTitle}</strong>
              <span>{strings.record.prejoinBody}</span>
              {props.onHome && (
                <LinkButton type="button" onClick={props.onHome}>
                  {strings.record.prejoinLeave}
                </LinkButton>
              )}
            </div>
          </Recorded>
        )}
        {props.waitingRoom && (
          <Status role="status">
            <HourglassIcon />
            <div>
              <strong>{strings.prejoin.waitingRoomTitle}</strong>
              <span>{strings.prejoin.waitingRoom}</span>
            </div>
          </Status>
        )}
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
        {pwd && (
          <div>
            <TextField
              label={strings.prejoin.passwordLabel}
              placeholder={strings.prejoin.passwordPlaceholder}
              type="password"
              value={pwd.value}
              // Room for full-width input: folded to ASCII before it is sent (shared/password.ts)
              maxLength={MAX_PASSWORD_CHARS * 2}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              aria-invalid={pwd.error !== null}
              onChange={(event) => pwd.onChange(event.target.value.normalize('NFKC'))}
            />
            {pwd.error ? (
              <ErrorText role="alert">{pwd.error}</ErrorText>
            ) : (
              <Muted>{pwd.hint}</Muted>
            )}
          </div>
        )}
        <Button type="submit" block disabled={!canJoin}>
          {props.joining
            ? strings.prejoin.joining
            : props.waitingRoom
              ? strings.prejoin.joinWaiting
              : strings.prejoin.join}
        </Button>
        <Muted>{strings.prejoin.joinState(mic, cam)}</Muted>
        {props.audioOnly && <Muted role="status">{strings.settings.audioOnlyJoin}</Muted>}
        <Preferences>
          <LanguageSelect />
          <ThemeSelect />
        </Preferences>
        {props.onSettings && (
          <SettingsRow>
            <Button variant="secondary" onClick={props.onSettings}>
              <SettingsIcon />
              {strings.settings.open}
            </Button>
          </SettingsRow>
        )}
      </Form>
    </Layout>
  )
}

const SettingsRow = styled.div`
  display: flex;

  svg {
    width: 18px;
    height: 18px;
  }
`

const Preferences = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${space(2)} ${space(4)};
`

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

const SpeakerTest = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(3)};

  svg {
    width: 18px;
    height: 18px;
  }
`

const Status = styled.div`
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: ${space(3)};
  padding: ${space(3)};
  border-radius: ${radius.button};
  background: ${color.primarySoft};
  font-size: ${fontSize.small};

  svg {
    width: 22px;
    height: 22px;
    color: ${color.primary};
  }
  div {
    display: grid;
    gap: ${space(1)};
  }
`

/** 這場會議正在錄影 (I4): the red of the recording light, with the words */
const Recorded = styled(Status)`
  border: 1px solid ${color.danger};
  background: ${color.surface};

  svg {
    color: ${color.danger};
  }
`

const LinkButton = styled.button`
  justify-self: start;
  padding: 0;
  border: none;
  background: none;
  color: ${color.primary};
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
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

const ErrorText = styled.p`
  margin: ${space(1)} 0 0;
  font-size: ${fontSize.small};
  color: ${color.danger};
`

const Muted = styled.p`
  margin: 0;
  font-size: ${fontSize.small};
  color: ${color.muted};
`

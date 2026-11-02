import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { normalizeName } from '../../shared/protocol.ts'
import { isRoomId } from '../../shared/room-id.ts'
import type { UsageState } from '../../shared/usage.ts'
import { getRoom } from '../api/rooms.ts'
import { fetchIceConfig } from '../api/turn.ts'
import { Button } from '../components/Button.tsx'
import { MediaControls } from '../components/MediaControls.tsx'
import { PreJoin } from '../components/PreJoin.tsx'
import { Stage } from '../components/Stage.tsx'
import { Tile, type TileProps } from '../components/Tile.tsx'
import { ToastViewport } from '../components/Toast.tsx'
import { useToasts } from '../components/useToasts.ts'
import { canChooseSpeaker, supportsWebRtc } from '../media/capabilities.ts'
import { activeDeviceId, type MediaProblem } from '../media/devices.ts'
import { trackKey, type MediaTransportErrorCode } from '../media/MediaTransport.ts'
import type { RoomConnectionState } from '../room/RoomConnection.ts'
import type { DeviceNotice, LocalDevicesState, LocalKind } from '../room/LocalDevices.ts'
import {
  clearSession,
  loadDevices,
  loadName,
  loadSession,
  saveDevice,
  saveName,
  type DeviceChoices,
} from '../room/session.ts'
import { useLocalDevices } from '../room/useLocalDevices.ts'
import { useLocalPreview } from '../room/useLocalPreview.ts'
import { useMicLevel } from '../room/useMicLevel.ts'
import { useRoomConnection } from '../room/useRoomConnection.ts'
import type { LocalTracks } from '../room/RoomMedia.ts'
import { useRoomMedia } from '../room/useRoomMedia.ts'
import { useSpeaking } from '../room/useSpeaking.ts'
import { useTransportFactory } from '../room/transportContext.ts'
import { strings } from '../strings.ts'
import { color, font, fontSize, layer, radius, space } from '../styles/tokens.ts'

/** What the pre-join screen hands to the room: the room publishes with the media choices */
export interface JoinChoices {
  name: string
  mic: boolean
  cam: boolean
  /** The devices chosen (also remembered in localStorage, session.ts) */
  devices: DeviceChoices
}

/**
 * A tab that joined this room before (it still holds the session token) and knows its name goes
 * straight back in: a reload lands in the room as the same member (AC-1.2).
 */
function resume(roomId: string): JoinChoices | null {
  const name = loadName()
  return loadSession(roomId) && name ? { name, mic: true, cam: true, devices: loadDevices() } : null
}

export default function RoomPage() {
  const { roomId = '' } = useParams()
  if (!isRoomId(roomId)) {
    return (
      <Page>
        <NotFound />
      </Page>
    )
  }
  return <RoomEntry key={roomId} roomId={roomId} />
}

function RoomEntry({ roomId }: { roomId: string }) {
  const navigate = useNavigate()
  const [joined, setJoined] = useState<JoinChoices | null>(() => resume(roomId))
  const [supported] = useState(supportsWebRtc)
  if (!supported) {
    return (
      <Page>
        <Unsupported />
      </Page>
    )
  }
  if (joined) {
    // The room is dark whatever the system scheme (DESIGN.md §1.2)
    return (
      <Shell data-theme="dark">
        <Room roomId={roomId} choices={joined} onLeft={() => navigate('/')} />
      </Shell>
    )
  }
  return (
    <Page>
      <PreJoinGate
        roomId={roomId}
        onJoin={(choices) => {
          saveName(choices.name)
          setJoined(choices)
        }}
      />
    </Page>
  )
}

type Summary =
  | { status: 'loading' | 'missing' | 'error'; memberCount: null }
  | { status: 'ok'; memberCount: number }

/** Checks the room exists before the pre-join screen asks for the camera */
function PreJoinGate({
  roomId,
  onJoin,
}: {
  roomId: string
  onJoin: (choices: JoinChoices) => void
}) {
  const [summary, setSummary] = useState<Summary>({ status: 'loading', memberCount: null })
  useEffect(() => {
    let cancelled = false
    getRoom(roomId).then(
      (room) => {
        if (cancelled) return
        setSummary(
          room
            ? { status: 'ok', memberCount: room.memberCount }
            : { status: 'missing', memberCount: null },
        )
      },
      () => {
        if (!cancelled) setSummary({ status: 'error', memberCount: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [roomId])
  switch (summary.status) {
    case 'loading':
      return <p role="status">{strings.room.connecting}</p>
    case 'missing':
      return <NotFound />
    default:
      return <PreJoinScreen roomId={roomId} summary={summary} onJoin={onJoin} />
  }
}

function PreJoinScreen({
  roomId,
  summary,
  onJoin,
}: {
  roomId: string
  summary: Summary
  onJoin: (choices: JoinChoices) => void
}) {
  const [name, setName] = useState(loadName)
  const [mic, setMic] = useState(true)
  const [cam, setCam] = useState(true)
  const [devices, setDevices] = useState<DeviceChoices>(loadDevices)
  const preview = useLocalPreview({ mic, cam, micId: devices.mic, camId: devices.cam })
  const level = useMicLevel(preview.stream)
  const [speakerSupported] = useState(canChooseSpeaker)

  return (
    <PreJoin
      roomId={roomId}
      memberCount={summary.memberCount}
      roomNotice={summary.status === 'error' ? strings.prejoin.loadFailed : null}
      name={name}
      onNameChange={setName}
      mic={mic}
      cam={cam}
      onToggleMic={() => setMic((on) => !on)}
      onToggleCam={() => setCam((on) => !on)}
      stream={preview.stream}
      opening={preview.opening}
      level={level}
      devices={preview.devices}
      selected={{
        mic: devices.mic ?? activeDeviceId(preview.stream, 'audio'),
        cam: devices.cam ?? activeDeviceId(preview.stream, 'video'),
        speaker: devices.speaker,
      }}
      onSelect={(choice, deviceId) => {
        saveDevice(choice, deviceId)
        setDevices((current) => ({ ...current, [choice]: deviceId }))
      }}
      speakerSupported={speakerSupported}
      micProblem={preview.micProblem}
      camProblem={preview.camProblem}
      onRetry={preview.retry}
      onJoin={() => {
        const normalized = normalizeName(name)
        if (normalized) onJoin({ name: normalized, mic, cam, devices })
      }}
    />
  )
}

function Room({
  roomId,
  choices,
  onLeft,
}: {
  roomId: string
  choices: JoinChoices
  onLeft: () => void
}) {
  const { state, leave, send, retry: retryRoom } = useRoomConnection(roomId, choices.name)
  const gone = state.status === 'notFound'
  useEffect(() => {
    if (gone) clearSession(roomId)
  }, [gone, roomId])

  const toasts = useToasts()
  const { show } = toasts
  const onNotice = useCallback((notice: DeviceNotice) => show(noticeText(notice), 'warn'), [show])
  // The microphone and camera chosen on the pre-join screen, opened again for the room; the
  // toolbar turns them on and off and switches them after that (e2-t05, e2-t06)
  const { state: local, devices } = useLocalDevices(
    { mic: choices.mic, cam: choices.cam },
    choices.devices,
    onNotice,
  )
  const micSending = local.mic.on ? local.mic.track : null
  const camSending = local.cam.on ? local.cam.track : null
  const sending = useMemo<LocalTracks | null>(
    () => (local.ready ? { mic: micSending, cam: camSending } : null),
    [local.ready, micSending, camSending],
  )
  const [speakerSupported] = useState(canChooseSpeaker)

  // The SFU proxy asks for the session token on every call; the transport reads the latest
  const token = useRef(state.token)
  useEffect(() => {
    token.current = state.token
  }, [state.token])
  const makeTransport = useTransportFactory()
  const createTransport = useCallback(
    () => makeTransport(roomId, () => token.current),
    [makeTransport, roomId],
  )
  // `?ice=relay` forces the media through TURN: a debugging aid for checking TURN (e2-t07)
  const [relayOnly] = useState(() => new URLSearchParams(location.search).get('ice') === 'relay')
  const iceConfig = useCallback(
    () => fetchIceConfig(roomId, token.current, relayOnly),
    [roomId, relayOnly],
  )
  // The room view stays on screen while the socket reconnects; so does the media connection
  const inRoom = state.status === 'open' || state.status === 'reconnecting'
  const media = useRoomMedia({
    enabled: inRoom && state.token !== null,
    createTransport,
    iceConfig,
    local: sending,
    send,
    you: state.you,
    view: state.view,
    welcomes: state.welcomes,
  })
  const usage = state.view?.usage ?? 'normal'
  useUsageNotices(usage, media.videoRefused, show)

  const toggleCam = () => {
    // Once the month is audio-only a camera that is off stays off (e11-t13): say so without
    // opening it
    if (!local.cam.on && usage === 'audioOnly') {
      show(strings.usage.videoRefused, 'warn')
      return
    }
    void devices?.setOn('cam', !local.cam.on)
  }

  if (gone) {
    return (
      <Centered>
        <NotFound />
      </Centered>
    )
  }
  const members = Object.values(state.view?.members ?? {})
  // Gave up rebuilding the media session (e2-t08): say so, with a retry
  const mediaLost =
    media.status === 'failed' &&
    media.error !== 'sfu_not_configured' &&
    media.error !== 'unauthorized'
  const mediaProblem = mediaLost ? null : mediaErrorText(media.error)
  const selfReconnecting = state.status === 'reconnecting' || media.status === 'reconnecting'
  return (
    <>
      {/* The top bar's place: room name and status (the full top bar is C2, e4-t06) */}
      <Header>
        <h1>{strings.room.title(roomId)}</h1>
        <Status role="status" $tone={state.status === 'open' ? 'normal' : 'warn'}>
          {statusText(state)}
        </Status>
      </Header>
      <StageArea>
        {inRoom && (
          <Stage>
            {members.map((member) => {
              const you = member.id === state.you
              const listed = (kind: 'mic' | 'cam') => member.tracks.find((t) => t.kind === kind)
              const received = (kind: 'mic' | 'cam') => {
                const track = listed(kind)
                return (track && media.received[trackKey(track)]?.track) || null
              }
              const cam = listed('cam')
              const mic = listed('mic')
              const audio = you ? null : received('mic')
              return (
                <MemberTile
                  key={member.id}
                  name={member.name}
                  you={you}
                  reconnecting={you ? selfReconnecting : member.reconnecting}
                  relayed={you && media.usingRelay}
                  video={
                    you
                      ? media.videoRefused
                        ? null
                        : camSending
                      : cam && !cam.muted
                        ? received('cam')
                        : null
                  }
                  audio={audio}
                  // The speaking outline follows our own microphone while it sends, theirs
                  // while it is on
                  level={you ? micSending : mic && !mic.muted ? audio : null}
                  micMuted={you ? micSending === null : (mic?.muted ?? true)}
                  speaker={local.chosen.speaker}
                />
              )
            })}
          </Stage>
        )}
        <Notices>
          {state.status === 'lost' && (
            <Button variant="secondary" onClick={retryRoom}>
              {strings.common.retry}
            </Button>
          )}
          {inRoom && media.status === 'connecting' && <Note>{strings.room.mediaConnecting}</Note>}
          {inRoom && state.status === 'open' && media.status === 'reconnecting' && (
            <Note role="status">{strings.room.mediaReconnecting}</Note>
          )}
          {mediaLost && (
            <Alert role="alert">
              <span>{strings.room.mediaLost}</span>
              <Button variant="secondary" onClick={media.retry}>
                {strings.common.retry}
              </Button>
            </Alert>
          )}
          {mediaProblem && <Alert role="alert">{mediaProblem}</Alert>}
          <DeviceProblems local={local} onRetry={(kind) => void devices?.retry(kind)} />
        </Notices>
      </StageArea>
      {/* The toolbar's place (the full toolbar is C2, e4-t06) */}
      <ToolbarArea>
        <MediaControls
          micOn={local.mic.on}
          camOn={local.cam.on}
          micBusy={!local.ready || local.mic.opening}
          camBusy={!local.ready || local.cam.opening}
          onToggleMic={() => void devices?.setOn('mic', !local.mic.on)}
          onToggleCam={toggleCam}
          devices={local.devices}
          selected={{
            mic: trackDevice(local.mic.track) ?? local.chosen.mic,
            cam: trackDevice(local.cam.track) ?? local.chosen.cam,
            speaker: local.chosen.speaker,
          }}
          onSelect={(choice, deviceId) => void devices?.select(choice, deviceId)}
          speakerSupported={speakerSupported}
        >
          <Button
            variant="danger"
            onClick={() => {
              leave()
              onLeft()
            }}
          >
            {strings.toolbar.leave}
          </Button>
        </MediaControls>
      </ToolbarArea>
      <ToastViewport toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  )
}

/** One member's tile, with the speaking outline from their microphone's level (e4-t05) */
function MemberTile({ level, ...tile }: TileProps & { level: MediaStreamTrack | null }) {
  const speaking = useSpeaking(level)
  return <Tile {...tile} speaking={speaking} />
}

const trackDevice = (track: MediaStreamTrack | null): string | null =>
  track?.getSettings?.().deviceId ?? null

const kindName = (kind: LocalKind) => (kind === 'mic' ? strings.devices.mic : strings.devices.cam)

function noticeText(notice: DeviceNotice): string {
  const kind = kindName(notice.kind)
  switch (notice.type) {
    case 'switched':
      return strings.devices.switched(kind, notice.label)
    case 'recovered':
      return strings.devices.recovered(kind, notice.label)
    case 'switchFailed':
      return strings.devices.switchFailed(kind)
  }
}

function problemText(kind: LocalKind, problem: MediaProblem): string {
  const { problems } = strings.devices
  const name = kindName(kind)
  switch (problem) {
    case 'denied':
      return problems.denied(name)
    case 'inUse':
      return problems.inUse(name)
    case 'notFound':
      return problems.notFound(name)
    case 'lost':
      return problems.lost(name)
    case 'unsupported':
      return problems.unsupported
    case 'unknown':
      return problems.unknown(name)
  }
}

/**
 * Why the microphone or camera is off against the person's wish (e2-t09), with what to do and a
 * retry. Without device support at all there is one notice and nothing to retry.
 */
function DeviceProblems({
  local,
  onRetry,
}: {
  local: LocalDevicesState
  onRetry: (kind: LocalKind) => void
}) {
  const kinds = (['mic', 'cam'] as const).filter((kind) => local[kind].problem !== null)
  if (kinds.length === 0) return null
  if (kinds.some((kind) => local[kind].problem === 'unsupported')) {
    return <Alert role="alert">{strings.devices.problems.unsupported}</Alert>
  }
  // The same refusal for both: one message, one retry
  const both = kinds.length === 2 && local.mic.problem === local.cam.problem
  const shown = both ? (['mic'] as const) : kinds
  return (
    <>
      {shown.map((kind) => (
        <Alert key={kind} role="alert">
          <span>
            {both && local.mic.problem === 'denied'
              ? strings.prejoin.problems.denied
              : problemText(kind, local[kind].problem!)}
          </span>
          <Button
            variant="secondary"
            onClick={() => (both ? kinds.forEach(onRetry) : onRetry(kind))}
          >
            {strings.common.retry}
          </Button>
        </Alert>
      ))}
    </>
  )
}

/** No WebRTC at all: nothing in the room would work (e2-t09) */
function Unsupported() {
  return (
    <Panel>
      <h1>{strings.unsupported.title}</h1>
      <p role="alert">{strings.unsupported.body}</p>
      <Link to="/">{strings.room.backHome}</Link>
    </Panel>
  )
}

function mediaErrorText(error: MediaTransportErrorCode | null): string | null {
  switch (error) {
    case null:
    case 'closed':
      return null
    case 'sfu_not_configured':
      return strings.errors.sfuNotConfigured
    case 'unauthorized':
      return strings.errors.sfuUnauthorized
    default:
      return strings.errors.sfu
  }
}

/**
 * The free-tier notices (e11-t13): a toast whenever the month's state gets worse while we are in
 * the room (or is already bad when we arrive), and one when our own camera was not sent
 */
function useUsageNotices(
  usage: UsageState,
  videoRefused: boolean,
  show: (text: string, tone: 'warn') => void,
) {
  useEffect(() => {
    if (usage === 'low') show(strings.usage.low, 'warn')
    if (usage === 'audioOnly') show(strings.usage.audioOnly, 'warn')
  }, [usage, show])
  useEffect(() => {
    if (videoRefused) show(strings.usage.videoRefused, 'warn')
  }, [videoRefused, show])
}

function statusText({ status, view }: RoomConnectionState): string {
  switch (status) {
    case 'connecting':
    case 'notFound':
      return strings.room.connecting
    case 'open':
      return strings.room.memberCount(Object.keys(view?.members ?? {}).length)
    case 'reconnecting':
      return strings.room.reconnectingSelf
    case 'lost':
      return strings.room.lost
    case 'full':
      return strings.room.full
    case 'outdated':
      return strings.room.outdated
    case 'replaced':
      return strings.room.replaced
  }
}

function NotFound() {
  return (
    <Panel>
      <p role="alert">{strings.room.notFound}</p>
      <Link to="/">{strings.room.backHome}</Link>
    </Panel>
  )
}

const Page = styled.main`
  min-height: 100dvh;
  display: grid;
  place-items: center;
  font-family: ${font.ui};
  background: ${color.bg};
  color: ${color.fg};

  a {
    color: ${color.primary};
  }
`

const Panel = styled.section`
  display: grid;
  justify-items: center;
  gap: ${space(3)};
  padding: ${space(6)};
  text-align: center;

  h1 {
    margin: 0;
    font-size: 22px;
  }
  p {
    margin: 0;
  }
`

const Alert = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${space(2)};
  max-width: 640px;
  padding: ${space(2)} ${space(3)};
  border: 1px solid ${color.warn};
  border-radius: ${radius.button};
  background: ${color.surface};
  font-size: ${fontSize.small};
  text-align: left;
`

/**
 * The room (DESIGN.md §4.3): the top bar's row, the stage, the toolbar's row; the side panel
 * joins in C2 / D3
 */
const Shell = styled.main`
  height: 100dvh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  font-family: ${font.ui};
  background: ${color.bg};
  color: ${color.fg};

  a {
    color: ${color.primary};
  }
`

const Centered = styled.div`
  grid-row: 1 / -1;
  display: grid;
  place-items: center;
`

const Header = styled.header`
  display: flex;
  align-items: center;
  gap: ${space(3)};
  min-height: 44px;
  padding: 0 ${space(4)};
  border-bottom: 1px solid ${color.line};
  background: ${color.surface};
  font-size: ${fontSize.nameplate};
  color: ${color.muted};

  h1 {
    margin: 0;
    font-size: ${fontSize.small};
    font-weight: 700;
    color: ${color.fg};
  }
`

const Status = styled.p<{ $tone: 'normal' | 'warn' }>`
  margin: 0;
  color: ${({ $tone }) => ($tone === 'warn' ? color.warn : color.muted)};
  font-weight: ${({ $tone }) => ($tone === 'warn' ? 600 : 400)};
`

const StageArea = styled.div`
  position: relative;
  min-width: 0;
  margin: ${space(3)};
`

/** Above the stage, centred at the top: what is wrong and how to fix it */
const Notices = styled.div`
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: ${layer.overlay};
  display: grid;
  justify-items: center;
  gap: ${space(2)};
  width: min(100%, 640px);

  &:empty {
    display: none;
  }
`

const Note = styled.p`
  margin: 0;
  padding: ${space(1)} ${space(3)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  font-size: ${fontSize.small};
`

const ToolbarArea = styled.footer`
  display: flex;
  justify-content: center;
  padding: ${space(1)} ${space(3)};
  border-top: 1px solid ${color.line};
  background: ${color.surface};
`

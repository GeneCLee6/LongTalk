import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { normalizeName } from '../../shared/protocol.ts'
import { isRoomId } from '../../shared/room-id.ts'
import type { UsageState } from '../../shared/usage.ts'
import { getRoom } from '../api/rooms.ts'
import { Button } from '../components/Button.tsx'
import { MemberTile } from '../components/MemberTile.tsx'
import { PreJoin, type DeviceChoice } from '../components/PreJoin.tsx'
import { ToastViewport } from '../components/Toast.tsx'
import { useToasts } from '../components/useToasts.ts'
import { activeDeviceId, canChooseSpeaker } from '../media/devices.ts'
import { trackKey, type MediaTransportErrorCode } from '../media/MediaTransport.ts'
import type { RoomConnectionState } from '../room/RoomConnection.ts'
import { clearSession, loadName, loadSession, saveName } from '../room/session.ts'
import { useLocalPreview } from '../room/useLocalPreview.ts'
import { useMicLevel } from '../room/useMicLevel.ts'
import { useRoomConnection } from '../room/useRoomConnection.ts'
import type { LocalTracks, RoomMediaState } from '../room/RoomMedia.ts'
import { useRoomMedia } from '../room/useRoomMedia.ts'
import { useTransportFactory } from '../room/transportContext.ts'
import { strings } from '../strings.ts'
import { color, font, space } from '../styles/tokens.ts'

/** What the pre-join screen hands to the room: the room publishes with the media choices */
export interface JoinChoices {
  name: string
  mic: boolean
  cam: boolean
  devices: Record<DeviceChoice, string | null>
}

const noDevices = { mic: null, cam: null, speaker: null }

/**
 * A tab that joined this room before (it still holds the session token) and knows its name goes
 * straight back in: a reload lands in the room as the same member (AC-1.2).
 */
function resume(roomId: string): JoinChoices | null {
  const name = loadName()
  return loadSession(roomId) && name ? { name, mic: true, cam: true, devices: noDevices } : null
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
  if (joined) {
    // The room is dark whatever the system scheme (DESIGN.md §1.2)
    return (
      <Page data-theme="dark">
        <Room roomId={roomId} choices={joined} onLeft={() => navigate('/')} />
      </Page>
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
  const [devices, setDevices] = useState<Record<DeviceChoice, string | null>>(noDevices)
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
      onSelect={(choice, deviceId) => setDevices((current) => ({ ...current, [choice]: deviceId }))}
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
  const { state, leave, send } = useRoomConnection(roomId, choices.name)
  const gone = state.status === 'notFound'
  useEffect(() => {
    if (gone) clearSession(roomId)
  }, [gone, roomId])

  // The microphone and camera chosen on the pre-join screen, opened again for the room
  const devices = useLocalPreview({
    mic: choices.mic,
    cam: choices.cam,
    micId: choices.devices.mic,
    camId: choices.devices.cam,
  })
  const local = useMemo<LocalTracks | null>(
    () =>
      devices.opening
        ? null
        : {
            mic: devices.stream?.getAudioTracks()[0] ?? null,
            cam: devices.stream?.getVideoTracks()[0] ?? null,
          },
    [devices.opening, devices.stream],
  )

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
  const media = useRoomMedia({
    enabled: state.status === 'open' && state.token !== null,
    createTransport,
    local,
    send,
    you: state.you,
    view: state.view,
  })
  const toasts = useToasts()
  useUsageNotices(state.view?.usage ?? 'normal', media.videoRefused, toasts.show)

  if (gone) return <NotFound />
  const members = Object.values(state.view?.members ?? {})
  const mediaProblem = mediaErrorText(media.error)
  return (
    <Panel>
      <h1>{strings.room.title(roomId)}</h1>
      <p role="status">{statusText(state)}</p>
      {state.status === 'open' && media.status === 'connecting' && (
        <p>{strings.room.mediaConnecting}</p>
      )}
      {mediaProblem && <p role="alert">{mediaProblem}</p>}
      {state.status === 'open' && (
        <Grid aria-label={strings.room.grid}>
          {members.map((member) => {
            const you = member.id === state.you
            const received = (kind: 'mic' | 'cam') => {
              const track = member.tracks.find((t) => t.kind === kind)
              return (track && media.received[trackKey(track)]?.track) || null
            }
            return (
              <MemberTile
                key={member.id}
                name={member.name}
                you={you}
                reconnecting={member.reconnecting}
                video={you ? ownCamera(local, media) : received('cam')}
                audio={you ? null : received('mic')}
              />
            )
          })}
        </Grid>
      )}
      <Button
        variant="danger"
        onClick={() => {
          leave()
          onLeft()
        }}
      >
        {strings.toolbar.leave}
      </Button>
      <ToastViewport toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </Panel>
  )
}

/** Our own camera on our tile, unless it was refused this month */
function ownCamera(local: LocalTracks | null, media: RoomMediaState): MediaStreamTrack | null {
  return media.videoRefused ? null : (local?.cam ?? null)
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
    case 'full':
      return strings.room.full
    case 'outdated':
      return strings.room.outdated
    case 'replaced':
      return strings.room.replaced
    case 'closed':
      return strings.room.closed
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

const Grid = styled.section`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: ${space(3)};
  width: min(100vw - ${space(8)}, 1100px);
`

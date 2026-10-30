import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { normalizeName } from '../../shared/protocol.ts'
import { isRoomId } from '../../shared/room-id.ts'
import { getRoom } from '../api/rooms.ts'
import { Button } from '../components/Button.tsx'
import { PreJoin, type DeviceChoice } from '../components/PreJoin.tsx'
import { activeDeviceId, canChooseSpeaker } from '../media/devices.ts'
import type { RoomConnectionState } from '../room/RoomConnection.ts'
import { clearSession, loadName, loadSession, saveName } from '../room/session.ts'
import { useLocalPreview } from '../room/useLocalPreview.ts'
import { useMicLevel } from '../room/useMicLevel.ts'
import { useRoomConnection } from '../room/useRoomConnection.ts'
import { strings } from '../strings.ts'
import { color, font, radius, space } from '../styles/tokens.ts'

/** What the pre-join screen hands to the room; B1 (e2-t03) publishes with the media choices */
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
        <Room roomId={roomId} name={joined.name} onLeft={() => navigate('/')} />
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

function Room({ roomId, name, onLeft }: { roomId: string; name: string; onLeft: () => void }) {
  const { state, leave } = useRoomConnection(roomId, name)
  const gone = state.status === 'notFound'
  useEffect(() => {
    if (gone) clearSession(roomId)
  }, [gone, roomId])
  if (gone) return <NotFound />
  const members = Object.values(state.view?.members ?? {})
  return (
    <Panel>
      <h1>{strings.room.title(roomId)}</h1>
      <p role="status">{statusText(state)}</p>
      {state.status === 'open' && (
        <Members aria-label={strings.room.members}>
          {members.map((member) => (
            <li key={member.id}>
              {member.name}
              {member.id === state.you && <Tag>{strings.common.you}</Tag>}
              {member.reconnecting && <Tag $warn>{strings.room.reconnecting}</Tag>}
            </li>
          ))}
        </Members>
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
    </Panel>
  )
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

const Members = styled.ul`
  display: grid;
  gap: ${space(2)};
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${space(2)};
    padding: ${space(2)} ${space(4)};
    border-radius: ${radius.button};
    background: ${color.surface};
  }
`

const Tag = styled.span<{ $warn?: boolean }>`
  padding: 0 ${space(2)};
  border-radius: ${radius.pill};
  font-size: 12px;
  background: ${({ $warn }) => ($warn ? color.warn : color.primarySoft)};
  color: ${({ $warn }) => ($warn ? color.bg : color.fg)};
`

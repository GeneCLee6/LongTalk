import { useMemo } from 'react'
import styled from 'styled-components'
import type { LobbyState } from '../room/RoomConnection.ts'
import { strings } from '../strings.ts'
import { color, fontSize, media, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { IconButton } from './IconButton.tsx'
import { CamIcon, CamOffIcon, HourglassIcon, MicIcon, MicOffIcon } from './icons.tsx'
import { VideoPreview } from './VideoPreview.tsx'

export interface WaitingScreenProps {
  /** The room's name as the top bar would show it */
  roomName: string
  /** The latest `lobby`: place in the queue, whether a host is there to admit */
  lobby: LobbyState
  /** The socket dropped (we keep our place for the grace period) or gave up */
  connection: 'ok' | 'reconnecting' | 'lost'
  /** Our own camera, already open for the room (null while off) */
  camera: MediaStreamTrack | null
  micOn: boolean
  camOn: boolean
  micBusy?: boolean
  camBusy?: boolean
  onToggleMic: () => void
  onToggleCam: () => void
  onLeave: () => void
  onRetry: () => void
}

/**
 * The waiting room as the one waiting sees it (F2, e1-t11): the room's name, our own camera
 * (mirrored) with the microphone and camera switches, our place in the queue, 「主持人會讓你進來」
 * (or that nobody who can admit is there now), and 離開. The microphone and camera are the
 * room's own (useLocalDevices): admitted, the room appears in their place with the same devices
 * and the same name, nothing asked again.
 */
export function WaitingScreen({
  roomName,
  lobby,
  connection,
  camera,
  micOn,
  camOn,
  micBusy = false,
  camBusy = false,
  onToggleMic,
  onToggleCam,
  onLeave,
  onRetry,
}: WaitingScreenProps) {
  const stream = useMemo(() => (camera ? new MediaStream([camera]) : null), [camera])
  return (
    <Card aria-labelledby="waiting-title">
      <Head>
        <Room title={roomName}>{roomName}</Room>
        <h1 id="waiting-title">
          <HourglassIcon />
          {strings.waiting.title}
        </h1>
      </Head>
      <Frame data-theme="dark">
        {stream && camOn ? (
          <VideoPreview stream={stream} label={strings.waiting.preview} />
        ) : (
          <Placeholder>{strings.waiting.camOff}</Placeholder>
        )}
        <Controls>
          <IconButton
            label={micOn ? strings.prejoin.micOn : strings.prejoin.micOff}
            icon={micOn ? <MicIcon /> : <MicOffIcon />}
            pressed={micOn}
            disabled={micBusy}
            onClick={onToggleMic}
          />
          <IconButton
            label={camOn ? strings.prejoin.camOn : strings.prejoin.camOff}
            icon={camOn ? <CamIcon /> : <CamOffIcon />}
            pressed={camOn}
            disabled={camBusy}
            onClick={onToggleCam}
          />
        </Controls>
      </Frame>
      <Status role="status" aria-live="polite">
        {connection === 'ok' ? (
          <>
            <Position>{strings.waiting.position(lobby.position, lobby.count)}</Position>
            <Body>{lobby.hostPresent ? strings.waiting.body : strings.waiting.hostAbsent}</Body>
            {lobby.recording && <Body>{strings.record.waiting}</Body>}
          </>
        ) : (
          <Warn>
            {connection === 'reconnecting' ? strings.waiting.reconnecting : strings.waiting.lost}
          </Warn>
        )}
      </Status>
      <Actions>
        {connection === 'lost' && <Button onClick={onRetry}>{strings.common.retry}</Button>}
        <Button variant="secondary" onClick={onLeave}>
          {strings.waiting.leave}
        </Button>
      </Actions>
    </Card>
  )
}

const Card = styled.section`
  display: grid;
  gap: ${space(4)};
  width: min(100% - ${space(8)}, 560px);
  margin: auto;
  padding: ${space(6)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  text-align: center;

  @media ${media.phone} {
    width: 100%;
    min-height: 100%;
    align-content: center;
    padding: max(${space(4)}, env(safe-area-inset-top)) ${space(4)}
      max(${space(4)}, env(safe-area-inset-bottom));
    border: none;
    border-radius: 0;
  }
`

const Head = styled.div`
  display: grid;
  gap: ${space(1)};

  h1 {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: ${space(2)};
    margin: 0;
    font-size: 22px;
  }
  h1 svg {
    width: 22px;
    height: 22px;
    color: ${color.warn};
  }
`

const Room = styled.p`
  margin: 0;
  overflow: hidden;
  color: ${color.muted};
  font-size: ${fontSize.small};
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Frame = styled.div`
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: ${radius.tile};
  overflow: hidden;
  background: linear-gradient(145deg, ${color.tileFrom}, ${color.tileTo});
  color: ${color.fg};

  @media ${media.phone} {
    aspect-ratio: 4 / 3;
  }
`

const Placeholder = styled.p`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: ${color.muted};
`

const Controls = styled.div`
  position: absolute;
  bottom: ${space(3)};
  left: 50%;
  display: flex;
  gap: ${space(2)};
  padding: ${space(1)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  transform: translateX(-50%);
`

const Status = styled.div`
  display: grid;
  gap: ${space(1)};
  min-height: 3.5em;
`

const Position = styled.p`
  margin: 0;
  font-size: 18px;
  font-weight: 700;
`

const Body = styled.p`
  margin: 0;
  color: ${color.muted};
  line-height: 1.6;
`

const Warn = styled.p`
  margin: 0;
  color: ${color.warn};
  font-weight: 600;
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: ${space(3)};
`

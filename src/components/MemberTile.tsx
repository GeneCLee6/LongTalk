import { useEffect, useRef } from 'react'
import styled from 'styled-components'
import { setSpeaker } from '../media/devices.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { MicOffIcon } from './icons.tsx'

export interface MemberTileProps {
  name: string
  /** This browser's own tile: mirrored, never plays its own audio */
  you?: boolean
  reconnecting?: boolean
  /** The member's camera (received, or our own local track); null when it is off */
  video: MediaStreamTrack | null
  /** The member's microphone, received; always null on our own tile */
  audio: MediaStreamTrack | null
  /** The microphone is off (muted, or never published): the nameplate shows it (e2-t05) */
  micMuted?: boolean
  /** The speaker chosen in the room (setSinkId where supported); null: the system default */
  speaker?: string | null
  /** Our own media goes through a TURN relay (e2-t07): a quiet note on our own nameplate */
  relayed?: boolean
}

/** Puts one track into a media element, or clears it (jsdom has no MediaStream) */
function useTrack<T extends HTMLMediaElement>(track: MediaStreamTrack | null) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const element = ref.current
    if (!element || !track || typeof MediaStream === 'undefined') return
    element.srcObject = new MediaStream([track])
    void element.play?.()?.catch(() => undefined)
    return () => {
      element.srcObject = null
    }
  }, [track])
  return ref
}

/**
 * One member in the room grid (B1's simple layout; the real layout is C1, e4-t04): their camera
 * or their initial, their name, and their microphone played through a hidden <audio>.
 */
export function MemberTile({
  name,
  you = false,
  reconnecting = false,
  video,
  audio,
  micMuted = false,
  speaker = null,
  relayed = false,
}: MemberTileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  const audioRef = useTrack<HTMLAudioElement>(audio)
  useEffect(() => {
    setSpeaker(audioRef.current, speaker)
  }, [audioRef, audio, speaker])
  const label = you ? `${name}（${strings.common.you}）` : name
  return (
    <Tile aria-label={label}>
      {video ? (
        <Video
          ref={videoRef}
          aria-label={strings.room.tileVideo(name)}
          autoPlay
          muted
          playsInline
          $mirrored={you}
        />
      ) : (
        <Initial aria-hidden="true">{[...name][0]?.toUpperCase()}</Initial>
      )}
      {audio && !you && <audio ref={audioRef} autoPlay />}
      <Nameplate>
        {micMuted && (
          <Muted role="img" aria-label={strings.room.micMuted}>
            <MicOffIcon />
          </Muted>
        )}
        {label}
        {reconnecting && <Warn> · {strings.room.reconnecting}</Warn>}
        {relayed && <Quiet> · {strings.room.relayed}</Quiet>}
        {!video && <span className="visually-hidden"> · {strings.room.camOff}</span>}
      </Nameplate>
    </Tile>
  )
}

const Tile = styled.figure`
  position: relative;
  margin: 0;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: ${radius.tile};
  background: linear-gradient(160deg, ${color.tileFrom}, ${color.tileTo});
  display: grid;
  place-items: center;
`

const Video = styled.video<{ $mirrored: boolean }>`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: ${({ $mirrored }) => ($mirrored ? 'scaleX(-1)' : 'none')};
`

const Initial = styled.span`
  font-size: 40px;
  font-weight: 600;
  color: ${color.muted};
`

const Nameplate = styled.figcaption`
  position: absolute;
  display: flex;
  align-items: center;
  gap: ${space(1)};
  left: ${space(2)};
  bottom: ${space(2)};
  padding: ${space(1)} ${space(2)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  color: ${color.fg};
  font-size: ${fontSize.nameplate};

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
`

const Muted = styled.span`
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: ${color.danger};

  svg {
    width: 100%;
    height: 100%;
  }
`

const Warn = styled.span`
  color: ${color.warn};
`

const Quiet = styled.span`
  color: ${color.muted};
`

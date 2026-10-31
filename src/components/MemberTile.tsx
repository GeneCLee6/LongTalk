import { useEffect, useRef } from 'react'
import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'

export interface MemberTileProps {
  name: string
  /** This browser's own tile: mirrored, never plays its own audio */
  you?: boolean
  reconnecting?: boolean
  /** The member's camera (received, or our own local track); null when it is off */
  video: MediaStreamTrack | null
  /** The member's microphone, received; always null on our own tile */
  audio: MediaStreamTrack | null
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
}: MemberTileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  const audioRef = useTrack<HTMLAudioElement>(audio)
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
        {label}
        {reconnecting && <Warn> · {strings.room.reconnecting}</Warn>}
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

const Warn = styled.span`
  color: ${color.warn};
`

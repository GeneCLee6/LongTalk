import { useEffect, useRef } from 'react'
import styled, { css, keyframes } from 'styled-components'
import { setSpeaker } from '../media/devices.ts'
import { strings } from '../strings.ts'
import { avatar, avatarColor, color, fontSize, motion, radius, space } from '../styles/tokens.ts'
import { MicOffIcon, ReconnectIcon, SpeakingIcon } from './icons.tsx'

export interface TileProps {
  name: string
  /** This browser's own tile: mirrored, never plays its own audio, marked 「你」 */
  you?: boolean
  /** The member dropped and may come back (RoomDO keeps them 60 s), or we are reconnecting */
  reconnecting?: boolean
  /** The member's camera (received, or our own local track); null when it is off */
  video: MediaStreamTrack | null
  /** The member's microphone, received; always null on our own tile */
  audio: MediaStreamTrack | null
  /** The microphone is off (muted, or never published): the nameplate shows it (e2-t05) */
  micMuted?: boolean
  /** Their microphone is above the speaking threshold (speaking.ts): the green outline */
  speaking?: boolean
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
 * One member in the room (e4-t04, e4-t05; DESIGN.md §5): their camera, or their initial on a
 * colour from their name; the nameplate bottom-left (muted microphone, speaking mark, name, 「你」);
 * a green outline while they speak; dimmed with a 「重新連線中」 badge while they reconnect. Fills
 * the box the grid gives it. Their microphone plays through a hidden <audio>.
 */
export function Tile({
  name,
  you = false,
  reconnecting = false,
  video,
  audio,
  micMuted = false,
  speaking = false,
  speaker = null,
  relayed = false,
}: TileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  const audioRef = useTrack<HTMLAudioElement>(audio)
  useEffect(() => {
    setSpeaker(audioRef.current, speaker)
  }, [audioRef, audio, speaker])
  const outlined = speaking && !micMuted && !reconnecting
  return (
    <Frame
      aria-label={you ? `${name}（${strings.common.you}）` : name}
      data-speaking={outlined || undefined}
      data-reconnecting={reconnecting || undefined}
      $speaking={outlined}
      $dimmed={reconnecting}
    >
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
        <Avatar aria-hidden="true" style={{ background: avatarColor(name) }}>
          {[...name][0]?.toUpperCase()}
        </Avatar>
      )}
      {audio && !you && <audio ref={audioRef} autoPlay />}
      {reconnecting && (
        <Badge>
          <ReconnectIcon />
          {strings.room.reconnecting}
        </Badge>
      )}
      <Nameplate>
        {micMuted ? (
          <Mark $tone="danger" role="img" aria-label={strings.room.micMuted}>
            <MicOffIcon />
          </Mark>
        ) : (
          outlined && (
            <Mark $tone="speaking" role="img" aria-label={strings.room.speaking}>
              <SpeakingIcon />
            </Mark>
          )
        )}
        <Name>{name}</Name>
        {you && <You>{strings.common.you}</You>}
        {relayed && <Quiet>{strings.room.relayed}</Quiet>}
        {!video && <VisuallyHidden> · {strings.room.camOff}</VisuallyHidden>}
      </Nameplate>
    </Frame>
  )
}

const appear = keyframes`
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: none; }
`

const Frame = styled.figure<{ $speaking: boolean; $dimmed: boolean }>`
  position: relative;
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  border-radius: ${radius.tile};
  background: linear-gradient(160deg, ${color.tileFrom}, ${color.tileTo});
  display: grid;
  place-items: center;
  color: ${color.fg};
  animation: ${appear} ${motion.base} ease-out;

  /* Above the video: the speaking outline (2 px, DESIGN.md §5) */
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 0 2px ${color.speaking};
    opacity: ${({ $speaking }) => ($speaking ? 1 : 0)};
    transition: opacity ${motion.fast} ease-out;
  }

  ${({ $dimmed }) =>
    $dimmed &&
    css`
      & > video,
      & > span[aria-hidden] {
        opacity: 0.4;
        filter: grayscale(0.6);
      }
    `}
`

const Video = styled.video<{ $mirrored: boolean }>`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: ${({ $mirrored }) => ($mirrored ? 'scaleX(-1)' : 'none')};
`

const Avatar = styled.span`
  display: grid;
  place-items: center;
  width: clamp(40px, 28%, 96px);
  aspect-ratio: 1;
  border-radius: 50%;
  color: ${avatar.text};
  font-size: clamp(18px, 4vmin, 36px);
  font-weight: 800;
  line-height: 1;
  user-select: none;
`

const Badge = styled.span`
  position: absolute;
  top: ${space(2)};
  right: ${space(2)};
  display: inline-flex;
  align-items: center;
  gap: ${space(1)};
  padding: ${space(1)} ${space(2)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  color: ${color.warn};
  font-size: ${fontSize.nameplate};
  font-weight: 600;

  svg {
    width: 14px;
    height: 14px;
  }
`

const Nameplate = styled.figcaption`
  position: absolute;
  left: ${space(2)};
  bottom: ${space(2)};
  display: inline-flex;
  align-items: center;
  gap: ${space(1.5)};
  max-width: calc(100% - ${space(4)});
  padding: ${space(1)} ${space(2)};
  border-radius: ${radius.nameplate};
  background: ${color.overlay};
  backdrop-filter: blur(4px);
  color: ${color.fg};
  font-size: ${fontSize.nameplate};
  line-height: 1.3;
`

const Name = styled.span`
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`

const Mark = styled.span<{ $tone: 'danger' | 'speaking' }>`
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  color: ${({ $tone }) => ($tone === 'danger' ? color.danger : color.speaking)};

  svg {
    width: 100%;
    height: 100%;
  }
`

const You = styled.span`
  flex: none;
  padding: 0 ${space(1.5)};
  border-radius: ${radius.pill};
  background: ${color.primarySoft};
  color: ${color.primary};
  font-size: ${fontSize.toolbarLabel};
  font-weight: 700;
`

const Quiet = styled.span`
  flex: none;
  color: ${color.muted};
`

const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

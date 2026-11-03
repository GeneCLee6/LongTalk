import { useContext } from 'react'
import styled, { css, keyframes } from 'styled-components'
import { strings } from '../strings.ts'
import {
  avatar,
  avatarColor,
  color,
  fontSize,
  media,
  motion,
  radius,
  space,
} from '../styles/tokens.ts'
import { MicOffIcon, PinIcon, ReconnectIcon, SpeakingIcon, SpotlightIcon } from './icons.tsx'
import { TileVisibleContext } from './layoutContext.ts'
import { useTrack } from './useTrack.ts'

export interface TileProps {
  name: string
  /** This browser's own tile: mirrored, marked 「你」 */
  you?: boolean
  /** The member dropped and may come back (RoomDO keeps them 60 s), or we are reconnecting */
  reconnecting?: boolean
  /** The member's camera (received, or our own local track); null when it is off */
  video: MediaStreamTrack | null
  /** The microphone is off (muted, or never published): the nameplate shows it (e2-t05) */
  micMuted?: boolean
  /** Their microphone is above the speaking threshold (speaking.ts): the green outline */
  speaking?: boolean
  /** Our own media goes through a TURN relay (e2-t07): a quiet note on our own nameplate */
  relayed?: boolean
  /** We pinned this tile for ourselves (G2, e4-t10): a 「已釘選」 badge */
  pinned?: boolean
  /** A host or co-host spotlighted this member for everyone (G2, e4-t11): a 「聚光燈」 badge */
  spotlighted?: boolean
  /** Pin or unpin it (local): a button top-right, shown on hover or focus (always on touch) */
  onTogglePin?: () => void
  /** Spotlight or end it (a host or co-host only: the room decides, worker/roles.ts) */
  onToggleSpotlight?: () => void
}

/**
 * One member in the room (e4-t04, e4-t05; DESIGN.md §5): their camera, or their initial on a
 * colour from their name; the nameplate bottom-left (muted microphone, speaking mark, name, 「你」);
 * a green outline while they speak; dimmed with a 「重新連線中」 badge while they reconnect. Fills
 * the box the grid gives it. Their microphone plays elsewhere (MemberAudio), so a tile can move
 * between pages or layouts without a gap in the sound. A tile on a page out of view
 * (TileVisibleContext, e4-t07) shows the initial instead of the video until it is back.
 */
export function Tile({
  name,
  you = false,
  reconnecting = false,
  video,
  micMuted = false,
  speaking = false,
  relayed = false,
  pinned = false,
  spotlighted = false,
  onTogglePin,
  onToggleSpotlight,
}: TileProps) {
  const visible = useContext(TileVisibleContext)
  const shown = visible ? video : null
  const videoRef = useTrack<HTMLVideoElement>(shown)
  const outlined = speaking && !micMuted && !reconnecting
  return (
    <Frame
      aria-label={you ? `${name}（${strings.common.you}）` : name}
      data-speaking={outlined || undefined}
      data-reconnecting={reconnecting || undefined}
      $speaking={outlined}
      $dimmed={reconnecting}
    >
      {shown ? (
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
      <Corner>
        {reconnecting && (
          <Badge>
            <ReconnectIcon />
            {strings.room.reconnecting}
          </Badge>
        )}
        {spotlighted && (
          <Badge $tone="brand">
            <SpotlightIcon />
            {strings.view.spotlightBadge}
          </Badge>
        )}
        {pinned && (
          <Badge $tone="brand">
            <PinIcon />
            {strings.view.pinnedBadge}
          </Badge>
        )}
        {(onTogglePin || onToggleSpotlight) && (
          <Actions>
            {onTogglePin && (
              <Action
                type="button"
                aria-label={pinned ? strings.view.unpin(name) : strings.view.pin(name)}
                aria-pressed={pinned}
                title={pinned ? strings.view.unpin(name) : strings.view.pin(name)}
                onClick={onTogglePin}
              >
                <PinIcon />
              </Action>
            )}
            {onToggleSpotlight && (
              <Action
                type="button"
                aria-label={
                  spotlighted ? strings.view.unspotlight(name) : strings.view.spotlight(name)
                }
                aria-pressed={spotlighted}
                title={spotlighted ? strings.view.unspotlight(name) : strings.view.spotlight(name)}
                onClick={onToggleSpotlight}
              >
                <SpotlightIcon />
              </Action>
            )}
          </Actions>
        )}
      </Corner>
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

/** Top-right (DESIGN.md §5: 釘選、舉手在右上): the badges, then the tile's own buttons */
const Corner = styled.div`
  position: absolute;
  top: ${space(2)};
  right: ${space(2)};
  left: ${space(2)};
  display: flex;
  flex-wrap: wrap-reverse;
  justify-content: flex-end;
  align-items: center;
  gap: ${space(1)};
  pointer-events: none;

  & > * {
    pointer-events: auto;
  }
`

const Badge = styled.span<{ $tone?: 'warn' | 'brand' }>`
  display: inline-flex;
  align-items: center;
  gap: ${space(1)};
  padding: ${space(1)} ${space(2)};
  border-radius: ${radius.pill};
  background: ${({ $tone }) => ($tone === 'brand' ? color.primary : color.overlay)};
  color: ${({ $tone }) => ($tone === 'brand' ? color.onPrimary : color.warn)};
  font-size: ${fontSize.nameplate};
  font-weight: 600;
  white-space: nowrap;

  svg {
    width: 14px;
    height: 14px;
  }
`

/**
 * Pin and spotlight: shown while the pointer is over the tile or a button has focus; on a touch
 * screen (no hover) always, small
 */
const Actions = styled.span`
  display: inline-flex;
  gap: ${space(1)};
  opacity: 0;
  transition: opacity ${motion.fast} ease-out;

  figure:hover &,
  &:focus-within {
    opacity: 1;
  }
  @media ${media.touchPrimary} {
    opacity: 1;
  }
`

const Action = styled.button`
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: ${color.overlay};
  color: ${color.fg};
  cursor: pointer;

  svg {
    width: 16px;
    height: 16px;
  }
  &:hover {
    color: ${color.primary};
  }
  &[aria-pressed='true'] {
    background: ${color.primary};
    color: ${color.onPrimary};
  }
  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 2px;
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

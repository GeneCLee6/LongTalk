import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { ScreenShareIcon } from './icons.tsx'
import { useTrack } from './useTrack.ts'
import { useVideoDemand } from './useVideoDemand.ts'

export interface ShareTileProps {
  /** Who shares */
  name: string
  /** Their screen as received; null until it arrives */
  video: MediaStreamTrack | null
}

/**
 * The share in the main area (e3-t03, e3-t05; DESIGN.md §4.3): the whole picture, letterboxed
 * (never cropped: a shared document must show its edges), with a 「<名字> 的畫面」 tag in the
 * brand colour top-left. Until the first frames arrive it says the share is on its way.
 */
export function ShareTile({ name, video }: ShareTileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  // The share's drawn size picks its simulcast layer (e2-t12)
  useVideoDemand(videoRef, video)
  return (
    <Frame aria-label={strings.screenShare.region(name)} data-share-tile="">
      {video ? (
        <Video
          ref={videoRef}
          aria-label={strings.screenShare.region(name)}
          autoPlay
          muted
          playsInline
        />
      ) : (
        <Waiting role="status">
          <ScreenShareIcon />
          {strings.screenShare.waiting(name)}
        </Waiting>
      )}
      <Tag>{strings.screenShare.label(name)}</Tag>
    </Frame>
  )
}

const Frame = styled.figure`
  position: relative;
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  border-radius: ${radius.tile};
  background: ${color.tileTo};
  display: grid;
  place-items: center;
  color: ${color.fg};
`

const Video = styled.video`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
`

const Waiting = styled.p`
  display: grid;
  justify-items: center;
  gap: ${space(2)};
  margin: 0;
  padding: ${space(4)};
  color: ${color.muted};
  font-size: ${fontSize.small};
  text-align: center;

  svg {
    width: 32px;
    height: 32px;
  }
`

/** DESIGN.md §1: 分享＝藍色標籤 (the brand colour), with the name, never colour alone */
const Tag = styled.figcaption`
  position: absolute;
  top: ${space(2.5)};
  left: ${space(2.5)};
  max-width: calc(100% - ${space(5)});
  padding: ${space(1)} ${space(2.5)};
  border-radius: ${radius.pill};
  background: ${color.primary};
  color: ${color.onPrimary};
  font-size: ${fontSize.nameplate};
  font-weight: 700;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`

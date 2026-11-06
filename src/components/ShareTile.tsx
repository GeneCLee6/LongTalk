import { Suspense, lazy, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import styled, { css } from 'styled-components'
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, videoTransform } from '../../shared/shareGeometry.ts'
import { canFullscreen } from '../media/capabilities.ts'
import { strings } from '../strings.ts'
import { color, fontSize, media, motion, radius, space } from '../styles/tokens.ts'
import {
  FullscreenExitIcon,
  FullscreenIcon,
  PenIcon,
  ScreenShareIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './icons.tsx'
import { useTrack } from './useTrack.ts'
import { useVideoDemand } from './useVideoDemand.ts'
import { ShareGeometryContext, useShareViewport } from './useShareGeometry.ts'
import { useShareGestures } from './useShareGestures.ts'

/** Annotation stays out of the room's first load (CLAUDE.md rule 6): loaded on the first press */
const AnnotationCanvas = lazy(() => import('../annotate/AnnotationCanvas.tsx'))

export interface ShareTileProps {
  /** Who shares */
  name: string
  /** Their screen as received; null until it arrives */
  video: MediaStreamTrack | null
  /**
   * A share in the strip (H5, e3-t07): the whole tile is a button that brings it to the main
   * area. Its small size asks for the screen's lower layer (layers.ts)
   */
  onShowMain?: () => void
  /** The main area's picker between several shares (SharePicker), top right */
  picker?: ReactNode
  /** Our member id where we may annotate (shared/roles.ts `annotate`); null: no 標註 button */
  annotator?: string | null
  /**
   * Who records, in words, while anyone does: fullscreen covers the top bar's red light, so the
   * tile says it itself (CLAUDE.md rule 4)
   */
  recording?: string | null
}

/** This element in the browser's fullscreen, and the way in and out */
function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false)
  useEffect(() => {
    const onChange = () => setActive(!!ref.current && document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [ref])
  const toggle = () => {
    if (document.fullscreenElement === ref.current) void document.exitFullscreen?.()
    else void ref.current?.requestFullscreen?.()?.catch(() => undefined)
  }
  return { active, toggle }
}

/**
 * The share in the main area (e3-t03, e3-t05; DESIGN.md §4.3): the whole picture, letterboxed
 * (never cropped: a shared document must show its edges), with a 「<名字> 的畫面」 tag in the
 * brand colour top-left. Until the first frames arrive it says the share is on its way. With
 * several shares (H5), the main one carries the picker and the others sit in the strip, each a
 * button that brings it to the main area.
 *
 * The main one can be zoomed, moved and made fullscreen (e3-t11), with controls bottom right,
 * and useShareGeometry tells anything inside it where the picture ended up. The controls also
 * turn on annotation, for now only as a local sketch (e7-t02; J2 syncs it and adds its toolbar).
 */
export function ShareTile({
  name,
  video,
  onShowMain,
  picker,
  annotator = null,
  recording = null,
}: ShareTileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  const frameRef = useRef<HTMLElement>(null)
  const interactive = !onShowMain && video !== null
  const viewport = useShareViewport(frameRef, videoRef, interactive)
  const { geometry } = viewport
  const { zoom } = geometry.view
  const ready = interactive && geometry.rect !== null
  // The share's drawn size picks its simulcast layer (e2-t12); zoomed in, more of its pixels count
  useVideoDemand(videoRef, video, zoom)
  const fullscreen = useFullscreen(frameRef)
  const fullscreenable = canFullscreen()
  const [annotating, setAnnotating] = useState(false)
  const gestures = useShareGestures(frameRef, viewport, {
    enabled: ready,
    drawing: annotating,
    onToggleFullscreen: fullscreenable ? fullscreen.toggle : undefined,
  })
  const percent = Math.round(zoom * 100)
  return (
    <ShareGeometryContext.Provider value={geometry}>
      <Frame
        ref={frameRef}
        aria-label={strings.screenShare.region(name)}
        data-share-tile=""
        data-zoom={ready ? zoom : undefined}
        tabIndex={ready ? 0 : undefined}
        $grab={ready && zoom > 1 && !annotating}
        $interactive={ready}
        {...gestures}
      >
        {video ? (
          <Video
            ref={videoRef}
            aria-label={strings.screenShare.region(name)}
            autoPlay
            muted
            playsInline
            style={{ transform: videoTransform(geometry.box, geometry.source, geometry.view) }}
          />
        ) : (
          <Waiting role="status">
            <ScreenShareIcon />
            {strings.screenShare.waiting(name)}
          </Waiting>
        )}
        {ready && annotating && annotator !== null && (
          <Suspense fallback={null}>
            <AnnotationCanvas by={annotator} />
          </Suspense>
        )}
        <Tag>{strings.screenShare.label(name)}</Tag>
        {fullscreen.active && recording && <RecordingTag>{recording}</RecordingTag>}
        {picker && <PickerSlot>{picker}</PickerSlot>}
        {ready && (
          // Pressing a control is not the start of a drag or a double-click on the picture
          <Controls
            role="group"
            aria-label={strings.screenShare.viewControls}
            $pinned={zoom > 1 || annotating}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {annotator !== null && (
              <Control
                type="button"
                aria-label={strings.screenShare.annotate}
                title={strings.screenShare.annotateHint}
                aria-pressed={annotating}
                onClick={() => setAnnotating((on) => !on)}
              >
                <PenIcon />
              </Control>
            )}
            <Control
              type="button"
              aria-label={strings.screenShare.zoomOut}
              title={strings.screenShare.zoomOut}
              disabled={zoom <= MIN_ZOOM}
              onClick={() => viewport.zoomTo((now) => now / ZOOM_STEP)}
            >
              <ZoomOutIcon />
            </Control>
            <Percent
              type="button"
              aria-label={strings.screenShare.zoomReset(percent)}
              title={strings.screenShare.zoomReset(percent)}
              disabled={zoom <= MIN_ZOOM}
              onClick={viewport.reset}
            >
              {percent}%
            </Percent>
            <Control
              type="button"
              aria-label={strings.screenShare.zoomIn}
              title={strings.screenShare.zoomIn}
              disabled={zoom >= MAX_ZOOM}
              onClick={() => viewport.zoomTo((now) => now * ZOOM_STEP)}
            >
              <ZoomInIcon />
            </Control>
            {fullscreenable && (
              <Control
                type="button"
                aria-label={
                  fullscreen.active
                    ? strings.screenShare.exitFullscreen
                    : strings.screenShare.fullscreen
                }
                title={
                  fullscreen.active
                    ? strings.screenShare.exitFullscreen
                    : strings.screenShare.fullscreen
                }
                onClick={fullscreen.toggle}
              >
                {fullscreen.active ? <FullscreenExitIcon /> : <FullscreenIcon />}
              </Control>
            )}
          </Controls>
        )}
        {onShowMain && (
          <ShowMain
            type="button"
            aria-label={strings.screenShare.showMain(name)}
            onClick={onShowMain}
          />
        )}
      </Frame>
    </ShareGeometryContext.Provider>
  )
}

const Frame = styled.figure<{ $grab: boolean; $interactive: boolean; $dragging?: boolean }>`
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

  &:fullscreen {
    border-radius: 0;
  }

  ${({ $interactive }) =>
    $interactive &&
    css`
      /* The tile's own pinch and drag, not the browser's */
      touch-action: none;
    `}
  ${({ $grab, $dragging }) =>
    $grab &&
    css`
      cursor: ${$dragging ? 'grabbing' : 'grab'};
    `}
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
  pointer-events: none;
`

/** The top bar's red light where fullscreen hides it: words, and a dot */
const RecordingTag = styled.p`
  position: absolute;
  top: ${space(10)};
  left: ${space(2.5)};
  margin: 0;
  padding: ${space(1)} ${space(2.5)};
  border-radius: ${radius.pill};
  background: ${color.danger};
  color: ${color.onDanger};
  font-size: ${fontSize.nameplate};
  font-weight: 700;
  pointer-events: none;

  &::before {
    content: '● ';
  }
`

const PickerSlot = styled.div`
  position: absolute;
  top: ${space(2)};
  right: ${space(2)};
  max-width: calc(100% - ${space(4)});
`

/**
 * Bottom right, out of the way of the name and the picker on top (and J2's toolbar, DESIGN.md
 * §4.3: 分享格上緣). Shown on hover or focus, always on touch and while the view is changed.
 */
const Controls = styled.div<{ $pinned: boolean }>`
  position: absolute;
  right: ${space(2)};
  bottom: ${space(2)};
  display: flex;
  align-items: center;
  gap: ${space(0.5)};
  padding: ${space(0.5)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  cursor: default;
  opacity: ${({ $pinned }) => ($pinned ? 1 : 0)};
  transition: opacity ${motion.fast} ease-out;

  figure:hover &,
  &:focus-within,
  figure:focus-visible & {
    opacity: 1;
  }
  @media ${media.touchPrimary} {
    opacity: 1;
  }
`

const controlStyle = css`
  display: inline-grid;
  place-items: center;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: ${radius.pill};
  background: transparent;
  color: ${color.fg};
  cursor: pointer;

  &:hover:not(:disabled) {
    background: ${color.hover};
  }
  &:disabled {
    color: ${color.muted};
    cursor: default;
  }
  &[aria-pressed='true'] {
    background: ${color.primary};
    color: ${color.onPrimary};
  }
  @media ${media.touchPrimary} {
    height: 44px;
  }
`

const Control = styled.button`
  ${controlStyle}
  width: 32px;

  svg {
    width: 18px;
    height: 18px;
  }
  @media ${media.touchPrimary} {
    width: 44px;
  }
`

const Percent = styled.button`
  ${controlStyle}
  min-width: 44px;
  font-size: ${fontSize.nameplate};
  font-variant-numeric: tabular-nums;
`

/** The strip share's whole surface: one click (or Enter) brings it to the main area */
const ShowMain = styled.button`
  position: absolute;
  inset: 0;
  border: 0;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }
`

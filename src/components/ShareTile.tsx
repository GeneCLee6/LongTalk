import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react'
import styled from 'styled-components'
import type { ControlEventMessage } from '../../shared/control.ts'
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, videoTransform } from '../../shared/shareGeometry.ts'
import { canFullscreen } from '../media/capabilities.ts'
import type { AnnotationStore } from '../room/annotationStore.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import {
  ComputerIcon,
  DownloadIcon,
  FullscreenExitIcon,
  FullscreenIcon,
  PenIcon,
  ScreenShareIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './icons.tsx'
import {
  Control,
  Controls,
  Frame,
  Percent,
  PickerSlot,
  RecordingTag,
  Tag,
} from './shareChrome.tsx'
import { useFullscreen, useMarked } from './useShareChrome.ts'
import { useTrack } from './useTrack.ts'
import { useVideoDemand } from './useVideoDemand.ts'
import { ShareGeometryContext, useShareViewport } from './useShareGeometry.ts'
import { useShareGestures } from './useShareGestures.ts'

/**
 * Annotation stays out of the room's first load (CLAUDE.md rule 6): loaded on the first press of
 * 標註, or when there is a mark to show
 */
const AnnotationLayer = lazy(() => import('../annotate/AnnotationLayer.tsx'))
const ClearMarks = lazy(() => import('../annotate/ClearMarks.tsx'))
const ExportMarks = lazy(() => import('../annotate/ExportMarks.tsx'))
/** Remote control's capture (N3), only once we control a computer */
const ControlLayer = lazy(() => import('./ControlLayer.tsx'))

/**
 * Remote control of the computer that shares this (N3, e9-t04, e9-t05): what everyone sees, the one
 * button we have, and, once we control it, the capture. RoomDO decides all of it; this only shows.
 */
export interface ShareControl {
  /** Who asks for or holds control now (everyone sees it, CLAUDE.md rule 4); null: nobody */
  status: { text: string; granted: boolean; until: number | null } | null
  /** Request, cancel our request, or stop our control; null for none */
  action: { label: string; title: string; danger?: boolean; onClick: () => void } | null
  /** We hold the grant: the tile sends our pointer and keys */
  capture: { grant: string; send: (message: ControlEventMessage) => void; label: string } | null
}

/** The marks on this share (J2, e7-t04) */
export interface ShareAnnotations {
  store: AnnotationStore
  /** The sharer: which share's layer */
  share: string
  /** Our member id where the room lets us draw (shared/roles.ts mayDraw); null: no 標註 button */
  me: string | null
  /** We may clear it, all of it or one person's (shared/roles.ts mayClearLayer) */
  manage?: boolean
  /** A member's name for the tag beside what they draw */
  nameOf: (memberId: string) => string | null
  /** For an exported file's name (J4, e7-t07) */
  roomName?: string | null
}

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
  /** The marks on this share; a tile without it has none, nor a 標註 button */
  annotations?: ShareAnnotations | null
  /**
   * Who records, in words, while anyone does: fullscreen covers the top bar's red light, so the
   * tile says it itself (CLAUDE.md rule 4)
   */
  recording?: string | null
  /**
   * The sharer's own share, from their own capture and never from the SFU (J3): it says what a
   * browser cannot do. `mirrorRisk`: a whole screen or the meeting itself is shared, so the picture
   * would show itself over and over (e3-t09); it starts hidden, leaving the marks on a blank sheet.
   */
  own?: { mirrorRisk: boolean } | null
  /**
   * The sharer is a desktop agent (N2, e9-t02): the tag is its name, 「<owner> 的電腦」, with a
   * computer, rather than 「… 的畫面」
   */
  computer?: boolean
  /** The computer's remote control (N3); absent for a person's share */
  control?: ShareControl | null
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
 * bring out the annotation tools (J2, e7-t03). The marks on a share show on any tile that shows
 * it, the strip's too, whether or not the tools are out.
 *
 * The sharer can open their own share here too (J3, `own`), to see and add to the marks.
 */
export function ShareTile({
  name,
  video,
  onShowMain,
  picker,
  annotations = null,
  recording = null,
  own = null,
  computer = false,
  control = null,
}: ShareTileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  const frameRef = useRef<HTMLElement>(null)
  const capture = !onShowMain && video !== null ? (control?.capture ?? null) : null
  const interactive = !onShowMain && video !== null
  // Measured with a picture on any tile: marks line up on a strip share too, which has no gestures
  const viewport = useShareViewport(frameRef, videoRef, video !== null)
  const { geometry } = viewport
  const { zoom } = geometry.view
  const ready = interactive && geometry.rect !== null
  // The share's drawn size picks its simulcast layer (e2-t12); zoomed in, more of its pixels count
  useVideoDemand(videoRef, video, zoom)
  const fullscreen = useFullscreen(frameRef)
  const fullscreenable = canFullscreen()
  // No drawing while our pointer controls the computer (N3)
  const annotator = capture === null ? (annotations?.me ?? null) : null
  const [toolsOut, setToolsOut] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  // The room may take the tools away while they are out (J3): the button goes, and so do they
  const annotating = toolsOut && annotator !== null
  const marked = useMarked(annotations?.store, annotations?.share)
  const [pictureOn, setPictureOn] = useState(!own?.mirrorRisk)
  // Stays once there has been something to show: nothing flickers as the last mark fades
  const [hasMarks, setHasMarks] = useState(false)
  if (marked && !hasMarks) setHasMarks(true)
  const gestures = useShareGestures(frameRef, viewport, {
    // Our pointer goes to the computer we control, not to zooming and panning the picture (N3)
    enabled: ready && capture === null,
    drawing: annotating,
    onToggleFullscreen: fullscreenable ? fullscreen.toggle : undefined,
  })
  const percent = Math.round(zoom * 100)
  const text = strings.screenShare
  const region = own ? text.ownRegion : text.region(name)
  return (
    <ShareGeometryContext.Provider value={geometry}>
      <Frame
        ref={frameRef}
        aria-label={region}
        data-share-tile=""
        data-own-share={own ? '' : undefined}
        data-zoom={ready ? zoom : undefined}
        tabIndex={ready ? 0 : undefined}
        $grab={ready && zoom > 1 && !annotating}
        $interactive={ready}
        {...gestures}
      >
        {video ? (
          <Video
            ref={videoRef}
            aria-label={region}
            autoPlay
            muted
            playsInline
            $hidden={own !== null && !pictureOn}
            style={{ transform: videoTransform(geometry.box, geometry.source, geometry.view) }}
          />
        ) : (
          <Waiting role="status">
            <ScreenShareIcon />
            {strings.screenShare.waiting(name)}
          </Waiting>
        )}
        {annotations && geometry.rect !== null && (hasMarks || (ready && annotating)) && (
          <Suspense fallback={null}>
            <AnnotationLayer {...annotations} editing={ready && annotating} />
          </Suspense>
        )}
        <Tag>
          {computer && !own && (
            <TagIcon>
              <ComputerIcon />
            </TagIcon>
          )}
          {own ? text.ownLabel : computer ? name : text.label(name)}
        </Tag>
        {fullscreen.active && recording && <RecordingTag>{recording}</RecordingTag>}
        {capture && geometry.rect !== null && (
          <Suspense fallback={null}>
            <ControlLayer key={capture.grant} {...capture} />
          </Suspense>
        )}
        {!onShowMain && control && (control.status || control.action) && (
          <ControlBar>
            {control.status && (
              <ControlStatus role="status" $granted={control.status.granted}>
                {control.status.text}
                {control.status.until !== null && <Countdown until={control.status.until} />}
              </ControlStatus>
            )}
            {control.action && (
              <Button
                variant={control.action.danger ? 'danger' : 'secondary'}
                title={control.action.title}
                onClick={control.action.onClick}
              >
                {control.action.label}
              </Button>
            )}
          </ControlBar>
        )}
        {picker && <PickerSlot>{picker}</PickerSlot>}
        {own && (
          <OwnNote>
            <p>{text.ownLimit}</p>
            {own.mirrorRisk && !pictureOn && <p>{text.ownHidden}</p>}
            {own.mirrorRisk && (
              <Button variant="secondary" onClick={() => setPictureOn((on) => !on)}>
                {pictureOn ? text.ownHidePicture : text.ownShowPicture}
              </Button>
            )}
          </OwnNote>
        )}
        {ready && (
          <Controls
            role="group"
            aria-label={strings.screenShare.viewControls}
            $pinned={zoom > 1 || annotating}
          >
            {annotations?.manage && marked && (
              <Suspense fallback={null}>
                <ClearMarks
                  store={annotations.store}
                  layer={annotations.share}
                  nameOf={annotations.nameOf}
                />
              </Suspense>
            )}
            {annotations && (
              <Control
                type="button"
                aria-label={strings.annotation.exportButton}
                title={strings.annotation.exportButton}
                aria-haspopup="dialog"
                onClick={() => setExportOpen(true)}
              >
                <DownloadIcon />
              </Control>
            )}
            {annotator !== null && (
              <Control
                type="button"
                aria-label={strings.screenShare.annotate}
                title={strings.screenShare.annotateHint}
                aria-pressed={annotating}
                onClick={() => setToolsOut((on) => !on)}
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
        {annotations && exportOpen && (
          <Suspense fallback={null}>
            <ExportMarks
              store={annotations.store}
              layer={annotations.share}
              roomName={annotations.roomName ?? null}
              source={{
                kind: 'share',
                video: () => videoRef.current,
                picture: own === null || pictureOn,
              }}
              onClose={() => setExportOpen(false)}
            />
          </Suspense>
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

/** 「剩 9:41」, ticking each second until `until` (the room's clock: seconds off at most) */
function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((until - now) / 1000))
  const left = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return <> · {strings.control.remaining(left)}</>
}

/** Bottom left, away from the view controls: who controls, and our one button (N3) */
const ControlBar = styled.div`
  position: absolute;
  left: ${space(2)};
  bottom: ${space(2)};
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(1.5)};
  max-width: calc(100% - ${space(4)} - 200px);
`

const ControlStatus = styled.p<{ $granted: boolean }>`
  margin: 0;
  padding: ${space(1)} ${space(2.5)};
  border-radius: ${radius.pill};
  background: ${({ $granted }) => ($granted ? color.danger : color.overlay)};
  color: ${({ $granted }) => ($granted ? color.onDanger : color.fg)};
  font-size: ${fontSize.nameplate};
  font-weight: 700;
  pointer-events: none;
`

const Video = styled.video<{ $hidden: boolean }>`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  /* Still playing, so the tile knows the picture's shape: only never painted (no mirror) */
  ${({ $hidden }) => ($hidden ? 'visibility: hidden;' : '')}
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

/** The limit, bottom left and away from the controls: never over what is being pointed at for long */
const OwnNote = styled.div`
  position: absolute;
  left: ${space(2)};
  bottom: ${space(2)};
  display: grid;
  justify-items: start;
  gap: ${space(1)};
  max-width: min(46%, 360px);
  padding: ${space(1.5)} ${space(2.5)};
  border-radius: ${radius.button};
  background: ${color.overlay};
  color: ${color.fg};
  font-size: ${fontSize.nameplate};
  line-height: 1.4;
  pointer-events: none;

  p {
    margin: 0;
  }
  button {
    pointer-events: auto;
  }
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

/** The computer before a desktop agent's name on the tag (N2) */
const TagIcon = styled.span`
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: ${space(1)};
  vertical-align: -2px;

  svg {
    width: 100%;
    height: 100%;
  }
`

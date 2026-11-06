import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import styled from 'styled-components'
import { WHITEBOARD_LAYER } from '../../shared/annotation.ts'
import {
  BOARD_HOME,
  BOARD_MAX_ZOOM,
  BOARD_MIN_ZOOM,
  boardGrid,
  boardPanBy,
  boardRect,
  boardZoomAt,
  clampBoardView,
} from '../../shared/boardGeometry.ts'
import {
  ZOOM_STEP,
  contentToTile,
  tileToContent,
  type Rect,
  type ShareView,
  type Size,
} from '../../shared/shareGeometry.ts'
import { canFullscreen } from '../media/capabilities.ts'
import {
  CloseIcon,
  FullscreenExitIcon,
  FullscreenIcon,
  GridIcon,
  PenIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '../components/icons.tsx'
import {
  Control,
  Controls,
  Frame,
  Percent,
  PickerSlot,
  RecordingTag,
  Tag,
} from '../components/shareChrome.tsx'
import { useFullscreen, useMarked } from '../components/useShareChrome.ts'
import {
  ShareGeometryContext,
  usePixelRatio,
  type ShareGeometry,
  type ShareViewport,
} from '../components/useShareGeometry.ts'
import { useShareGestures } from '../components/useShareGestures.ts'
import type { AnnotationStore } from '../room/annotationStore.ts'
import { strings } from '../strings.ts'
import { annotation, color, fontSize, radius, space } from '../styles/tokens.ts'
import AnnotationLayer from './AnnotationLayer.tsx'
import ClearMarks from './ClearMarks.tsx'

export interface WhiteboardProps {
  store: AnnotationStore
  /** Our member id where the room lets us draw (shared/roles.ts mayDraw); null: we only watch */
  me: string | null
  /** We may clear it, all of it or one person's (shared/roles.ts mayClearLayer) */
  manage: boolean
  nameOf: (memberId: string) => string | null
  /** The picker between what can be in the main area, when there is more than one thing */
  picker?: ReactNode
  /** Who records, in words: fullscreen covers the top bar's red light (CLAUDE.md rule 4) */
  recording?: string | null
  /** Takes the board off the stage for everyone; absent for who may not */
  onClose?: () => void
}

/** The board's "picture": a square, so the engine's aspect is 1 and x and y share one unit */
const UNIT_SQUARE: Size = { width: 1, height: 1 }

/** Where each room's viewer left the board: it comes back from the strip the way it went */
const lastViews = new WeakMap<AnnotationStore, ShareView>()

/**
 * The board's view (J3, e7-t06), in the shape a share's viewport has (useShareViewport): the same
 * gestures, canvas and text box drive it, and world coordinates go wherever content coordinates
 * go. Each person pans and zooms on their own; only the strokes are shared.
 */
function useBoardViewport(
  frameRef: RefObject<HTMLElement | null>,
  store: AnnotationStore,
): ShareViewport {
  const [box, setBox] = useState<Size>({ width: 0, height: 0 })
  const [view, setView] = useState<ShareView>(() => lastViews.get(store) ?? BOARD_HOME)
  const pixelRatio = usePixelRatio()
  lastViews.set(store, view)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const measure = () => {
      const { width, height } = frame.getBoundingClientRect()
      setBox((now) => (now.width === width && now.height === height ? now : { width, height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [frameRef])

  const rect: Rect | null = useMemo(
    () => (box.width > 0 && box.height > 0 ? boardRect(box, view) : null),
    [box, view],
  )

  const geometry = useMemo<ShareGeometry>(() => {
    const origin = () => frameRef.current?.getBoundingClientRect() ?? null
    return {
      box,
      source: UNIT_SQUARE,
      view,
      rect,
      pixelRatio,
      clientToContent: (clientX, clientY) => {
        const at = origin()
        return at && rect
          ? tileToContent(rect, { x: clientX - at.left, y: clientY - at.top })
          : null
      },
      contentToClient: (point) => {
        const at = origin()
        if (!at || !rect) return null
        const tile = contentToTile(rect, point)
        return { x: tile.x + at.left, y: tile.y + at.top }
      },
    }
  }, [box, view, rect, pixelRatio, frameRef])

  const zoomTo = useCallback<ShareViewport['zoomTo']>(
    (zoom, anchor) =>
      setView((now) => {
        const from = clampBoardView(now)
        const next = typeof zoom === 'function' ? zoom(from.zoom) : zoom
        return boardZoomAt(box, from, next, anchor)
      }),
    [box],
  )
  const panBy = useCallback<ShareViewport['panBy']>(
    (dx, dy) => setView((now) => boardPanBy(now, dx, dy)),
    [],
  )
  const reset = useCallback(() => setView(BOARD_HOME), [])

  return { geometry, zoomTo, panBy, reset }
}

/**
 * The whiteboard (J3, e7-t06; DESIGN.md §4.3): the annotation engine on a pale, endless sheet instead
 * of over a share. Its own lazy chunk (CLAUDE.md rule 6). It takes the main area the way a share
 * does, and a person who may draw has the pen out from the start: turning it off makes a drag move
 * the sheet. The wheel and two fingers zoom at any time, the arrow keys and + − 0 too. Saving and
 * exporting it are J4 (e7-t07, e7-t08); touch details too (e7-t09).
 */
export default function Whiteboard({
  store,
  me,
  manage,
  nameOf,
  picker,
  recording = null,
  onClose,
}: WhiteboardProps) {
  const frameRef = useRef<HTMLElement>(null)
  const viewport = useBoardViewport(frameRef, store)
  const { geometry } = viewport
  const { zoom } = geometry.view
  const [penOut, setPenOut] = useState(true)
  const [gridOn, setGridOn] = useState(true)
  const fullscreen = useFullscreen(frameRef)
  const fullscreenable = canFullscreen()
  const marked = useMarked(store, WHITEBOARD_LAYER)
  const drawing = penOut && me !== null
  const gestures = useShareGestures(frameRef, viewport, {
    enabled: geometry.rect !== null,
    drawing,
    onToggleFullscreen: fullscreenable ? fullscreen.toggle : undefined,
    alwaysPans: true,
  })
  const percent = Math.round(zoom * 100)
  const board = strings.whiteboard
  const view = strings.screenShare
  const grid = geometry.rect && gridOn ? boardGrid(geometry.rect) : null
  return (
    <ShareGeometryContext.Provider value={geometry}>
      <Sheet
        ref={frameRef}
        aria-label={board.region}
        data-whiteboard=""
        data-grid={gridOn ? 'on' : 'off'}
        data-zoom={zoom}
        tabIndex={0}
        $grab={!drawing}
        $interactive
        style={
          grid
            ? {
                backgroundSize: `${grid.size}px ${grid.size}px`,
                backgroundPosition: `${grid.x}px ${grid.y}px`,
              }
            : { backgroundImage: 'none' }
        }
        {...gestures}
      >
        {geometry.rect !== null && (
          <AnnotationLayer
            store={store}
            share={WHITEBOARD_LAYER}
            me={me}
            nameOf={nameOf}
            editing={drawing}
          />
        )}
        <Tag>{board.label}</Tag>
        {fullscreen.active && recording && <RecordingTag>{recording}</RecordingTag>}
        {picker && <PickerSlot>{picker}</PickerSlot>}
        {me === null && <ViewOnly role="status">{board.viewOnly}</ViewOnly>}
        <Controls role="group" aria-label={board.viewControls} $pinned>
          {me !== null && (
            <Control
              type="button"
              aria-label={board.pen}
              title={board.penHint}
              aria-pressed={penOut}
              onClick={() => setPenOut((on) => !on)}
            >
              <PenIcon />
            </Control>
          )}
          <Control
            type="button"
            aria-label={view.zoomOut}
            title={view.zoomOut}
            disabled={zoom <= BOARD_MIN_ZOOM}
            onClick={() => viewport.zoomTo((now) => now / ZOOM_STEP)}
          >
            <ZoomOutIcon />
          </Control>
          <Percent
            type="button"
            aria-label={board.home(percent)}
            title={board.home(percent)}
            onClick={viewport.reset}
          >
            {percent}%
          </Percent>
          <Control
            type="button"
            aria-label={view.zoomIn}
            title={view.zoomIn}
            disabled={zoom >= BOARD_MAX_ZOOM}
            onClick={() => viewport.zoomTo((now) => now * ZOOM_STEP)}
          >
            <ZoomInIcon />
          </Control>
          <Control
            type="button"
            aria-label={board.grid}
            title={board.grid}
            aria-pressed={gridOn}
            onClick={() => setGridOn((on) => !on)}
          >
            <GridIcon />
          </Control>
          {fullscreenable && (
            <Control
              type="button"
              aria-label={fullscreen.active ? view.exitFullscreen : view.fullscreen}
              title={fullscreen.active ? view.exitFullscreen : view.fullscreen}
              onClick={fullscreen.toggle}
            >
              {fullscreen.active ? <FullscreenExitIcon /> : <FullscreenIcon />}
            </Control>
          )}
          {manage && marked && (
            <ClearMarks store={store} layer={WHITEBOARD_LAYER} nameOf={nameOf} />
          )}
          {onClose && (
            <Control type="button" aria-label={board.close} title={board.closeHint} onClick={onClose}>
              <CloseIcon />
            </Control>
          )}
        </Controls>
      </Sheet>
    </ShareGeometryContext.Provider>
  )
}

/** A pale sheet in the dark room: tokens.ts `annotation`, the same whichever scheme the page has */
const Sheet = styled(Frame)`
  background-color: ${annotation.boardPaper};
  background-image:
    linear-gradient(${annotation.boardGrid} 1px, transparent 1px),
    linear-gradient(90deg, ${annotation.boardGrid} 1px, transparent 1px);
`

const ViewOnly = styled.p`
  position: absolute;
  left: ${space(2.5)};
  bottom: ${space(2.5)};
  max-width: 50%;
  margin: 0;
  padding: ${space(1)} ${space(2.5)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  color: ${color.fg};
  font-size: ${fontSize.nameplate};
  pointer-events: none;
`

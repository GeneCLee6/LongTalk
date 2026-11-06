// Where the whiteboard's world is on screen (J3, e7-t06): the same three things as a share
// (shared/shareGeometry.ts), a tile, a view and a rectangle, with no picture to stay inside. The
// board's "picture" is one world unit square, BOARD_UNIT_PX across at 100%, drawn wherever the view
// puts it; a point at world (1.2, -0.4) is simply outside that square. So everything that maps a
// stroke through a rectangle (src/annotate/draw.ts, shareGeometry's contentToTile, tileToContent)
// works unchanged, and a stroke's thickness, a share of the short side, is in world units too.
//
// Coordinate systems:
// - world: what the board's strokes store; (0, 0) is the middle of everyone's first view;
// - tile: CSS px from the board tile's top-left corner.

import { BOARD_EXTENT } from './annotation-limits.ts'
import { MAX_ZOOM, type Point, type Rect, type ShareView, type Size } from './shareGeometry.ts'

/** One world unit on screen at 100%: a line 0.6% of it is 6 px, a medium text mark 34 px */
export const BOARD_UNIT_PX = 1000
/** PRD E7: 25%–400% */
export const BOARD_MIN_ZOOM = 0.25
export const BOARD_MAX_ZOOM = MAX_ZOOM
/** Everyone starts here: the world's centre at 100%, whatever the size of their screen */
export const BOARD_HOME: ShareView = { zoom: 1, cx: 0, cy: 0 }

/** The grid's spacing at 100%, world units (50 px) */
export const BOARD_GRID_STEP = 0.05
/** Grid lines closer than this on screen get doubled: a far zoom is not a grey wash */
const BOARD_GRID_MIN_PX = 20

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export const clampBoardZoom = (zoom: number): number =>
  Number.isFinite(zoom) ? clamp(zoom, BOARD_MIN_ZOOM, BOARD_MAX_ZOOM) : 1

/** The nearest view allowed: zoom within bounds, the centre inside the world */
export function clampBoardView(view: ShareView): ShareView {
  return {
    zoom: clampBoardZoom(view.zoom),
    cx: clamp(Number.isFinite(view.cx) ? view.cx : 0, -BOARD_EXTENT, BOARD_EXTENT),
    cy: clamp(Number.isFinite(view.cy) ? view.cy : 0, -BOARD_EXTENT, BOARD_EXTENT),
  }
}

/** The world unit square on screen under this view: the rectangle everything is mapped through */
export function boardRect(box: Size, view: ShareView): Rect {
  const { zoom, cx, cy } = clampBoardView(view)
  const side = BOARD_UNIT_PX * zoom
  return { x: box.width / 2 - cx * side, y: box.height / 2 - cy * side, width: side, height: side }
}

/** The view at another zoom, with the world under `anchor` (tile px) staying where it is */
export function boardZoomAt(
  box: Size,
  view: ShareView,
  zoom: number,
  anchor: Point = { x: box.width / 2, y: box.height / 2 },
): ShareView {
  const before = boardRect(box, view)
  const held = {
    x: (anchor.x - before.x) / before.width,
    y: (anchor.y - before.y) / before.height,
  }
  const next = clampBoardZoom(zoom)
  const side = BOARD_UNIT_PX * next
  return clampBoardView({
    zoom: next,
    cx: held.x + (box.width / 2 - anchor.x) / side,
    cy: held.y + (box.height / 2 - anchor.y) / side,
  })
}

/** The view with the world moved by (dx, dy) tile px */
export function boardPanBy(view: ShareView, dx: number, dy: number): ShareView {
  const { zoom, cx, cy } = clampBoardView(view)
  const side = BOARD_UNIT_PX * zoom
  return clampBoardView({ zoom, cx: cx - dx / side, cy: cy - dy / side })
}

/** The grid at this zoom: its spacing on screen, and where its lines start in the tile */
export function boardGrid(rect: Rect): { size: number; x: number; y: number } {
  let size = BOARD_GRID_STEP * rect.width
  while (size < BOARD_GRID_MIN_PX) size *= 2
  const wrap = (value: number) => ((value % size) + size) % size
  return { size, x: wrap(rect.x), y: wrap(rect.y) }
}

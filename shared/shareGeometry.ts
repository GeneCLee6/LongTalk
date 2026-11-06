// Where a shared screen's picture really is (e3-t11; E7 needs it to line annotations up): pure
// functions over three things: the tile (the box the <video> fills, CSS px), the source (the
// picture's own size) and the view (zoom and what it is centred on). A share is letterboxed, never
// cropped (`object-fit: contain`), so the picture rarely fills its tile; zooming and panning move
// it further.
//
// The view keeps its centre in content coordinates (0–1 across the picture), not pixels, so a
// resize, a fullscreen or a new simulcast layer keeps the same part of the picture in the middle
// without any bookkeeping.
//
// Coordinate systems:
// - content: 0–1 across the picture (x of its width, y of its height); what annotations store;
// - tile: CSS px from the tile's top-left corner;
// - device: canvas pixels, tile × devicePixelRatio.

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Rect extends Point, Size {}

export interface ShareView {
  /** 1 fits the whole picture in the tile */
  zoom: number
  /** The content point at the tile's centre */
  cx: number
  cy: number
}

export const FIT_VIEW: ShareView = { zoom: 1, cx: 0.5, cy: 0.5 }

export const MIN_ZOOM = 1
/** Past this a 1080p share is mush, and the whiteboard's range stops here too (PRD E7: 400%) */
export const MAX_ZOOM = 4
/** One press of + or − */
export const ZOOM_STEP = 1.25

const usable = (size: Size | null | undefined): size is Size =>
  !!size && size.width > 0 && size.height > 0

/** The picture letterboxed in the tile (`object-fit: contain`), null before there is one */
export function containRect(box: Size, source: Size | null): Rect | null {
  if (!usable(box) || !usable(source)) return null
  const aspect = source.width / source.height
  // One side fills the tile exactly, the other follows from the picture's shape
  const fitsWidth = box.width / box.height <= aspect
  const width = fitsWidth ? box.width : box.height * aspect
  const height = fitsWidth ? box.width / aspect : box.height
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height }
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** Within bounds; a hair above 100% (the end of a wheel gesture) is 100% */
export const clampZoom = (zoom: number): number =>
  Number.isFinite(zoom) && zoom >= MIN_ZOOM * 1.01 ? Math.min(zoom, MAX_ZOOM) : MIN_ZOOM

/**
 * One axis of the view: the picture never leaves a gap it could fill. Smaller than the tile, it
 * stays centred; larger, its edge stops at the tile's edge.
 */
function clampCentre(centre: number, shown: number, room: number): number {
  // Allowing for rounding: a picture exactly filling the tile counts as fitting it
  if (shown <= room + 1e-6) return 0.5
  const half = room / (2 * shown)
  return clamp(Number.isFinite(centre) ? centre : 0.5, half, 1 - half)
}

/** The nearest view that fits the rules: zoom within bounds, no needless gap */
export function clampView(box: Size, source: Size | null, view: ShareView): ShareView {
  const zoom = clampZoom(view.zoom)
  const fit = containRect(box, source)
  if (!fit) return { zoom, cx: 0.5, cy: 0.5 }
  return {
    zoom,
    cx: clampCentre(view.cx, fit.width * zoom, box.width),
    cy: clampCentre(view.cy, fit.height * zoom, box.height),
  }
}

/** Where the picture is drawn in the tile under this view; null before there is one */
export function contentRect(
  box: Size,
  source: Size | null,
  view: ShareView = FIT_VIEW,
): Rect | null {
  const fit = containRect(box, source)
  if (!fit) return null
  const { zoom, cx, cy } = clampView(box, source, view)
  const width = fit.width * zoom
  const height = fit.height * zoom
  return { x: box.width / 2 - cx * width, y: box.height / 2 - cy * height, width, height }
}

/**
 * The view at another zoom with the content under `anchor` (tile px) staying where it is: what
 * zooming at the cursor or between two fingers means
 */
export function zoomAt(
  box: Size,
  source: Size | null,
  view: ShareView,
  zoom: number,
  anchor: Point = { x: box.width / 2, y: box.height / 2 },
): ShareView {
  const before = contentRect(box, source, view)
  const fit = containRect(box, source)
  if (!before || !fit) return clampView(box, source, { ...view, zoom })
  const next = clampZoom(zoom)
  const width = fit.width * next
  const height = fit.height * next
  const held = tileToContent(before, anchor)
  return clampView(box, source, {
    zoom: next,
    cx: (box.width / 2 - anchor.x) / width + held.x,
    cy: (box.height / 2 - anchor.y) / height + held.y,
  })
}

/** The view with the picture moved by (dx, dy) tile px, as far as it can go */
export function panBy(
  box: Size,
  source: Size | null,
  view: ShareView,
  dx: number,
  dy: number,
): ShareView {
  const rect = contentRect(box, source, view)
  if (!rect) return clampView(box, source, view)
  const { zoom, cx, cy } = clampView(box, source, view)
  return clampView(box, source, { zoom, cx: cx - dx / rect.width, cy: cy - dy / rect.height })
}

/** Content (0–1) to tile px */
export function contentToTile(rect: Rect, point: Point): Point {
  return { x: rect.x + point.x * rect.width, y: rect.y + point.y * rect.height }
}

/** Tile px to content (outside 0–1 when the point is off the picture) */
export function tileToContent(rect: Rect, point: Point): Point {
  return { x: (point.x - rect.x) / rect.width, y: (point.y - rect.y) / rect.height }
}

const ratioOf = (pixelRatio: number) =>
  Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1

/** Content (0–1) to device pixels, for drawing on a canvas that fills the tile */
export function contentToDevice(rect: Rect, pixelRatio: number, point: Point): Point {
  const ratio = ratioOf(pixelRatio)
  const tile = contentToTile(rect, point)
  return { x: tile.x * ratio, y: tile.y * ratio }
}

/** Device pixels on that canvas back to content */
export function deviceToContent(rect: Rect, pixelRatio: number, point: Point): Point {
  const ratio = ratioOf(pixelRatio)
  return tileToContent(rect, { x: point.x / ratio, y: point.y / ratio })
}

export const insideContent = (point: Point): boolean =>
  point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1

/** A canvas's backing store for a tile: whole pixels, at least one */
export function backingSize(box: Size, pixelRatio: number): Size {
  const ratio = ratioOf(pixelRatio)
  return {
    width: Math.max(1, Math.round(box.width * ratio)),
    height: Math.max(1, Math.round(box.height * ratio)),
  }
}

/**
 * The CSS transform that puts a <video> filling the tile (`object-fit: contain`) at this view:
 * it scales around the tile's centre, then moves the picture's centre to where the view wants it
 */
export function videoTransform(box: Size, source: Size | null, view: ShareView): string {
  const rect = contentRect(box, source, view)
  if (!rect) return 'none'
  const { zoom } = clampView(box, source, view)
  if (zoom === 1) return 'none'
  const dx = rect.x + rect.width / 2 - box.width / 2
  const dy = rect.y + rect.height / 2 - box.height / 2
  return `translate(${dx}px, ${dy}px) scale(${zoom})`
}

/** Wheel events by unit (WheelEvent.deltaMode): pixels, lines, pages */
const LINE_PX = 16
const PAGE_PX = 400
/** How fast each kind of wheel zooms: a pinch on a trackpad arrives as ctrl + small deltas */
const WHEEL_RATE = 0.002
const PINCH_RATE = 0.01

/** The zoom factor one wheel event stands for: scrolling up or pinching out zooms in */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const pixels = deltaY * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1)
  return Math.exp(-pixels * (pinch ? PINCH_RATE : WHEEL_RATE))
}

// Annotations on a share (E7, e7-t01): vector marks in content coordinates (0–1 across the shared
// picture, x of its width, y of its height), so they line up on every viewer whatever the tile's
// shape, the zoom or the layer received. Pure functions only: the canvas (src/annotate/) draws
// these, RoomDO will validate and keep them (J2, e7-t04: `parseStroke`, the list functions) and
// the toolbar will use the hit test as its eraser (J2, e7-t03).
//
// A point's x and y have different units when the picture is not square, so anything measuring
// distance (simplifying, hit-testing) takes the picture's aspect (width / height) and measures in
// units of the picture's height.

import { normalizeChatText } from './chat.ts'

export const ANNOTATION_TOOLS = ['pen', 'highlighter', 'arrow', 'rect', 'text'] as const
export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number]

/** PRD E7: eight colours. Their values are src/styles/tokens.ts `annotation.colors` */
export const ANNOTATION_COLORS = [
  'rose',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'white',
  'ink',
] as const
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number]

/** PRD E7: three widths */
export const ANNOTATION_WIDTHS = ['thin', 'medium', 'thick'] as const
export type AnnotationWidth = (typeof ANNOTATION_WIDTHS)[number]

/** [x, y], each 0–1 across the picture */
export type NormPoint = readonly [number, number]

export interface Stroke {
  id: string
  /** The member who drew it (the room stamps it, J2) */
  by: string
  tool: AnnotationTool
  color: AnnotationColor
  width: AnnotationWidth
  /**
   * pen, highlighter: the path. arrow: tail, head. rect: two opposite corners. text: its top-left
   */
  points: NormPoint[]
  /** text only */
  text?: string
}

/** PRD E7 risk table: one share keeps at most this many (what happens past it: putStroke) */
export const MAX_STROKES = 2000
/**
 * One stroke's points after thinning: a full stroke must fit one client message (J2 sends it
 * whole at the end, MAX_CLIENT_MESSAGE_CHARS), each point being at most `[0.1234,0.5678],`
 */
export const MAX_STROKE_POINTS = 800
/** A text mark's length, characters (normalizeChatText's rules otherwise) */
export const MAX_ANNOTATION_TEXT_CHARS = 500
/** An id's length: a stroke id is made here, but J2 reads it off the wire */
export const MAX_STROKE_ID_CHARS = 40
/** 4 decimals: 0.2 px across a 1080p picture, and short on the wire */
const PRECISION = 10_000
/** A new point this close to the last (of the picture's height) adds nothing */
export const MIN_POINT_DISTANCE = 0.001
/** How far simplifying may move a path (of the picture's height): about 1.5 px at 1080p */
export const SIMPLIFY_TOLERANCE = 0.0015
/** The eraser's reach beyond a stroke's edge (of the picture's height) */
export const HIT_TOLERANCE = 0.01

/** Line thickness as a share of the picture's short side, so it looks the same on every viewer */
const LINE_WIDTH: Readonly<Record<AnnotationWidth, number>> = {
  thin: 0.003,
  medium: 0.006,
  thick: 0.012,
}
/** A highlighter is broader than a pen of the same width */
const HIGHLIGHTER_SCALE = 4
/** A text mark's font size as a share of the picture's short side */
const TEXT_SIZE: Readonly<Record<AnnotationWidth, number>> = {
  thin: 0.024,
  medium: 0.034,
  thick: 0.05,
}
/** An arrow head's length, in line thicknesses, and its least (of the picture's short side) */
const ARROW_HEAD_LINES = 4
const ARROW_HEAD_MIN = 0.02

export const DEFAULT_ANNOTATION_COLOR: AnnotationColor = 'rose'
export const DEFAULT_ANNOTATION_WIDTH: AnnotationWidth = 'medium'

/** A stroke's line thickness as a share of the picture's short side */
export function lineWidthRatio(stroke: Pick<Stroke, 'tool' | 'width'>): number {
  const base = LINE_WIDTH[stroke.width]
  return stroke.tool === 'highlighter' ? base * HIGHLIGHTER_SCALE : base
}

/** A text mark's font size as a share of the picture's short side */
export const textSizeRatio = (width: AnnotationWidth): number => TEXT_SIZE[width]

/** An arrow head's length as a share of the picture's short side */
export const arrowHeadRatio = (width: AnnotationWidth): number =>
  Math.max(LINE_WIDTH[width] * ARROW_HEAD_LINES, ARROW_HEAD_MIN)

const roundCoord = (value: number) =>
  Math.round(Math.min(Math.max(value, 0), 1) * PRECISION) / PRECISION

/** A point kept on the picture, at the stored precision; null when it is not a number */
export function normalizePoint(x: number, y: number): NormPoint | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return [roundCoord(x), roundCoord(y)]
}

/** Distance in units of the picture's height */
function distance(a: NormPoint, b: NormPoint, aspect: number): number {
  return Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1])
}

/** From `point` to the segment a–b, in units of the picture's height */
function distanceToSegment(point: NormPoint, a: NormPoint, b: NormPoint, aspect: number): number {
  const ax = a[0] * aspect
  const bx = b[0] * aspect
  const px = point[0] * aspect
  const dx = bx - ax
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(px - ax, point[1] - a[1])
  const along = Math.min(1, Math.max(0, ((px - ax) * dx + (point[1] - a[1]) * dy) / lengthSquared))
  return Math.hypot(px - (ax + along * dx), point[1] - (a[1] + along * dy))
}

const usableAspect = (aspect: number) => (Number.isFinite(aspect) && aspect > 0 ? aspect : 1)

/**
 * Ramer–Douglas–Peucker: the fewest points that stay within `tolerance` (of the picture's height)
 * of the path. Keeps the first and last; iterative, so a long path cannot overflow the stack.
 */
export function simplifyPoints(
  points: readonly NormPoint[],
  aspect: number,
  tolerance: number = SIMPLIFY_TOLERANCE,
): NormPoint[] {
  if (points.length <= 2) return [...points]
  const ratio = usableAspect(aspect)
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const ranges: [number, number][] = [[0, points.length - 1]]
  while (ranges.length > 0) {
    const [start, end] = ranges.pop()!
    let farthest = -1
    let most = tolerance
    for (let i = start + 1; i < end; i++) {
      const away = distanceToSegment(points[i], points[start], points[end], ratio)
      if (away > most) {
        most = away
        farthest = i
      }
    }
    if (farthest < 0) continue
    keep[farthest] = 1
    ranges.push([start, farthest], [farthest, end])
  }
  return points.filter((_, index) => keep[index] === 1)
}

/** Thins a path down to at most `limit` points, coarsening only as far as it must */
function thinTo(points: readonly NormPoint[], limit: number, aspect: number): NormPoint[] {
  let tolerance = SIMPLIFY_TOLERANCE
  let thinned = simplifyPoints(points, aspect, tolerance)
  while (thinned.length > limit) {
    tolerance *= 2
    thinned = simplifyPoints(thinned, aspect, tolerance)
  }
  return thinned
}

let idCounter = 0

/** A stroke id unique enough within a share: a member's strokes are also told apart by `by` */
export function newStrokeId(): string {
  idCounter += 1
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface NewStroke {
  id?: string
  by: string
  tool: AnnotationTool
  color?: AnnotationColor
  width?: AnnotationWidth
  /** Where the pointer went down, content coordinates */
  at: { x: number; y: number }
  text?: string
}

/** A stroke just begun; null for a point that is not a number */
export function beginStroke({
  id = newStrokeId(),
  by,
  tool,
  color = DEFAULT_ANNOTATION_COLOR,
  width = DEFAULT_ANNOTATION_WIDTH,
  at,
  text,
}: NewStroke): Stroke | null {
  const start = normalizePoint(at.x, at.y)
  if (!start) return null
  const base = { id, by, tool, color, width }
  if (tool === 'arrow' || tool === 'rect') return { ...base, points: [start, start] }
  if (tool === 'text') return { ...base, points: [start], text: text ?? '' }
  return { ...base, points: [start] }
}

/**
 * The stroke with the pointer's next position: a path grows (points closer than
 * MIN_POINT_DISTANCE dropped, thinned to 3/4 of the cap when it reaches it, so drawing never
 * stops), an arrow or rectangle moves its second point, a text mark stays put.
 */
export function extendStroke(stroke: Stroke, at: { x: number; y: number }, aspect: number): Stroke {
  if (stroke.tool === 'text') return stroke
  const next = normalizePoint(at.x, at.y)
  if (!next) return stroke
  if (stroke.tool === 'arrow' || stroke.tool === 'rect') {
    return { ...stroke, points: [stroke.points[0], next] }
  }
  const ratio = usableAspect(aspect)
  const last = stroke.points[stroke.points.length - 1]
  if (last && distance(last, next, ratio) < MIN_POINT_DISTANCE) return stroke
  const points = [...stroke.points, next]
  return {
    ...stroke,
    points:
      points.length > MAX_STROKE_POINTS
        ? thinTo(points, Math.floor((MAX_STROKE_POINTS * 3) / 4), ratio)
        : points,
  }
}

/**
 * The stroke as kept when the pointer lifts: a path simplified; null for one that came to
 * nothing (an arrow or rectangle with no size, an empty text mark). A single point is kept: a dot.
 */
export function finishStroke(stroke: Stroke, aspect: number): Stroke | null {
  const ratio = usableAspect(aspect)
  switch (stroke.tool) {
    case 'pen':
    case 'highlighter':
      return { ...stroke, points: simplifyPoints(stroke.points, ratio) }
    case 'arrow':
    case 'rect':
      return distance(stroke.points[0], stroke.points[1], ratio) < MIN_POINT_DISTANCE
        ? null
        : stroke
    case 'text': {
      const text = normalizeAnnotationText(stroke.text)
      return text === null ? null : { ...stroke, text }
    }
  }
}

/** A text mark's text cleaned as chat is (no control or bidi tricks); null when empty or too long */
export function normalizeAnnotationText(raw: unknown): string | null {
  const text = normalizeChatText(raw)
  return text !== null && [...text].length <= MAX_ANNOTATION_TEXT_CHARS ? text : null
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  list.includes(value as T)

function parsePoint(raw: unknown): NormPoint | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null
  const [x, y] = raw as unknown[]
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null
  return normalizePoint(x, y)
}

const POINT_COUNT: Readonly<Record<AnnotationTool, (count: number) => boolean>> = {
  pen: (count) => count >= 1 && count <= MAX_STROKE_POINTS,
  highlighter: (count) => count >= 1 && count <= MAX_STROKE_POINTS,
  arrow: (count) => count === 2,
  rect: (count) => count === 2,
  text: (count) => count === 1,
}

/**
 * A stroke from the wire, or null: the shapes and limits above, nothing else carried along. J2's
 * RoomDO calls this on every `annotation.add`, and stamps `by` itself.
 */
export function parseStroke(raw: unknown): Stroke | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, by, tool, color, width, points, text } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id === '' || id.length > MAX_STROKE_ID_CHARS) return null
  if (typeof by !== 'string') return null
  if (!isOneOf(ANNOTATION_TOOLS, tool)) return null
  if (!isOneOf(ANNOTATION_COLORS, color) || !isOneOf(ANNOTATION_WIDTHS, width)) return null
  if (!Array.isArray(points) || !POINT_COUNT[tool](points.length)) return null
  const parsed: NormPoint[] = []
  for (const point of points) {
    const good = parsePoint(point)
    if (!good) return null
    parsed.push(good)
  }
  const stroke: Stroke = { id, by, tool, color, width, points: parsed }
  if (tool !== 'text') return stroke
  const clean = normalizeAnnotationText(text)
  return clean === null ? null : { ...stroke, text: clean }
}

// ---------------------------------------------------------------------------------------------
// The list of strokes on a share, oldest first (drawn in order, so the newest is on top)

/**
 * Adds a stroke, or replaces the one with its id (J2's `annotation.update` while it is drawn).
 * Past MAX_STROKES the oldest goes (the PRD's raster merge of old strokes is J2's to decide).
 */
export function putStroke(strokes: readonly Stroke[], stroke: Stroke): Stroke[] {
  const index = strokes.findIndex((existing) => existing.id === stroke.id)
  if (index >= 0) return strokes.map((existing, i) => (i === index ? stroke : existing))
  const next = [...strokes, stroke]
  return next.length > MAX_STROKES ? next.slice(next.length - MAX_STROKES) : next
}

export function removeStroke(strokes: readonly Stroke[], id: string): Stroke[] {
  return strokes.filter((stroke) => stroke.id !== id)
}

/** Everything, or (PRD E7: 清除全部或某人的) one member's */
export function clearStrokes(strokes: readonly Stroke[], by?: string): Stroke[] {
  return by === undefined ? [] : strokes.filter((stroke) => stroke.by !== by)
}

/** The stroke undo takes back: the member's latest */
export function lastStrokeBy(strokes: readonly Stroke[], by: string): Stroke | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokes[i].by === by) return strokes[i]
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Hit-testing (the eraser, J2): how near a point comes to what is drawn

/** Wide characters take a full em, the rest a little over half: enough for a text mark's box */
const charWidth = (char: string) => ((char.codePointAt(0) ?? 0) > 0x2e7f ? 1 : 0.6)
const LINE_HEIGHT = 1.3

export const annotationLineHeight = LINE_HEIGHT

/** A text mark's box in content coordinates, estimated (no fonts here) */
export function textBounds(
  stroke: Stroke,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  const ratio = usableAspect(aspect)
  // Font size in units of the picture's height: a share of the short side
  const size = textSizeRatio(stroke.width) * Math.min(ratio, 1)
  const lines = (stroke.text ?? '').split('\n')
  const ems = Math.max(0, ...lines.map((line) => [...line].reduce((s, c) => s + charWidth(c), 0)))
  const [x, y] = stroke.points[0] ?? [0, 0]
  return {
    x,
    y,
    width: (ems * size) / ratio,
    height: lines.length * size * LINE_HEIGHT,
  }
}

/** How far `point` is from what a stroke draws, in units of the picture's height (0: on it) */
export function strokeDistance(stroke: Stroke, point: NormPoint, aspect: number): number {
  const ratio = usableAspect(aspect)
  const { points } = stroke
  if (stroke.tool === 'text') {
    const box = textBounds(stroke, ratio)
    const dx = Math.max(box.x - point[0], 0, point[0] - (box.x + box.width)) * ratio
    const dy = Math.max(box.y - point[1], 0, point[1] - (box.y + box.height))
    return Math.hypot(dx, dy)
  }
  // Half the line's thickness counts as on it
  const half = (lineWidthRatio(stroke) * Math.min(ratio, 1)) / 2
  let least = Infinity
  const segment = (a: NormPoint, b: NormPoint) => {
    least = Math.min(least, distanceToSegment(point, a, b, ratio))
  }
  if (stroke.tool === 'rect') {
    // The outline: a rectangle is not filled, so its inside is free to draw and click through
    const [[x1, y1], [x2, y2]] = [points[0], points[1]]
    segment([x1, y1], [x2, y1])
    segment([x2, y1], [x2, y2])
    segment([x2, y2], [x1, y2])
    segment([x1, y2], [x1, y1])
  } else if (points.length === 1) {
    segment(points[0], points[0])
  } else {
    for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i])
  }
  return Math.max(0, least - half)
}

/** The topmost (newest) stroke within `tolerance` of the point, or null */
export function strokeAt(
  strokes: readonly Stroke[],
  point: NormPoint,
  aspect: number,
  tolerance: number = HIT_TOLERANCE,
): Stroke | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokeDistance(strokes[i], point, aspect) <= tolerance) return strokes[i]
  }
  return null
}

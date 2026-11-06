import {
  annotationLineHeight,
  arrowHeadRatio,
  lineWidthRatio,
  textSizeRatio,
  type AnnotationColor,
  type NormPoint,
  type Stroke,
} from '../../shared/annotation.ts'
import { contentToDevice, type Point, type Rect } from '../../shared/shareGeometry.ts'
import { annotation, font } from '../styles/tokens.ts'

// Draws strokes on a 2D context whose canvas fills the share tile, in device pixels (e7-t02). Points
// are mapped one by one rather than with a canvas transform: the picture is rarely square, and a
// non-uniform transform would squash the pen. Thickness follows the picture's size on screen, so
// a mark covers the same part of the picture for everyone and grows when zooming in.

/** The least line on screen, in device pixels per CSS pixel: a thin line on a phone stays visible */
const MIN_LINE_CSS_PX = 1

const toDevice = (rect: Rect, ratio: number, [x, y]: NormPoint): Point =>
  contentToDevice(rect, ratio, { x, y })

/**
 * A smooth path through the points: straight to the first midpoint, then quadratic curves from
 * midpoint to midpoint with each point as the control (the usual pen smoothing; nothing to download)
 */
function tracePath(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  ctx.moveTo(points[0].x, points[0].y)
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y)
    return
  }
  for (let i = 1; i < points.length - 1; i++) {
    const next = points[i + 1]
    ctx.quadraticCurveTo(
      points[i].x,
      points[i].y,
      (points[i].x + next.x) / 2,
      (points[i].y + next.y) / 2,
    )
  }
  const last = points[points.length - 1]
  ctx.lineTo(last.x, last.y)
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, head: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  for (const side of [-1, 1]) {
    ctx.moveTo(to.x, to.y)
    ctx.lineTo(
      to.x - head * Math.cos(angle + (side * Math.PI) / 6),
      to.y - head * Math.sin(angle + (side * Math.PI) / 6),
    )
  }
}

/** One stroke, on a context already clipped to the picture */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  rect: Rect,
  ratio: number,
): void {
  const shortSide = Math.min(rect.width, rect.height) * ratio
  const paint = annotation.colors[stroke.color]
  const points = stroke.points.map((point) => toDevice(rect, ratio, point))
  if (points.length === 0) return
  ctx.save()
  ctx.strokeStyle = paint
  ctx.fillStyle = paint
  ctx.lineWidth = Math.max(lineWidthRatio(stroke) * shortSide, MIN_LINE_CSS_PX * ratio)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (stroke.tool === 'highlighter') ctx.globalAlpha = annotation.highlighterAlpha
  if (stroke.tool === 'text') {
    const size = textSizeRatio(stroke.width) * shortSide
    ctx.font = `${size}px ${font.ui}`
    ctx.textBaseline = 'top'
    ;(stroke.text ?? '').split('\n').forEach((line, index) => {
      ctx.fillText(line, points[0].x, points[0].y + index * size * annotationLineHeight)
    })
  } else if (points.length === 1) {
    // A dot: a tap with the pen
    ctx.beginPath()
    ctx.arc(points[0].x, points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    if (stroke.tool === 'rect') {
      const [a, b] = points
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y)
    } else if (stroke.tool === 'arrow') {
      drawArrow(ctx, points[0], points[1], arrowHeadRatio(stroke.width) * shortSide)
    } else {
      tracePath(ctx, points)
    }
    ctx.stroke()
  }
  ctx.restore()
}

const LASER_CSS_RADIUS = 6

/** The laser pointer (e7-t03): a glowing dot, the same size on every picture */
export function drawLaser(
  ctx: CanvasRenderingContext2D,
  at: NormPoint,
  color: AnnotationColor,
  opacity: number,
  rect: Rect,
  ratio: number,
): void {
  const { x, y } = toDevice(rect, ratio, at)
  const radius = LASER_CSS_RADIUS * ratio
  ctx.save()
  ctx.globalAlpha = opacity * annotation.laserGlowAlpha
  ctx.fillStyle = annotation.colors[color]
  ctx.beginPath()
  ctx.arc(x, y, radius * 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = opacity
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Who is drawing or pointing (PRD E7: 名字標籤): a small tag beside the tip */
export function drawNameTag(
  ctx: CanvasRenderingContext2D,
  name: string,
  at: NormPoint,
  rect: Rect,
  ratio: number,
): void {
  const { x, y } = toDevice(rect, ratio, at)
  const size = 12 * ratio
  const pad = 4 * ratio
  const offset = 10 * ratio
  ctx.save()
  ctx.font = `600 ${size}px ${font.ui}`
  ctx.textBaseline = 'middle'
  const width = (ctx.measureText?.(name).width ?? 0) + pad * 2
  const height = size + pad * 2
  ctx.fillStyle = annotation.tagBackground
  ctx.fillRect(x + offset, y + offset, width, height)
  ctx.fillStyle = annotation.tagText
  ctx.fillText(name, x + offset + pad, y + offset + height / 2)
  ctx.restore()
}

/**
 * The whole canvas: cleared, then the strokes in order, clipped to the picture. The whiteboard has
 * no picture to stay on: `clip` false (its rectangle is only the world's unit square, J3)
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  rect: Rect,
  ratio: number,
  canvasSize: { width: number; height: number },
  clip = true,
): void {
  ctx.clearRect(0, 0, canvasSize.width, canvasSize.height)
  ctx.save()
  if (clip) {
    ctx.beginPath()
    ctx.rect(rect.x * ratio, rect.y * ratio, rect.width * ratio, rect.height * ratio)
    ctx.clip()
  }
  for (const stroke of strokes) drawStroke(ctx, stroke, rect, ratio)
  ctx.restore()
}

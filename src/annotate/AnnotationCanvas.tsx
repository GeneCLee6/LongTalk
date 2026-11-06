import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent } from 'react'
import styled from 'styled-components'
import {
  beginStroke,
  extendStroke,
  finishStroke,
  putStroke,
  type AnnotationTool,
  type Stroke,
} from '../../shared/annotation.ts'
import { backingSize, insideContent } from '../../shared/shareGeometry.ts'
import { useShareGeometry } from '../components/useShareGeometry.ts'
import { strings } from '../strings.ts'
import { drawStrokes } from './draw.ts'

export interface AnnotationCanvasProps {
  /** The member drawing */
  by: string
  /** J2's toolbar chooses; until then a pen */
  tool?: AnnotationTool
}

/**
 * The drawing surface over a share (e7-t02): a canvas filling the tile, with its backing store at
 * devicePixelRatio. Everything is drawn through useShareGeometry's rectangle, so marks stay on the
 * same part of the picture through letterboxing, zoom, pan, resizes and fullscreen.
 *
 * Lazy-loaded (CLAUDE.md rule 6), and local for now: the strokes live and die with this component.
 * J2 (e7-t03, e7-t04) adds the toolbar and feeds it the room's strokes.
 *
 * Only the primary pointer draws. A second finger cancels the stroke, so a pinch (handled by the
 * tile, which sees these events bubble) never leaves a mark behind.
 */
export default function AnnotationCanvas({ by, tool = 'pen' }: AnnotationCanvasProps) {
  const geometry = useShareGeometry()
  const { box, rect, pixelRatio, source, clientToContent } = geometry
  const aspect = source ? source.width / source.height : 1
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<readonly Stroke[]>([])
  const drawing = useRef<{ pointerId: number; stroke: Stroke } | null>(null)
  const frame = useRef<number | null>(null)

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext?.('2d')
    if (!canvas || !ctx || !rect) return
    const current = drawing.current?.stroke
    drawStrokes(
      ctx,
      current ? [...strokes.current, current] : strokes.current,
      rect,
      pixelRatio,
      canvas,
    )
  }, [rect, pixelRatio])

  // A new shape, size or view: the backing store follows the tile, and everything is drawn anew
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = backingSize(box, pixelRatio)
    if (canvas.width !== size.width) canvas.width = size.width
    if (canvas.height !== size.height) canvas.height = size.height
    paint()
  }, [box, pixelRatio, paint])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  /** At most one repaint a frame, however fast the pointer reports */
  const schedule = () => {
    if (typeof requestAnimationFrame === 'undefined') {
      paint()
      return
    }
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      paint()
    })
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!event.isPrimary) {
      drawing.current = null
      schedule()
      return
    }
    if (event.button !== 0) return
    const at = clientToContent(event.clientX, event.clientY)
    // Started on the letterbox bars: not on the picture, nothing to mark
    if (!at || !insideContent(at)) return
    const stroke = beginStroke({ by, tool, at })
    if (!stroke) return
    drawing.current = { pointerId: event.pointerId, stroke }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    schedule()
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const active = drawing.current
    if (!active || active.pointerId !== event.pointerId) return
    // Every position since the last event: fast curves stay curves
    const native = event.nativeEvent
    const moves = native.getCoalescedEvents?.() ?? []
    let { stroke } = active
    for (const move of moves.length > 0 ? moves : [native]) {
      const at = clientToContent(move.clientX, move.clientY)
      if (at) stroke = extendStroke(stroke, at, aspect)
    }
    active.stroke = stroke
    schedule()
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const active = drawing.current
    if (!active || active.pointerId !== event.pointerId) return
    drawing.current = null
    const finished = finishStroke(active.stroke, aspect)
    if (finished) strokes.current = putStroke(strokes.current, finished)
    schedule()
  }

  const onPointerCancel = (event: PointerEvent<HTMLCanvasElement>) => {
    if (drawing.current?.pointerId !== event.pointerId) return
    drawing.current = null
    schedule()
  }

  return (
    <Surface
      ref={canvasRef}
      role="img"
      aria-label={strings.screenShare.annotationCanvas}
      data-annotation-canvas=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    />
  )
}

const Surface = styled.canvas`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
`

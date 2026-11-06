import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent } from 'react'
import styled from 'styled-components'
import {
  insideSpace,
  isWhiteboard,
  laserOpacity,
  spaceOf,
  type AnnotationColor,
  type AnnotationWidth,
  type Stroke,
} from '../../shared/annotation.ts'
import { backingSize, type Point } from '../../shared/shareGeometry.ts'
import { useReducedMotion } from '../components/layoutContext.ts'
import { useShareGeometry } from '../components/useShareGeometry.ts'
import type { AnnotationStore } from '../room/annotationStore.ts'
import { strings } from '../strings.ts'
import { drawLaser, drawNameTag, drawStrokes, drawStroke } from './draw.ts'
import type { AnnotationDrawer } from './sync.ts'
import type { AnnotationMode } from './Toolbar.tsx'

export interface AnnotationCanvasProps {
  store: AnnotationStore
  /** The sharer: which share's layer */
  share: string
  /** Us, to leave our own name off what we draw; null when we may not annotate */
  me: string | null
  /** Who a stroke or pointer belongs to, for the name tag */
  nameOf: (memberId: string) => string | null
  /** What the pointer does; null: nothing, the marks are only shown (the tile keeps its gestures) */
  mode: AnnotationMode | null
  color: AnnotationColor
  width: AnnotationWidth
  /** How we draw; null with `mode` null */
  drawer: AnnotationDrawer | null
  /** The text tool picked a place on the picture */
  onTextAt?: (at: Point) => void
}

/**
 * The marks over a share (e7-t02, J2): a canvas filling the tile, with its backing store at
 * devicePixelRatio. Everything is drawn through useShareGeometry's rectangle, so marks stay on the
 * same part of the picture through letterboxing, zoom, pan, resizes and fullscreen.
 *
 * Lazy-loaded (CLAUDE.md rule 6). The room's strokes come from the store; finished ones are kept in
 * a picture of their own, so someone drawing over two thousand strokes only redraws what is moving
 * (PRD E7: 接收端增量繪製).
 *
 * Only the primary pointer draws. A second finger cancels the stroke, so a pinch (handled by the
 * tile, which sees these events bubble) never leaves a mark behind.
 */
export default function AnnotationCanvas({
  store,
  share,
  me,
  nameOf,
  mode,
  color,
  width,
  drawer,
  onTextAt,
}: AnnotationCanvasProps) {
  const geometry = useShareGeometry()
  const { box, rect, pixelRatio, source, clientToContent } = geometry
  const aspect = source ? source.width / source.height : 1
  // The whiteboard: the rectangle is only its unit square, marks go anywhere (J3)
  const clipped = !isWhiteboard(share)
  const reducedMotion = useReducedMotion()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const settledCanvas = useRef<HTMLCanvasElement | null>(null)
  const settledKey = useRef('')
  const pointer = useRef<number | null>(null)
  /** A finger came down with the text tool: it places a mark if it lifts as a tap (J4) */
  const textTap = useRef<{ id: number; x: number; y: number } | null>(null)
  const frame = useRef<number | null>(null)
  const scheduleRef = useRef<() => void>(() => undefined)

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext?.('2d')
    if (!canvas || !ctx || !rect) return
    const active = store.active(share)
    const strokes = store.strokes(share)
    // The picture of finished strokes, made again only when one of them changed or the view did
    const key = [
      store.settledVersion(share),
      [...active.keys()].join(),
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      pixelRatio,
      canvas.width,
      canvas.height,
    ].join('|')
    let settled = settledCanvas.current
    if (!settled) {
      settled = document.createElement('canvas')
      settledCanvas.current = settled
    }
    if (settledKey.current !== key) {
      settledKey.current = key
      settled.width = canvas.width
      settled.height = canvas.height
      const context = settled.getContext?.('2d')
      if (context) {
        const finished = strokes.filter((stroke) => !active.has(stroke.id))
        drawStrokes(context, finished, rect, pixelRatio, settled, clipped)
      }
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(settled, 0, 0)
    const moving: Stroke[] = strokes.filter((stroke) => active.has(stroke.id))
    const now = Date.now()
    const lasers = store.lasers(share)
    ctx.save()
    if (clipped) {
      ctx.beginPath()
      ctx.rect(rect.x * pixelRatio, rect.y * pixelRatio, rect.width * pixelRatio, rect.height * pixelRatio)
      ctx.clip()
    }
    for (const stroke of moving) drawStroke(ctx, stroke, rect, pixelRatio)
    for (const stroke of moving) {
      if (stroke.by === me) continue
      const name = nameOf(stroke.by)
      const tip = stroke.points[stroke.points.length - 1]
      if (name && tip) drawNameTag(ctx, name, tip, rect, pixelRatio)
    }
    for (const laser of lasers) {
      // PRD E7: it fades; with less motion it just stays until it goes
      const opacity = reducedMotion ? 1 : laserOpacity(laser.heardAt, now)
      drawLaser(ctx, laser.at, laser.color, opacity, rect, pixelRatio)
      const name = laser.by === me ? null : nameOf(laser.by)
      if (name) drawNameTag(ctx, name, laser.at, rect, pixelRatio)
    }
    ctx.restore()
    // Something is fading or going quiet: the next frame looks again
    if (lasers.length > 0 || active.size > 0) scheduleRef.current()
  }, [store, share, me, nameOf, rect, pixelRatio, reducedMotion, clipped])

  /** At most one repaint a frame, however fast the pointer or the room reports */
  const schedule = useCallback(() => {
    if (frame.current !== null || typeof requestAnimationFrame === 'undefined') return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      paint()
    })
  }, [paint])
  useEffect(() => {
    scheduleRef.current = schedule
  }, [schedule])

  const repaint = useCallback(() => {
    if (typeof requestAnimationFrame === 'undefined') paint()
    else schedule()
  }, [paint, schedule])

  // A new shape, size or view: the backing store follows the tile, and everything is drawn anew
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = backingSize(box, pixelRatio)
    if (canvas.width !== size.width) canvas.width = size.width
    if (canvas.height !== size.height) canvas.height = size.height
    paint()
  }, [box, pixelRatio, paint])

  useEffect(() => store.subscribe(share, repaint), [store, share, repaint])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    },
    [],
  )

  /** Where the pointer is on the picture; null off it */
  const onPicture = (clientX: number, clientY: number): Point | null => {
    const at = clientToContent(clientX, clientY)
    return at && insideSpace(at, spaceOf(share)) ? at : null
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!mode || !drawer) return
    if (!event.isPrimary) {
      drawer.cancel()
      pointer.current = null
      textTap.current = null
      return
    }
    if (event.button !== 0) return
    const at = onPicture(event.clientX, event.clientY)
    // Started on the letterbox bars: not on the picture, nothing to mark
    if (!at) return
    switch (mode) {
      case 'text':
        // A finger may be starting a pinch or a scroll: only a tap places a mark (J4, e7-t09)
        if (event.pointerType === 'touch') {
          textTap.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
          return
        }
        // The press would take the focus straight back from the box it opens
        event.preventDefault()
        onTextAt?.(at)
        return
      case 'eraser':
        drawer.eraseAt(at, aspect)
        break
      case 'laser':
        drawer.laser(at, color)
        break
      default:
        if (!drawer.begin({ tool: mode, color, width, at })) return
    }
    pointer.current = event.pointerId
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!mode || !drawer) return
    // A mouse shows the laser just by moving; a finger has to press
    if (mode === 'laser' && (event.pointerType === 'mouse' || pointer.current === event.pointerId)) {
      drawer.laser(onPicture(event.clientX, event.clientY), color)
      return
    }
    if (pointer.current !== event.pointerId) return
    if (mode === 'eraser') {
      const at = onPicture(event.clientX, event.clientY)
      if (at) drawer.eraseAt(at, aspect)
      return
    }
    // Every position since the last event: fast curves stay curves
    const native = event.nativeEvent
    const moves = native.getCoalescedEvents?.() ?? []
    for (const move of moves.length > 0 ? moves : [native]) {
      const at = clientToContent(move.clientX, move.clientY)
      if (at) drawer.move(at, aspect)
    }
  }

  const lift = (event: PointerEvent<HTMLCanvasElement>, keep: boolean) => {
    const tap = textTap.current
    if (tap?.id === event.pointerId) {
      textTap.current = null
      const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y)
      const at = keep && moved <= TAP_SLOP_PX ? onPicture(tap.x, tap.y) : null
      if (at) {
        // The lifting finger's click would land outside the box it opens and take the focus back
        event.preventDefault()
        onTextAt?.(at)
      }
      return
    }
    if (!drawer || pointer.current !== event.pointerId) return
    pointer.current = null
    if (mode === 'laser') {
      if (event.pointerType !== 'mouse') drawer.laser(null, color)
    } else if (keep) drawer.end(aspect)
    else drawer.cancel()
  }

  return (
    <Surface
      ref={canvasRef}
      role="img"
      aria-label={strings.screenShare.annotationCanvas}
      data-annotation-canvas=""
      $mode={mode}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => lift(event, true)}
      onPointerCancel={(event) => lift(event, false)}
      onPointerLeave={(event) => {
        if (mode === 'laser' && event.pointerType === 'mouse') drawer?.laser(null, color)
      }}
    />
  )
}

/** A finger moving no further than this between down and up is a tap */
const TAP_SLOP_PX = 10

const cursorOf = (mode: AnnotationMode): string =>
  mode === 'text' ? 'text' : mode === 'eraser' ? 'cell' : 'crosshair'

const Surface = styled.canvas<{ $mode: AnnotationMode | null }>`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  ${({ $mode }) =>
    $mode
      ? `cursor: ${cursorOf($mode)}; touch-action: none;`
      : // Only shown: pointers go straight through to the tile (its zoom, its drag, its button)
        'pointer-events: none;'}
`

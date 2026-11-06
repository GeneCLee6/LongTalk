import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { ZOOM_STEP, wheelZoomFactor, type Point } from '../../shared/shareGeometry.ts'
import { isTypingTarget, insideWidget } from '../room/shortcuts.ts'
import type { ShareViewport } from './useShareGeometry.ts'

/** Arrow keys move the zoomed picture by this share of the tile */
const KEY_PAN_SHARE = 0.1

export interface ShareGestureOptions {
  /** The main share with a picture: strip shares and the waiting state have no gestures */
  enabled: boolean
  /** The annotation canvas has the single pointer: only two fingers still zoom */
  drawing: boolean
  onToggleFullscreen?: () => void
}

/**
 * A press on something on the tile with a job of its own (the view controls, the picker between
 * shares) is not a gesture on the picture. It must not even be captured: a captured pointer's
 * click goes to the capturing element, so the button would never hear it.
 */
const onControl = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('button, a, input, select, textarea, [role="group"], [role="toolbar"]') !== null

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/**
 * What the share tile does with the mouse, fingers and keys (e3-t11): the wheel and a pinch zoom
 * around the pointer, dragging moves a zoomed picture, double-clicking toggles fullscreen, and with
 * focus on the tile + − 0, the arrows and F do the same. Spread the result on the tile.
 */
export function useShareGestures(
  frameRef: RefObject<HTMLElement | null>,
  viewport: ShareViewport,
  { enabled, drawing, onToggleFullscreen }: ShareGestureOptions,
) {
  const { geometry, zoomTo, panBy, reset } = viewport
  const pointers = useRef(new Map<number, Point>())
  const [dragging, setDragging] = useState(false)

  const toTile = (clientX: number, clientY: number): Point => {
    const at = frameRef.current?.getBoundingClientRect()
    return { x: clientX - (at?.left ?? 0), y: clientY - (at?.top ?? 0) }
  }

  // Must not be passive, or the page would also scroll or zoom: React's onWheel is
  const onWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault()
    const factor = wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey)
    zoomTo((zoom) => zoom * factor, toTile(event.clientX, event.clientY))
  })
  useEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) return
    const wheel = (event: WheelEvent) => onWheel(event)
    frame.addEventListener('wheel', wheel, { passive: false })
    return () => frame.removeEventListener('wheel', wheel)
  }, [enabled, frameRef])

  if (!enabled) return {}

  const lift = (pointerId: number) => {
    pointers.current.delete(pointerId)
    if (pointers.current.size === 0) setDragging(false)
  }

  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (onControl(event.target)) return
      pointers.current.set(event.pointerId, toTile(event.clientX, event.clientY))
      if (drawing) return
      // Held even at 100%: released outside the tile, the release must still reach us
      event.currentTarget.setPointerCapture?.(event.pointerId)
      if (geometry.view.zoom > 1) setDragging(true)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const before = pointers.current.get(event.pointerId)
      if (!before) return
      // A mouse with no button down: its release went missing, so this is not a drag
      if (event.pointerType === 'mouse' && event.buttons === 0) {
        lift(event.pointerId)
        return
      }
      const now = toTile(event.clientX, event.clientY)
      const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId)
      pointers.current.set(event.pointerId, now)
      if (others.length === 1) {
        // Two fingers: the distance between them zooms, their midpoint carries the picture along
        const other = others[0][1]
        const from = Math.hypot(before.x - other.x, before.y - other.y)
        const to = Math.hypot(now.x - other.x, now.y - other.y)
        const middle = midpoint(now, other)
        const previous = midpoint(before, other)
        if (from > 0) zoomTo((zoom) => (zoom * to) / from, middle)
        panBy(middle.x - previous.x, middle.y - previous.y)
      } else if (others.length === 0 && !drawing) {
        panBy(now.x - before.x, now.y - before.y)
      }
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => lift(event.pointerId),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => lift(event.pointerId),
    onDoubleClick: (event: MouseEvent<HTMLElement>) => {
      if (!drawing && onToggleFullscreen && !onControl(event.target)) {
        event.preventDefault()
        onToggleFullscreen()
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (isTypingTarget(event.target) || insideWidget(event.target)) return
      const stepX = geometry.box.width * KEY_PAN_SHARE
      const stepY = geometry.box.height * KEY_PAN_SHARE
      const zoomed = geometry.view.zoom > 1
      switch (event.key) {
        case '+':
        case '=':
          zoomTo((zoom) => zoom * ZOOM_STEP)
          break
        case '-':
        case '_':
          zoomTo((zoom) => zoom / ZOOM_STEP)
          break
        case '0':
          reset()
          break
        case 'f':
        case 'F':
          if (!onToggleFullscreen || event.repeat) return
          onToggleFullscreen()
          break
        case 'ArrowLeft':
          if (!zoomed) return
          panBy(stepX, 0)
          break
        case 'ArrowRight':
          if (!zoomed) return
          panBy(-stepX, 0)
          break
        case 'ArrowUp':
          if (!zoomed) return
          panBy(0, stepY)
          break
        case 'ArrowDown':
          if (!zoomed) return
          panBy(0, -stepY)
          break
        default:
          return
      }
      // Ours: not also a room shortcut, nor the page scrolling
      event.preventDefault()
      event.stopPropagation()
    },
    $dragging: dragging,
  }
}

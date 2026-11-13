import {
  useEffect,
  useRef,
  useState,
  type CompositionEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import styled from 'styled-components'
import type { ControlEventMessage } from '../../shared/control.ts'
import { ControlSender, buttonOf, modsOf } from '../room/controlSender.ts'
import { color } from '../styles/tokens.ts'
import { useShareGeometry } from './useShareGeometry.ts'

export interface ControlLayerProps {
  /** The grant this socket holds (`controlGranted`) */
  grant: string
  send: (message: ControlEventMessage) => void
  /** What a screen reader says the layer is */
  label: string
}

/**
 * Over the share of a computer we control (N3, e9-t05; lazy, like annotation, CLAUDE.md rule 6):
 * the pointer and the keyboard go to the agent as `controlEvent` batches (ControlSender). Positions
 * are the picture's own 0–1 coordinates (useShareGeometry, the same as the marks), so the tile's
 * size, zoom and letterboxing do not matter. A dot follows the pointer at once, before the picture
 * catches up (f-remote-control-security.md §5.5.2). Keys go as physical codes (KeyboardEvent.code);
 * an input method's composition goes as the text it commits (`compositionend`), never the keys that
 * built it. Leaving the window releases whatever is held.
 */
export default function ControlLayer({ grant, send, label }: ControlLayerProps) {
  const geometry = useShareGeometry()
  const layerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [sender] = useState(() => new ControlSender(grant, send))
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  // The latest geometry for the native wheel listener
  const geometryRef = useRef(geometry)
  useEffect(() => {
    geometryRef.current = geometry
  }, [geometry])

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    const release = () => sender.releaseAll()
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('blur', release)
      sender.stop()
    }
  }, [sender])

  // A passive React wheel listener could not keep the page from scrolling
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
      sender.wheel(event.deltaX * scale, event.deltaY * scale)
    }
    layer.addEventListener('wheel', wheel, { passive: false })
    return () => layer.removeEventListener('wheel', wheel)
  }, [sender])

  const toContent = (event: PointerEvent<HTMLElement>) =>
    geometryRef.current.clientToContent(event.clientX, event.clientY)

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const point = toContent(event)
    if (!point) return
    const rect = layerRef.current?.getBoundingClientRect()
    if (rect) setCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    sender.move(point.x, point.y)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
    const button = buttonOf(event.button)
    const point = toContent(event)
    if (!button || !point) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    sender.move(point.x, point.y)
    sender.button(button, true)
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const button = buttonOf(event.button)
    if (!button) return
    const point = toContent(event)
    if (point) sender.move(point.x, point.y)
    sender.button(button, false)
  }

  const onKey = (down: boolean) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An input method is composing: its result comes as text at compositionend
    if (event.nativeEvent.isComposing || event.key === 'Process') return
    if (sender.key(event.code, down, modsOf(event))) event.preventDefault()
  }

  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    if (event.data) sender.text(event.data)
    event.currentTarget.value = ''
  }

  return (
    <Layer
      ref={layerRef}
      role="application"
      aria-label={label}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => sender.releaseAll()}
      onPointerLeave={() => setCursor(null)}
      onContextMenu={(event) => event.preventDefault()}
    >
      <Input
        ref={inputRef}
        aria-label={label}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={onKey(true)}
        onKeyUp={onKey(false)}
        onCompositionEnd={onCompositionEnd}
        // Whatever lands here without a composition (a paste, a dead key on some systems) is not
        // sent: only what the keys and the input method say
        onInput={(event) => {
          if (!(event.nativeEvent as InputEvent).isComposing) event.currentTarget.value = ''
        }}
      />
      {cursor && <Cursor aria-hidden="true" style={{ left: cursor.x, top: cursor.y }} />}
    </Layer>
  )
}

/** Over the picture, under the tile's own controls (they come later in the frame) */
const Layer = styled.div`
  position: absolute;
  inset: 0;
  cursor: none;
  touch-action: none;
  outline: 3px solid ${color.danger};
  outline-offset: -3px;
  border-radius: inherit;
`

/** Off screen but focusable: where the keyboard and the input method type */
const Input = styled.textarea`
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  opacity: 0;
  resize: none;
  pointer-events: none;
`

const Cursor = styled.span`
  position: absolute;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border: 2px solid ${color.onDanger};
  border-radius: 50%;
  background: ${color.danger};
  pointer-events: none;
`

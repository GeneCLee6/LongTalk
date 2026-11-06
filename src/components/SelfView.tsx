import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import styled from 'styled-components'
import {
  clampSelfView,
  moveSelfView,
  selfViewKey,
  type SelfViewAt,
} from '../room/selfView.ts'
import { strings } from '../strings.ts'
import { color, media, motion, space } from '../styles/tokens.ts'
import { MoveIcon } from './icons.tsx'

export interface SelfViewProps {
  /** Our own tile */
  children: ReactNode
  /** Where it was left (remembered, session.ts) */
  at: SelfViewAt
  /** The end of a drag, or an arrow key */
  onMove: (at: SelfViewAt) => void
}

/**
 * Our own tile floating over the stage (e6-t07, PRD: 自拍格固定在角落可拖曳), instead of taking a
 * place in the layout: drag it anywhere with the mouse or a finger, or focus its handle and use the
 * arrow keys (Shift for bigger steps). It stays inside the stage because its place is a fraction of
 * the stage's free space, in CSS (container units): nothing to recompute on a resize. It does not
 * touch the layout underneath, which simply has one tile fewer.
 */
export function SelfView({ children, at, onMove }: SelfViewProps) {
  const hintId = useId()
  const box = useRef<HTMLDivElement>(null)
  // While dragging, its place is here and the page does not hear about it until the end
  const [dragged, setDragged] = useState<SelfViewAt | null>(null)
  const drag = useRef<{ pointer: number; x: number; y: number; at: SelfViewAt } | null>(null)
  const shown = clampSelfView(dragged ?? at)

  const freeSpace = () => {
    const tile = box.current
    const stage = tile?.parentElement
    if (!tile || !stage) return { width: 0, height: 0 }
    return {
      width: stage.clientWidth - tile.offsetWidth,
      height: stage.clientHeight - tile.offsetHeight,
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, at: shown }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current
    if (!from || from.pointer !== event.pointerId) return
    const free = freeSpace()
    setDragged(
      moveSelfView(from.at, event.clientX - from.x, event.clientY - from.y, free.width, free.height),
    )
  }
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    drag.current = null
    if (dragged) onMove(dragged)
    setDragged(null)
  }
  const onHandleKey = (event: KeyboardEvent) => {
    const move = selfViewKey(event.key, event.shiftKey)
    if (!move) return
    event.preventDefault()
    const free = freeSpace()
    onMove(moveSelfView(shown, move.dx, move.dy, free.width, free.height))
  }

  return (
    <Stage>
      <Box
        ref={box}
        role="group"
        aria-label={strings.selfView.label}
        data-self-view=""
        data-dragging={dragged ? '' : undefined}
        style={{ '--x': shown.x, '--y': shown.y } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {children}
        <Handle
          type="button"
          aria-label={strings.selfView.move}
          aria-describedby={hintId}
          title={strings.selfView.moveHint}
          onKeyDown={onHandleKey}
        >
          <MoveIcon />
        </Handle>
        <span id={hintId} hidden>
          {strings.selfView.moveHint}
        </span>
      </Box>
    </Stage>
  )
}

/** The stage's own box, for the units below; lets everything through but the tile */
const Stage = styled.div`
  position: absolute;
  inset: 0;
  container-type: size;
  pointer-events: none;
`

const Box = styled.div`
  --width: clamp(112px, 24cqw, 240px);
  --height: calc(var(--width) * 9 / 16);
  position: absolute;
  left: calc((100cqw - var(--width)) * var(--x));
  top: calc((100cqh - var(--height)) * var(--y));
  width: var(--width);
  height: var(--height);
  pointer-events: auto;
  /* The finger drags the tile, not the page or the pages under it */
  touch-action: none;
  cursor: grab;
  border-radius: ${space(2)};
  box-shadow: 0 4px 16px ${color.shadow};
  user-select: none;
  transition:
    left ${motion.fast} ease-out,
    top ${motion.fast} ease-out;

  &[data-dragging] {
    cursor: grabbing;
    transition: none;
  }
`

const Handle = styled.button`
  position: absolute;
  top: ${space(1)};
  left: ${space(1)};
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: ${color.overlay};
  color: ${color.fg};
  cursor: grab;
  opacity: 0;
  transition: opacity ${motion.fast} ease-out;

  svg {
    width: 16px;
    height: 16px;
  }
  [data-self-view]:hover &,
  &:focus-visible {
    opacity: 1;
  }
  @media ${media.touchPrimary} {
    display: none;
  }
`

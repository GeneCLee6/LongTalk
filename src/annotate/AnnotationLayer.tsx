import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import {
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_WIDTH,
  isWhiteboard,
  normalizePoint,
  spaceOf,
  textSizeRatio,
  type AnnotationColor,
  type AnnotationWidth,
} from '../../shared/annotation.ts'
import { MAX_ANNOTATION_TEXT_CHARS } from '../../shared/annotation-limits.ts'
import { contentToTile, tileToContent, type Point } from '../../shared/shareGeometry.ts'
import { useShareGeometry } from '../components/useShareGeometry.ts'
import { isTypingTarget } from '../room/shortcuts.ts'
import type { ShareAnnotations } from '../components/ShareTile.tsx'
import { strings } from '../strings.ts'
import { annotation, color as colorToken, font, fontSize, radius, space } from '../styles/tokens.ts'
import AnnotationCanvas from './AnnotationCanvas.tsx'
import { drawerFor } from './sync.ts'
import { AnnotationToolbar, type AnnotationMode } from './Toolbar.tsx'

/** A tile narrower than this folds colours and widths behind one button */
const COMPACT_WIDTH = 720

/** What the arrow keys move the keyboard pen by, CSS px (e7-t09): Shift goes further */
const KEY_STEP_PX = 10
const KEY_STEP_FAST_PX = 40

/** The six colours that work on anything by default, by member: so two people differ at once */
const DEFAULT_COLORS: readonly AnnotationColor[] = [
  'rose',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
]

/** White on a white sheet would be a mark nobody can see, the one who drew it included */
const BOARD_COLORS = ANNOTATION_COLORS.filter((name) => name !== 'white')

function defaultColor(memberId: string | null): AnnotationColor {
  let sum = 0
  for (const char of memberId ?? '') sum += char.charCodeAt(0)
  return DEFAULT_COLORS[sum % DEFAULT_COLORS.length]
}

export interface AnnotationLayerProps extends ShareAnnotations {
  /** The 標註 button is on: the toolbar shows and the pointer draws */
  editing: boolean
}

/**
 * Everything of annotation that lives in a share tile (J2, e7-t03): the canvas, and for someone
 * drawing the toolbar and the text box. The one lazy module ShareTile points at (CLAUDE.md rule 6).
 *
 * The keyboard's way to draw (J4, e7-t09): a tool picked from the keyboard brings out a cursor, moved
 * with the arrow keys, with Enter as the pen going down and up. Text goes straight to its box. Not
 * as nice as a hand, but every tool works, and a stroke made this way is an ordinary stroke.
 */
export default function AnnotationLayer({
  store,
  share,
  me,
  nameOf,
  editing,
}: AnnotationLayerProps) {
  const geometry = useShareGeometry()
  const { box, rect } = geometry
  const drawer = useMemo(
    () => (me === null ? null : drawerFor(store, share, me)),
    [store, share, me],
  )
  const [mode, setMode] = useState<AnnotationMode>('pen')
  const [color, setColor] = useState<AnnotationColor>(() => defaultColor(me))
  const [width, setWidth] = useState<AnnotationWidth>(DEFAULT_ANNOTATION_WIDTH)
  const [textAt, setTextAt] = useState<Point | null>(null)
  const textBox = useRef<HTMLTextAreaElement>(null)
  // A box being taken away also blurs: finished with Enter or Esc, that must not count again
  const textDone = useRef(false)
  const active = editing && drawer !== null
  const [keyCursor, setKeyCursor] = useState<{ at: Point; down: boolean } | null>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const aspect = geometry.source ? geometry.source.width / geometry.source.height : 1
  const cursorShown = active && rect !== null && keyCursor !== null

  // Where the keys go as soon as it shows; the mouse or a finger does not bring this out
  useEffect(() => {
    if (cursorShown) cursorRef.current?.focus()
  }, [cursorShown])

  // The room took the tools away, or the tile went, mid-stroke: that stroke does not stay half-drawn
  useEffect(() => () => drawer?.cancel(), [drawer])

  // The fingers' habit: undo and redo wherever the focus is, while the tools are out
  useEffect(() => {
    if (!active || !drawer) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || isTypingTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) drawer.undo()
      else if (key === 'y' || (key === 'z' && event.shiftKey)) drawer.redo()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, drawer])

  const openText = (at: Point) => {
    textDone.current = false
    setTextAt(at)
  }

  const closeText = () => {
    textDone.current = true
    setTextAt(null)
  }

  const commitText = (text: string) => {
    if (textDone.current) return
    if (textAt && drawer) drawer.addText({ text, color, width, at: textAt })
    closeText()
  }

  const middleOfView = (): Point => {
    if (!rect) return { x: 0, y: 0 }
    const [x, y] = normalizePoint(
      (box.width / 2 - rect.x) / rect.width,
      (box.height / 2 - rect.y) / rect.height,
      spaceOf(share),
    ) ?? [0, 0]
    return { x, y }
  }

  const closeCursor = (backToTools: boolean, from?: HTMLElement) => {
    if (mode === 'laser') drawer?.laser(null, color)
    setKeyCursor(null)
    if (backToTools) {
      from?.parentElement
        ?.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-pressed="true"]')
        ?.focus()
    }
  }

  const onCursorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!drawer || !rect || !keyCursor) return
    const { at, down } = keyCursor
    const step = event.shiftKey ? KEY_STEP_FAST_PX : KEY_STEP_PX
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const move = moves[event.key]
    if (move) {
      // Stays on what is on screen: on a share, on the picture too
      const tile = contentToTile(rect, at)
      const left = Math.max(0, rect.x)
      const top = Math.max(0, rect.y)
      const right = isWhiteboard(share) ? box.width : Math.min(box.width, rect.x + rect.width)
      const bottom = isWhiteboard(share) ? box.height : Math.min(box.height, rect.y + rect.height)
      const next = tileToContent(rect, {
        x: Math.min(Math.max(tile.x + move[0], isWhiteboard(share) ? 0 : left), right),
        y: Math.min(Math.max(tile.y + move[1], isWhiteboard(share) ? 0 : top), bottom),
      })
      setKeyCursor({ at: next, down })
      if (mode === 'laser') drawer.laser(next, color)
      else if (down) drawer.move(next, aspect)
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (mode === 'eraser') drawer.eraseAt(at, aspect)
      else if (mode === 'laser') drawer.laser(at, color)
      else if (down) {
        drawer.end(aspect)
        setKeyCursor({ at, down: false })
      } else if (mode !== 'text' && drawer.begin({ tool: mode, color, width, at })) {
        setKeyCursor({ at, down: true })
      }
    } else if (event.key === 'Escape') {
      if (down) {
        drawer.cancel()
        setKeyCursor({ at, down: false })
      } else closeCursor(true, event.currentTarget)
    } else {
      return
    }
    // Ours: not the board moving, a push to talk, or a room shortcut
    event.preventDefault()
    event.stopPropagation()
  }

  const keyText = strings.annotation.keyboard
  const keyHint = !cursorShown
    ? ''
    : mode === 'eraser'
      ? keyText.eraser
      : mode === 'laser'
        ? keyText.laser
        : keyCursor?.down
          ? keyText.down
          : keyText.up

  return (
    <>
      <AnnotationCanvas
        store={store}
        share={share}
        me={me}
        nameOf={nameOf}
        mode={active ? mode : null}
        color={color}
        width={width}
        drawer={active ? drawer : null}
        onTextAt={(at) => {
          if (textAt) commitText(textBox.current?.value ?? '')
          openText(at)
        }}
      />
      {active && rect && textAt && (
        <TextBox
          key={`${textAt.x},${textAt.y}`}
          ref={textBox}
          autoFocus
          rows={1}
          maxLength={MAX_ANNOTATION_TEXT_CHARS}
          aria-label={strings.annotation.textLabel}
          placeholder={strings.annotation.textPlaceholder}
          style={{
            left: contentToTile(rect, textAt).x,
            top: contentToTile(rect, textAt).y,
            color: annotation.colors[color],
            fontSize: textSizeRatio(width) * Math.min(rect.width, rect.height),
            fontFamily: font.ui,
          }}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            event.stopPropagation()
            if (event.key === 'Escape') closeText()
            // Choosing a character: 229 is what some browsers say then (RULES: 注音選字)
            const composing = event.nativeEvent.isComposing || event.keyCode === 229
            if (event.key !== 'Enter' || event.shiftKey || composing) return
            event.preventDefault()
            commitText(event.currentTarget.value)
          }}
          onBlur={(event) => commitText(event.currentTarget.value)}
        />
      )}
      {cursorShown && rect && keyCursor && (
        <KeyCursor
          ref={cursorRef}
          role="application"
          tabIndex={0}
          aria-label={keyText.cursor}
          data-keyboard-cursor=""
          $paint={annotation.colors[color]}
          style={{
            left: contentToTile(rect, keyCursor.at).x,
            top: contentToTile(rect, keyCursor.at).y,
          }}
          onKeyDown={onCursorKey}
          onBlur={() => {
            if (keyCursor.down) drawer?.end(aspect)
            closeCursor(false)
          }}
        />
      )}
      {active && (
        <KeyHint role="status" $shown={keyHint !== ''}>
          {keyHint}
        </KeyHint>
      )}
      {active && drawer && (
        <AnnotationToolbar
          drawer={drawer}
          mode={mode}
          onMode={(next, byKeyboard) => {
            setMode(next)
            // No pointer to place it with: the middle of what is on screen, then typing, or the
            // cursor the arrow keys move (e7-t09)
            if (byKeyboard && next === 'text') openText(middleOfView())
            setKeyCursor(byKeyboard && next !== 'text' ? { at: middleOfView(), down: false } : null)
          }}
          colors={isWhiteboard(share) ? BOARD_COLORS : ANNOTATION_COLORS}
          color={color}
          onColor={setColor}
          width={width}
          onWidth={setWidth}
          compact={box.width < COMPACT_WIDTH}
        />
      )}
    </>
  )
}

const TextBox = styled.textarea`
  position: absolute;
  min-width: 8em;
  max-width: 60%;
  padding: 0;
  border: 1px dashed currentColor;
  border-radius: ${radius.button};
  outline-offset: ${space(0.5)};
  background: transparent;
  line-height: 1.3;
  resize: both;
`

/** Where the pen is: a ring in the pen's colour with a dot, on anything by its dark outline */
const KeyCursor = styled.div<{ $paint: string }>`
  position: absolute;
  width: 20px;
  height: 20px;
  margin: -10px 0 0 -10px;
  border: 2px solid ${({ $paint }) => $paint};
  border-radius: 50%;
  box-shadow: 0 0 0 2px ${colorToken.overlay};
  pointer-events: none;

  &::after {
    content: '';
    position: absolute;
    inset: 6px;
    border-radius: 50%;
    background: ${({ $paint }) => $paint};
  }
`

/** What the keys do now. Always there while drawing, so screen readers hear it change (RULES §1) */
const KeyHint = styled.p<{ $shown: boolean }>`
  position: absolute;
  left: 50%;
  bottom: ${space(16)};
  transform: translateX(-50%);
  width: max-content;
  max-width: calc(100% - ${space(4)});
  margin: 0;
  padding: ${space(1)} ${space(2.5)};
  border-radius: ${radius.button};
  background: ${colorToken.overlay};
  color: ${colorToken.fg};
  font-size: ${fontSize.nameplate};
  pointer-events: none;
  opacity: ${({ $shown }) => ($shown ? 1 : 0)};
`

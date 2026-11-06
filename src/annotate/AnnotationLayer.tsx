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
import { contentToTile, type Point } from '../../shared/shareGeometry.ts'
import { useShareGeometry } from '../components/useShareGeometry.ts'
import { isTypingTarget } from '../room/shortcuts.ts'
import type { ShareAnnotations } from '../components/ShareTile.tsx'
import { strings } from '../strings.ts'
import { annotation, font, radius, space } from '../styles/tokens.ts'
import AnnotationCanvas from './AnnotationCanvas.tsx'
import { drawerFor } from './sync.ts'
import { AnnotationToolbar, type AnnotationMode } from './Toolbar.tsx'

/** A tile narrower than this folds colours and widths behind one button */
const COMPACT_WIDTH = 720

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
      {active && drawer && (
        <AnnotationToolbar
          drawer={drawer}
          mode={mode}
          onMode={(next, byKeyboard) => {
            setMode(next)
            // No pointer to place it with: the middle of what is on screen, then typing
            if (next === 'text' && byKeyboard && rect) {
              const [x, y] = normalizePoint(
                (box.width / 2 - rect.x) / rect.width,
                (box.height / 2 - rect.y) / rect.height,
                spaceOf(share),
              ) ?? [0, 0]
              openText({ x, y })
            }
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

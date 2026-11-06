import { useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import styled from 'styled-components'
import {
  ANNOTATION_COLORS,
  ANNOTATION_WIDTHS,
  type AnnotationColor,
  type AnnotationTool,
  type AnnotationWidth,
} from '../../shared/annotation.ts'
import {
  ArrowToolIcon,
  ChevronUpIcon,
  ClearIcon,
  EraserIcon,
  HighlighterIcon,
  LaserIcon,
  PenIcon,
  RectIcon,
  RedoIcon,
  TextToolIcon,
  UndoIcon,
} from '../components/icons.tsx'
import { strings } from '../strings.ts'
import { annotation, color as colorToken, fontSize, media, radius, space } from '../styles/tokens.ts'
import type { AnnotationDrawer } from './sync.ts'

/** What the pointer does on the picture: a mark's tool, or the two that leave no mark */
export type AnnotationMode = AnnotationTool | 'eraser' | 'laser'

const MODES: readonly AnnotationMode[] = [
  'pen',
  'highlighter',
  'arrow',
  'rect',
  'text',
  'eraser',
  'laser',
]

const MODE_ICON: Readonly<Record<AnnotationMode, () => ReactNode>> = {
  pen: PenIcon,
  highlighter: HighlighterIcon,
  arrow: ArrowToolIcon,
  rect: RectIcon,
  text: TextToolIcon,
  eraser: EraserIcon,
  laser: LaserIcon,
}

/** A line's look in the width buttons, px */
const WIDTH_DOT: Readonly<Record<AnnotationWidth, number>> = { thin: 3, medium: 6, thick: 10 }

export interface AnnotationToolbarProps {
  drawer: AnnotationDrawer
  mode: AnnotationMode
  onMode: (mode: AnnotationMode, byKeyboard: boolean) => void
  /** The colours on offer (the whiteboard leaves out white, J3) */
  colors?: readonly AnnotationColor[]
  color: AnnotationColor
  onColor: (color: AnnotationColor) => void
  width: AnnotationWidth
  onWidth: (width: AnnotationWidth) => void
  /** Colours and widths behind one button: a small tile */
  compact: boolean
}

/**
 * The toolbar over a share (e7-t03, DESIGN.md §4.3): tools, colours, widths, undo, redo, clear; it
 * can be folded away to see the picture. Inside the tile, so it comes along into fullscreen. Every
 * button is a real button with its name and, for the current choice, `aria-pressed`, so the keyboard
 * gets everything by Tab; the arrow keys also move along it.
 */
export function AnnotationToolbar({
  drawer,
  mode,
  onMode,
  colors = ANNOTATION_COLORS,
  color,
  onColor,
  width,
  onWidth,
  compact,
}: AnnotationToolbarProps) {
  useSyncExternalStore(drawer.subscribe, drawer.getVersion)
  const [folded, setFolded] = useState(false)
  const [styleOpen, setStyleOpen] = useState(false)
  const text = strings.annotation

  const moveAlong = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    ]
    const here = buttons.indexOf(event.target as HTMLButtonElement)
    if (here < 0) return
    const step = event.key === 'ArrowRight' ? 1 : -1
    buttons[(here + step + buttons.length) % buttons.length].focus()
    // Ours: not also the zoomed picture moving
    event.preventDefault()
    event.stopPropagation()
  }

  const style = (
    <>
      <Group role="group" aria-label={text.colorGroup}>
        {colors.map((name) => (
          <Swatch
            key={name}
            type="button"
            aria-label={text.colors[name]}
            title={text.colors[name]}
            aria-pressed={color === name}
            $paint={annotation.colors[name]}
            onClick={() => onColor(name)}
          />
        ))}
      </Group>
      <Group role="group" aria-label={text.widthGroup}>
        {ANNOTATION_WIDTHS.map((name) => (
          <Tool
            key={name}
            type="button"
            aria-label={text.widths[name]}
            title={text.widths[name]}
            aria-pressed={width === name}
            onClick={() => onWidth(name)}
          >
            <WidthDot $size={WIDTH_DOT[name]} />
          </Tool>
        ))}
      </Group>
    </>
  )

  return (
    <Bar role="toolbar" aria-label={text.toolbar} onKeyDown={moveAlong}>
      {!folded && (
        <>
          <Group role="group" aria-label={text.toolGroup}>
            {MODES.map((name) => {
              const Icon = MODE_ICON[name]
              return (
                <Tool
                  key={name}
                  type="button"
                  aria-label={text.modes[name]}
                  title={text.modes[name]}
                  aria-pressed={mode === name}
                  // A click from the keyboard has no pointer to place a text mark with
                  onClick={(event) => onMode(name, event.detail === 0)}
                >
                  <Icon />
                </Tool>
              )
            })}
          </Group>
          {compact ? (
            <Tool
              type="button"
              aria-label={text.style}
              title={text.style}
              aria-expanded={styleOpen}
              onClick={() => setStyleOpen((open) => !open)}
            >
              <WidthDot $size={WIDTH_DOT[width]} $paint={annotation.colors[color]} />
            </Tool>
          ) : (
            style
          )}
          <Group role="group" aria-label={text.historyGroup}>
            <Tool
              type="button"
              aria-label={text.undo}
              title={text.undo}
              disabled={!drawer.canUndo}
              onClick={() => drawer.undo()}
            >
              <UndoIcon />
            </Tool>
            <Tool
              type="button"
              aria-label={text.redo}
              title={text.redo}
              disabled={!drawer.canRedo}
              onClick={() => drawer.redo()}
            >
              <RedoIcon />
            </Tool>
            <Tool
              type="button"
              aria-label={text.clear}
              title={text.clear}
              onClick={() => drawer.clearOwn()}
            >
              <ClearIcon />
            </Tool>
          </Group>
        </>
      )}
      <Tool
        type="button"
        aria-label={folded ? text.unfold : text.fold}
        title={folded ? text.unfold : text.fold}
        aria-expanded={!folded}
        $flip={folded}
        onClick={() => setFolded((now) => !now)}
      >
        <ChevronUpIcon />
      </Tool>
      {!folded && compact && styleOpen && <StyleRow>{style}</StyleRow>}
    </Bar>
  )
}

/** The top of the tile, a row below its name and the picker between shares: never over them */
const Bar = styled.div`
  position: absolute;
  top: ${space(12)};
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: ${space(1)};
  width: max-content;
  max-width: calc(100% - ${space(4)});
  padding: ${space(0.5)} ${space(1)};
  border-radius: ${radius.panel};
  background: ${colorToken.overlay};
  color: ${colorToken.fg};
  font-size: ${fontSize.nameplate};
  cursor: default;
  touch-action: manipulation;
`

const Group = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: ${space(0.5)};
`

const StyleRow = styled.div`
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: ${space(1)};
`

const Tool = styled.button<{ $flip?: boolean }>`
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: ${radius.button};
  background: transparent;
  color: inherit;
  cursor: pointer;

  svg {
    width: 18px;
    height: 18px;
    ${({ $flip }) => ($flip ? 'transform: rotate(180deg);' : '')}
  }
  &:hover:not(:disabled) {
    background: ${colorToken.hover};
  }
  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
  &[aria-pressed='true'] {
    background: ${colorToken.primary};
    color: ${colorToken.onPrimary};
  }
  @media ${media.touchPrimary} {
    width: 44px;
    height: 44px;
  }
`

const WidthDot = styled.span<{ $size: number; $paint?: string }>`
  display: block;
  width: ${({ $size }) => $size + 2}px;
  height: ${({ $size }) => $size + 2}px;
  border-radius: 50%;
  background: ${({ $paint }) => $paint ?? 'currentColor'};
  box-shadow: 0 0 0 1px ${colorToken.fg};
`

/** The colour itself, a ring around the chosen one: named too, so never colour alone */
const Swatch = styled.button<{ $paint: string }>`
  width: 24px;
  height: 24px;
  padding: 0;
  border: 2px solid ${colorToken.fg};
  border-radius: 50%;
  background: ${({ $paint }) => $paint};
  background-clip: padding-box;
  cursor: pointer;

  &[aria-pressed='true'] {
    outline: 3px solid ${colorToken.primary};
    outline-offset: 1px;
  }
  @media ${media.touchPrimary} {
    width: 36px;
    height: 36px;
  }
`

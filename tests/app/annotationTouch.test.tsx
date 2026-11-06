import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WHITEBOARD_LAYER } from '../../shared/annotation.ts'
import { AnnotationDrawer } from '../../src/annotate/sync.ts'
import Whiteboard from '../../src/annotate/Whiteboard.tsx'
import { insideWidget } from '../../src/room/shortcuts.ts'
import { AnnotationStore } from '../../src/room/annotationStore.ts'
import { strings } from '../../src/strings.ts'

// J4 (e7-t09; AC-7.1): fingers and the keyboard on the board, through its real gestures and canvas.
// Real fingers are for DEPLOY.md §5; a phone-sized browser's touch events are e2e/whiteboard-j4.spec.ts.

const BOX = { left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0 } as DOMRect

function board(me: string | null = 'me') {
  const sent: unknown[] = []
  const store = new AnnotationStore({ send: (message) => sent.push(message), isOpen: () => true })
  render(<Whiteboard store={store} me={me} manage nameOf={() => null} roomName="週會" />)
  return { store, sent }
}

const sheet = () => screen.getByRole('figure', { name: strings.whiteboard.region })
const canvas = () => within(sheet()).getByRole('img', { name: strings.screenShare.annotationCanvas })
const ids = (store: AnnotationStore) => store.strokes(WHITEBOARD_LAYER).map((stroke) => stroke.tool)
const finger = (id: number, x: number, y: number, primary = id === 1) => ({
  pointerId: id,
  pointerType: 'touch',
  isPrimary: primary,
  button: 0,
  buttons: 1,
  clientX: x,
  clientY: y,
})

const originalContext = HTMLCanvasElement.prototype.getContext
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  vi.stubGlobal('requestAnimationFrame', undefined)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(BOX)
})
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalContext
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fingers on the board', () => {
  it('one finger draws', () => {
    const { store } = board()
    fireEvent.pointerDown(canvas(), finger(1, 100, 100))
    fireEvent.pointerMove(canvas(), finger(1, 150, 120))
    fireEvent.pointerMove(canvas(), finger(1, 200, 180))
    fireEvent.pointerUp(canvas(), finger(1, 200, 180))
    expect(ids(store)).toEqual(['pen'])
    expect(store.strokes(WHITEBOARD_LAYER)[0].points.length).toBeGreaterThan(1)
    // And the sheet stayed where it was
    expect(sheet()).toHaveAttribute('data-zoom', '1')
  })

  it('a second finger takes back the stroke and pinches instead: no mark from a zoom', () => {
    const { store } = board()
    fireEvent.pointerDown(canvas(), finger(1, 100, 300))
    fireEvent.pointerMove(canvas(), finger(1, 110, 300))
    expect(ids(store)).toEqual(['pen'])
    fireEvent.pointerDown(canvas(), finger(2, 300, 300))
    expect(ids(store)).toEqual([])
    fireEvent.pointerMove(canvas(), finger(2, 390, 300))
    fireEvent.pointerMove(canvas(), finger(1, 10, 300))
    expect(Number(sheet().dataset.zoom)).toBeGreaterThan(1)
    fireEvent.pointerUp(canvas(), finger(2, 390, 300))
    // The finger left over does not draw or move anything
    fireEvent.pointerMove(canvas(), finger(1, 60, 300))
    fireEvent.pointerUp(canvas(), finger(1, 60, 300))
    expect(ids(store)).toEqual([])
    // A new finger draws again
    fireEvent.pointerDown(canvas(), finger(3, 100, 100, true))
    fireEvent.pointerMove(canvas(), finger(3, 150, 150, true))
    fireEvent.pointerUp(canvas(), finger(3, 150, 150, true))
    expect(ids(store)).toEqual(['pen'])
  })

  it('two fingers pan, pen out or not: the marks stay on the world', () => {
    const { store } = board()
    const before = sheet().style.backgroundPosition
    fireEvent.pointerDown(canvas(), finger(1, 100, 300))
    fireEvent.pointerDown(canvas(), finger(2, 200, 300))
    fireEvent.pointerMove(canvas(), finger(1, 100, 437))
    fireEvent.pointerMove(canvas(), finger(2, 200, 437))
    expect(sheet().style.backgroundPosition).not.toBe(before)
    expect(ids(store)).toEqual([])
    fireEvent.pointerUp(canvas(), finger(1, 100, 437))
    fireEvent.pointerUp(canvas(), finger(2, 200, 437))
  })

  it('with the pen off, one finger moves the sheet and nothing is drawn', () => {
    const { store } = board()
    fireEvent.click(screen.getByRole('button', { name: strings.whiteboard.pen }))
    const before = sheet().style.backgroundPosition
    fireEvent.pointerDown(sheet(), finger(1, 100, 100))
    fireEvent.pointerMove(sheet(), finger(1, 150, 180))
    expect(sheet().style.backgroundPosition).not.toBe(before)
    expect(ids(store)).toEqual([])
  })

  it('the text tool opens its box on a tap, not when a finger lands (it may be a pinch)', () => {
    board()
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.modes.text }), {
      detail: 1,
    })
    const box = () => screen.queryByRole('textbox', { name: strings.annotation.textLabel })
    fireEvent.pointerDown(canvas(), finger(1, 100, 100))
    expect(box()).toBeNull()
    // Moved too far: a drag, not a tap
    fireEvent.pointerUp(canvas(), finger(1, 180, 100))
    expect(box()).toBeNull()
    // A second finger: a pinch
    fireEvent.pointerDown(canvas(), finger(1, 100, 100))
    fireEvent.pointerDown(canvas(), finger(2, 200, 100))
    fireEvent.pointerUp(canvas(), finger(1, 100, 100))
    fireEvent.pointerUp(canvas(), finger(2, 200, 100))
    expect(box()).toBeNull()
    // A tap
    fireEvent.pointerDown(canvas(), finger(4, 100, 100, true))
    fireEvent.pointerUp(canvas(), finger(4, 102, 101, true))
    expect(box()).not.toBeNull()
  })

  it('the page\'s own gestures are stopped on the board', () => {
    board()
    const gesture = new Event('gesturestart', { cancelable: true })
    sheet().dispatchEvent(gesture)
    expect(gesture.defaultPrevented).toBe(true)
    expect(getComputedStyle(sheet()).touchAction).toBe('none')
    expect(getComputedStyle(sheet()).userSelect).toBe('none')
  })

  it('a press on the toolbar is not a gesture on the board', () => {
    const { store } = board()
    const toolbar = screen.getByRole('toolbar', { name: strings.annotation.toolbar })
    fireEvent.pointerDown(toolbar, finger(1, 100, 100))
    fireEvent.pointerMove(toolbar, finger(1, 150, 100))
    expect(ids(store)).toEqual([])
    expect(sheet()).toHaveAttribute('data-zoom', '1')
  })
})

describe('a small screen', () => {
  it('the toolbar is one row a finger slides along, its colours behind a button', () => {
    board()
    const toolbar = screen.getByRole('toolbar', { name: strings.annotation.toolbar })
    expect(within(toolbar).queryByRole('group', { name: strings.annotation.colorGroup })).toBeNull()
    fireEvent.click(within(toolbar).getByRole('button', { name: strings.annotation.style }))
    expect(within(toolbar).getByRole('group', { name: strings.annotation.colorGroup })).toBeVisible()
    const row = within(toolbar).getByRole('group', { name: strings.annotation.toolGroup })
      .parentElement as HTMLElement
    expect(getComputedStyle(row).overflowX).toBe('auto')
    expect(getComputedStyle(row).touchAction).toBe('pan-x')
    // The view's controls too
    const controls = screen.getByRole('group', { name: strings.whiteboard.viewControls })
    expect(getComputedStyle(controls).overflowX).toBe('auto')
    expect(getComputedStyle(controls).flexWrap).not.toBe('wrap')
  })
})

describe('the keyboard', () => {
  const pick = (name: string) =>
    fireEvent.click(screen.getByRole('button', { name }), { detail: 0 })
  const cursor = () => screen.getByRole('application', { name: strings.annotation.keyboard.cursor })
  const hint = () => document.querySelector('[role="status"]')

  it('draws with the arrow keys: Enter is the pen going down and up', () => {
    const { store } = board()
    pick(strings.annotation.modes.pen)
    expect(cursor()).toHaveFocus()
    expect(hint()?.textContent).toBe(strings.annotation.keyboard.up)
    fireEvent.keyDown(cursor(), { key: 'Enter' })
    expect(hint()?.textContent).toBe(strings.annotation.keyboard.down)
    fireEvent.keyDown(cursor(), { key: 'ArrowRight' })
    fireEvent.keyDown(cursor(), { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(cursor(), { key: 'Enter' })
    expect(hint()?.textContent).toBe(strings.annotation.keyboard.up)
    const [stroke] = store.strokes(WHITEBOARD_LAYER)
    expect(stroke.tool).toBe('pen')
    expect(stroke.points).toHaveLength(3)
    // 100% zoom: 10 px then 40 px, in world units
    expect(stroke.points[1][0] - stroke.points[0][0]).toBeCloseTo(0.01)
    expect(stroke.points[2][1] - stroke.points[1][1]).toBeCloseTo(0.04)
  })

  it('Esc cancels the stroke, then leaves and goes back to the tool', () => {
    const { store } = board()
    pick(strings.annotation.modes.rect)
    fireEvent.keyDown(cursor(), { key: ' ' })
    fireEvent.keyDown(cursor(), { key: 'ArrowRight', shiftKey: true })
    expect(ids(store)).toEqual(['rect'])
    fireEvent.keyDown(cursor(), { key: 'Escape' })
    expect(ids(store)).toEqual([])
    expect(cursor()).toBeInTheDocument()
    fireEvent.keyDown(cursor(), { key: 'Escape' })
    expect(screen.queryByRole('application')).toBeNull()
    expect(screen.getByRole('button', { name: strings.annotation.modes.rect })).toHaveFocus()
  })

  it('its keys are its own: not the sheet moving, nor a room shortcut', () => {
    board()
    pick(strings.annotation.modes.pen)
    const before = sheet().style.backgroundPosition
    fireEvent.keyDown(cursor(), { key: 'ArrowRight' })
    expect(sheet().style.backgroundPosition).toBe(before)
    expect(insideWidget(cursor())).toBe(true)
  })

  it('stays on screen however far the arrows go', () => {
    const { store } = board()
    pick(strings.annotation.modes.arrow)
    fireEvent.keyDown(cursor(), { key: 'Enter' })
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(cursor(), { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(cursor(), { key: 'Enter' })
    // Half of 400 px from the centre at 100%
    expect(store.strokes(WHITEBOARD_LAYER)[0].points[1][0]).toBeCloseTo(0.2)
  })

  it('the eraser takes our own mark under the cursor', () => {
    const { store } = board()
    pick(strings.annotation.modes.pen)
    fireEvent.keyDown(cursor(), { key: 'Enter' })
    fireEvent.keyDown(cursor(), { key: 'ArrowRight' })
    fireEvent.keyDown(cursor(), { key: 'Enter' })
    expect(ids(store)).toEqual(['pen'])
    pick(strings.annotation.modes.eraser)
    expect(hint()?.textContent).toBe(strings.annotation.keyboard.eraser)
    fireEvent.keyDown(cursor(), { key: 'Enter' })
    expect(ids(store)).toEqual([])
  })

  it('the laser follows the arrow keys, and goes when it is left', () => {
    const { store, sent } = board()
    pick(strings.annotation.modes.laser)
    fireEvent.keyDown(cursor(), { key: 'ArrowLeft' })
    expect(store.lasers(WHITEBOARD_LAYER)).toHaveLength(1)
    expect(ids(store)).toEqual([])
    fireEvent.keyDown(cursor(), { key: 'Escape' })
    expect(sent.length).toBeGreaterThan(0)
  })

  it('tabbing away finishes the stroke rather than leaving it hanging', () => {
    const { store } = board()
    pick(strings.annotation.modes.pen)
    fireEvent.keyDown(cursor(), { key: 'Enter' })
    fireEvent.keyDown(cursor(), { key: 'ArrowRight' })
    fireEvent.blur(cursor())
    expect(screen.queryByRole('application')).toBeNull()
    expect(store.active(WHITEBOARD_LAYER).size).toBe(0)
    expect(ids(store)).toEqual(['pen'])
  })

  it('a click with the mouse does not bring it out', () => {
    board()
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.modes.pen }), { detail: 1 })
    expect(screen.queryByRole('application')).toBeNull()
  })
})

describe('someone clears what we are still drawing', () => {
  const clock = { now: () => 1, setTimeout: () => null, clearTimeout: () => {} }
  const bare = () =>
    new AnnotationStore({ send: () => {}, isOpen: () => true })

  it('it does not come back on our screen, and is not in our history', () => {
    const store = bare()
    const drawer = new AnnotationDrawer(store, WHITEBOARD_LAYER, 'me', clock)
    drawer.begin({ tool: 'pen', color: 'rose', width: 'medium', at: { x: 0, y: 0 } })
    drawer.move({ x: 0.1, y: 0 }, 1)
    act(() =>
      store.receive({ t: 'annotation', share: WHITEBOARD_LAYER, by: 'host', ops: [{ op: 'clear' }] }),
    )
    drawer.move({ x: 0.2, y: 0 }, 1)
    expect(store.strokes(WHITEBOARD_LAYER)).toEqual([])
    expect(drawer.drawing).toBe(false)
    drawer.end(1)
    expect(store.strokes(WHITEBOARD_LAYER)).toEqual([])
    expect(drawer.canUndo).toBe(false)
  })

  it('a snapshot arriving in pieces does not look like that', () => {
    const store = bare()
    const drawer = new AnnotationDrawer(store, WHITEBOARD_LAYER, 'me', clock)
    drawer.begin({ tool: 'pen', color: 'rose', width: 'medium', at: { x: 0, y: 0 } })
    store.receive({ t: 'annotations', share: WHITEBOARD_LAYER, strokes: [], reset: true })
    drawer.move({ x: 0.1, y: 0 }, 1)
    expect(drawer.drawing).toBe(true)
    store.receive({ t: 'annotations', share: WHITEBOARD_LAYER, strokes: [], done: true })
    expect(store.strokes(WHITEBOARD_LAYER)).toHaveLength(1)
    expect(drawer.drawing).toBe(true)
  })
})

describe('export', () => {
  it('the board has a button that opens the choices, and Esc closes them', () => {
    board()
    fireEvent.click(screen.getByRole('button', { name: strings.annotation.exportButton }))
    const dialog = screen.getByRole('dialog', { name: strings.annotation.exporting.boardTitle })
    for (const name of [
      strings.annotation.exporting.viewPng,
      strings.annotation.exporting.wholePng,
      strings.annotation.exporting.wholePdf,
    ]) {
      expect(within(dialog).getByRole('button', { name })).toBeEnabled()
    }
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('someone who only watches can export too: it is what a screenshot gives them', () => {
    board(null)
    expect(screen.getByRole('button', { name: strings.annotation.exportButton })).toBeEnabled()
  })
})

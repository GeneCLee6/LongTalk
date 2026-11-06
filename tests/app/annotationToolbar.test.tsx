import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANNOTATION_COLORS } from '../../shared/annotation.ts'
import { contentRect } from '../../shared/shareGeometry.ts'
import AnnotationLayer from '../../src/annotate/AnnotationLayer.tsx'
import { ShareGeometryContext } from '../../src/components/useShareGeometry.ts'
import { AnnotationStore } from '../../src/room/annotationStore.ts'
import { setLocale, strings } from '../../src/strings.ts'

// The toolbar and the pointer on the canvas (e7-t03). Where marks land in pixels is checked in a
// real browser in e2e/local/annotation.spec.ts.

const BOX = { width: 1000, height: 1000 }
const SOURCE = { width: 1600, height: 900 }
const rect = contentRect(BOX, SOURCE)!
const geometry = (width = BOX.width) => ({
  box: { width, height: BOX.height },
  source: SOURCE,
  view: { zoom: 1, cx: 0.5, cy: 0.5 },
  rect,
  pixelRatio: 1,
  clientToContent: (x: number, y: number) => ({
    x: (x - rect.x) / rect.width,
    y: (y - rect.y) / rect.height,
  }),
  contentToClient: () => null,
})

/** Client coordinates of a content point */
const at = (x: number, y: number) => ({
  clientX: rect.x + x * rect.width,
  clientY: rect.y + y * rect.height,
})

function setup({ me = 'me' as string | null, editing = true, width = BOX.width } = {}) {
  const sent: unknown[] = []
  const store = new AnnotationStore({ send: (message) => sent.push(message), isOpen: () => true })
  const view = render(
    <ShareGeometryContext.Provider value={geometry(width)}>
      <AnnotationLayer store={store} share="bob" me={me} nameOf={() => null} editing={editing} />
    </ShareGeometryContext.Provider>,
  )
  const surface = screen.getByRole('img', { name: strings.screenShare.annotationCanvas })
  return { ...view, store, sent, surface }
}

const press = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }), { detail: 1 })

function drag(surface: HTMLElement, from: [number, number], to: [number, number]) {
  const pointer = { pointerId: 1, isPrimary: true, button: 0, pointerType: 'mouse' }
  fireEvent.pointerDown(surface, { ...pointer, ...at(...from) })
  fireEvent.pointerMove(surface, { ...pointer, ...at(...to) })
  fireEvent.pointerUp(surface, { ...pointer, ...at(...to) })
}

const originalContext = HTMLCanvasElement.prototype.getContext
beforeEach(() => {
  // jsdom has no canvas: nothing is painted here
  HTMLCanvasElement.prototype.getContext = () => null
  vi.stubGlobal('requestAnimationFrame', undefined)
})
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalContext
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the toolbar', () => {
  it('has every tool, eight colours, three widths, undo, redo and clear', () => {
    setup()
    const bar = screen.getByRole('toolbar', { name: '標註工具' })
    for (const name of [
      '畫筆',
      '螢光筆',
      '箭頭',
      '矩形',
      '文字',
      '橡皮擦（只擦自己的）',
      '雷射筆（不留筆跡）',
      '玫瑰紅',
      '墨色',
      '細',
      '中',
      '粗',
      '復原',
      '重做',
      '清除我的標註',
      '收合工具列',
    ]) {
      expect(within(bar).getByRole('button', { name })).toBeInTheDocument()
    }
    const colours = within(screen.getByRole('group', { name: '顏色' })).getAllByRole('button')
    expect(colours).toHaveLength(ANNOTATION_COLORS.length)
    expect(within(screen.getByRole('group', { name: '粗細' })).getAllByRole('button')).toHaveLength(3)
  })

  it('is in English too', () => {
    setLocale('en', false)
    setup()
    expect(screen.getByRole('toolbar', { name: 'Annotation tools' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Highlighter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear my marks' })).toBeInTheDocument()
  })

  it('is not there for someone only watching, or with the tools put away', () => {
    setup({ me: null })
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.getByRole('img', { name: '標註畫布' })).toBeInTheDocument()
  })

  it('without the tools out the pointer does nothing here', () => {
    const { surface, store } = setup({ editing: false })
    drag(surface, [0.2, 0.2], [0.6, 0.6])
    expect(store.strokes('bob')).toEqual([])
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('shows which tool, colour and width are chosen', () => {
    setup()
    expect(screen.getByRole('button', { name: '畫筆' })).toHaveAttribute('aria-pressed', 'true')
    press('箭頭')
    expect(screen.getByRole('button', { name: '箭頭' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '畫筆' })).toHaveAttribute('aria-pressed', 'false')
    press('墨色')
    expect(screen.getByRole('button', { name: '墨色' })).toHaveAttribute('aria-pressed', 'true')
    press('粗')
    expect(screen.getByRole('button', { name: '粗' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('folds away and back, and the pen still works folded', () => {
    const { surface, store } = setup()
    press('收合工具列')
    expect(screen.queryByRole('button', { name: '畫筆' })).toBeNull()
    expect(screen.getByRole('button', { name: '展開工具列' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    drag(surface, [0.2, 0.2], [0.6, 0.6])
    expect(store.strokes('bob')).toHaveLength(1)
    press('展開工具列')
    expect(screen.getByRole('button', { name: '畫筆' })).toBeInTheDocument()
  })

  it('on a small tile colours and widths are behind one button', () => {
    setup({ width: 400 })
    expect(screen.queryByRole('group', { name: '顏色' })).toBeNull()
    const style = screen.getByRole('button', { name: '顏色與粗細' })
    expect(style).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(style)
    expect(style).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('group', { name: '顏色' })).toBeInTheDocument()
  })

  it('the arrow keys move along it, without moving the picture', () => {
    setup()
    const pen = screen.getByRole('button', { name: '畫筆' })
    pen.focus()
    const right = fireEvent.keyDown(pen, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '螢光筆' }))
    // preventDefault was called: fireEvent answers false
    expect(right).toBe(false)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(pen)
  })

  it('Ctrl+Z and Ctrl+Y undo and redo, not while typing', () => {
    const { surface, store } = setup()
    drag(surface, [0.2, 0.2], [0.6, 0.6])
    expect(store.strokes('bob')).toHaveLength(1)
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(store.strokes('bob')).toHaveLength(0)
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    expect(store.strokes('bob')).toHaveLength(1)
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true })
    expect(store.strokes('bob')).toHaveLength(1)
    press('文字')
    fireEvent.pointerDown(surface, { pointerId: 1, isPrimary: true, button: 0, ...at(0.5, 0.5) })
    const box = screen.getByRole('textbox', { name: '標註文字' })
    fireEvent.keyDown(box, { key: 'z', ctrlKey: true })
    expect(store.strokes('bob')).toHaveLength(1)
  })

  it('undo and redo are off when there is nothing to do', () => {
    const { surface } = setup()
    expect(screen.getByRole('button', { name: '復原' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重做' })).toBeDisabled()
    drag(surface, [0.2, 0.2], [0.6, 0.6])
    expect(screen.getByRole('button', { name: '復原' })).toBeEnabled()
    press('復原')
    expect(screen.getByRole('button', { name: '重做' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '復原' })).toBeDisabled()
  })
})

describe('the tools on the picture', () => {
  it('each drawing tool makes its kind of mark, in the colour and width chosen', () => {
    const { surface, store } = setup()
    press('藍色')
    press('粗')
    for (const [name, tool] of [
      ['畫筆', 'pen'],
      ['螢光筆', 'highlighter'],
      ['箭頭', 'arrow'],
      ['矩形', 'rect'],
    ]) {
      press(name)
      drag(surface, [0.2, 0.2], [0.6, 0.6])
      expect(store.strokes('bob').at(-1)).toMatchObject({
        tool,
        color: 'blue',
        width: 'thick',
        by: 'me',
      })
    }
  })

  it('the text tool: click, type, Enter; Esc gives up; Shift+Enter is a new line', () => {
    const { surface, store } = setup()
    press('文字')
    const place = () =>
      fireEvent.pointerDown(surface, { pointerId: 1, isPrimary: true, button: 0, ...at(0.5, 0.5) })
    place()
    let box = screen.getByRole('textbox', { name: '標註文字' })
    expect(document.activeElement).toBe(box)
    fireEvent.change(box, { target: { value: '這裡' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(store.strokes('bob')[0]).toMatchObject({
      tool: 'text',
      text: '這裡',
      points: [[0.5, 0.5]],
    })
    place()
    box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: '不要了' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(store.strokes('bob')).toHaveLength(1)
  })

  it('Enter while choosing a character does not finish the text', () => {
    const { surface, store } = setup()
    press('文字')
    fireEvent.pointerDown(surface, { pointerId: 1, isPrimary: true, button: 0, ...at(0.5, 0.5) })
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'ㄋ' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(store.strokes('bob')).toEqual([])
  })

  it('from the keyboard the text tool opens its box in the middle, no pointer needed', () => {
    const { store } = setup()
    fireEvent.click(screen.getByRole('button', { name: '文字' }), { detail: 0 })
    const box = screen.getByRole('textbox', { name: '標註文字' })
    fireEvent.change(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(store.strokes('bob')[0].points).toEqual([[0.5, 0.5]])
  })

  it('the eraser takes my stroke under it, and leaves others\'', () => {
    const { surface, store } = setup()
    act(() =>
      store.receive({
        t: 'annotation',
        share: 'bob',
        by: 'carol',
        ops: [
          {
            op: 'add',
            stroke: {
              id: 'c',
              by: 'carol',
              tool: 'pen',
              color: 'rose',
              width: 'thin',
              points: [
                [0.8, 0.1],
                [0.8, 0.9],
              ],
            },
          },
        ],
      }),
    )
    drag(surface, [0.1, 0.5], [0.5, 0.5])
    expect(store.strokes('bob')).toHaveLength(2)
    press('橡皮擦（只擦自己的）')
    drag(surface, [0.8, 0.5], [0.8, 0.6])
    expect(store.strokes('bob')).toHaveLength(2)
    drag(surface, [0.3, 0.5], [0.3, 0.6])
    expect(store.strokes('bob').map((stroke) => stroke.id)).toEqual(['c'])
  })

  it('clear takes only my marks', () => {
    const { surface, store } = setup()
    act(() =>
      store.receive({
        t: 'annotations',
        share: 'bob',
        strokes: [
          { id: 'c', by: 'carol', tool: 'pen', color: 'rose', width: 'thin', points: [[0.8, 0.1]] },
        ],
        reset: true,
        done: true,
      }),
    )
    drag(surface, [0.1, 0.5], [0.5, 0.5])
    press('清除我的標註')
    expect(store.strokes('bob').map((stroke) => stroke.id)).toEqual(['c'])
  })

  it('the laser leaves no stroke and shows without being pressed, with a mouse', () => {
    const { surface, store } = setup()
    press('雷射筆（不留筆跡）')
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      ...at(0.5, 0.5),
    })
    expect(store.lasers('bob')[0]).toMatchObject({ by: 'me', at: [0.5, 0.5] })
    expect(store.strokes('bob')).toEqual([])
  })

  it('with a finger the laser needs a press, and ends with it', () => {
    const { surface, store } = setup()
    press('雷射筆（不留筆跡）')
    const finger = { pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0 }
    fireEvent.pointerMove(surface, { ...finger, ...at(0.1, 0.1) })
    expect(store.lasers('bob')).toEqual([])
    fireEvent.pointerDown(surface, { ...finger, ...at(0.5, 0.5) })
    fireEvent.pointerMove(surface, { ...finger, ...at(0.6, 0.6) })
    expect(store.lasers('bob')[0].at).toEqual([0.6, 0.6])
    const heardAt = store.lasers('bob')[0].heardAt
    fireEvent.pointerUp(surface, { ...finger, ...at(0.6, 0.6) })
    expect(store.lasers('bob')[0].heardAt).toBeGreaterThanOrEqual(heardAt)
  })
})

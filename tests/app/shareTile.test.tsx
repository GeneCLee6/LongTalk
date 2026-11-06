import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareTile } from '../../src/components/ShareTile.tsx'
import { VideoDemandContext } from '../../src/components/useVideoDemand.ts'
import { chooseLayers, layerForSize, type VideoDemand } from '../../src/media/layers.ts'
import { VideoDemandStore } from '../../src/room/videoDemand.ts'
import AnnotationCanvas from '../../src/annotate/AnnotationCanvas.tsx'
import { drawStroke, drawStrokes } from '../../src/annotate/draw.ts'
import { useShareGeometry, ShareGeometryContext } from '../../src/components/useShareGeometry.ts'
import { canFullscreen } from '../../src/media/capabilities.ts'
import { showsOnPage } from '../../src/room/shortcuts.ts'
import { annotation } from '../../src/styles/tokens.ts'
import type { Stroke } from '../../shared/annotation.ts'
import { contentRect, type Rect } from '../../shared/shareGeometry.ts'

// The share tile's zoom, pan, fullscreen and annotation entry (e3-t11, e7-t02). jsdom has no layout
// and no video: the tile's box and the picture's size are set by hand. Where the pixels land is
// checked in a real browser in e2e/local/annotation.spec.ts.

const BOX = { width: 1000, height: 1000 }
const SOURCE = { width: 1920, height: 1080 }
const track = { kind: 'video', id: 'screen' } as unknown as MediaStreamTrack

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: BOX.width,
    bottom: BOX.height,
    ...BOX,
    toJSON: () => ({}),
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true,
    get: () => SOURCE.width,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true,
    get: () => SOURCE.height,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).videoWidth
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).videoHeight
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled
})

const figure = () => screen.getByRole('figure', { name: 'Bob 分享的畫面' })
const video = () => within(figure()).getByLabelText('Bob 分享的畫面', { selector: 'video' })
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const zoom = () => Number(figure().getAttribute('data-zoom'))

function renderTile(props: Partial<Parameters<typeof ShareTile>[0]> = {}) {
  return render(<ShareTile name="Bob" video={track} {...props} />)
}

describe('the controls', () => {
  it('appear on the main share once there is a picture', () => {
    renderTile()
    expect(screen.getByRole('group', { name: '分享畫面的檢視' })).toBeInTheDocument()
    expect(button('放大')).toBeEnabled()
    expect(button('縮小')).toBeDisabled()
    expect(button('100%，重設縮放')).toHaveTextContent('100%')
  })

  it('are not there while waiting for the share, nor on a strip share', () => {
    render(<ShareTile name="Bob" video={null} />)
    expect(screen.queryByRole('group', { name: '分享畫面的檢視' })).toBeNull()
    render(<ShareTile name="Carol" video={track} onShowMain={() => {}} />)
    expect(screen.queryByRole('group', { name: '分享畫面的檢視' })).toBeNull()
    expect(screen.getByRole('figure', { name: 'Carol 分享的畫面' })).not.toHaveAttribute('tabindex')
  })

  it('+ and − step the zoom, within bounds, moving the video', () => {
    renderTile()
    expect(video().style.transform).toBe('none')
    fireEvent.click(button('放大'))
    expect(zoom()).toBe(1.25)
    expect(video().style.transform).toContain('scale(1.25)')
    expect(button('125%，重設縮放')).toBeEnabled()
    for (let i = 0; i < 20; i++) {
      if (!(button('放大') as HTMLButtonElement).disabled) fireEvent.click(button('放大'))
    }
    expect(zoom()).toBe(4)
    expect(button('放大')).toBeDisabled()
    fireEvent.click(button('400%，重設縮放'))
    expect(zoom()).toBe(1)
    expect(video().style.transform).toBe('none')
  })

  it('stay in English too', async () => {
    const { setLocale } = await import('../../src/strings.ts')
    setLocale('en', false)
    render(<ShareTile name="Bob" video={track} annotator="me" />)
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '100%, reset zoom' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Annotate' })).toBeInTheDocument()
  })
})

describe('gestures', () => {
  it('the wheel zooms at the pointer and does not scroll the page', () => {
    renderTile()
    const event = new WheelEvent('wheel', {
      deltaY: -300,
      clientX: 250,
      clientY: 500,
      bubbles: true,
      cancelable: true,
    })
    act(() => void figure().dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(zoom()).toBeCloseTo(Math.exp(0.6), 2)
  })

  it('a trackpad pinch zooms faster than a wheel', () => {
    renderTile()
    act(
      () =>
        void figure().dispatchEvent(
          new WheelEvent('wheel', { deltaY: -50, ctrlKey: true, bubbles: true, cancelable: true }),
        ),
    )
    expect(zoom()).toBeCloseTo(Math.exp(0.5), 2)
  })

  it('dragging moves a zoomed picture, not a fitted one', () => {
    renderTile()
    const pointer = (x: number, y: number) => ({
      pointerId: 1,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      isPrimary: true,
    })
    fireEvent.pointerDown(figure(), pointer(500, 500))
    fireEvent.pointerMove(figure(), pointer(600, 500))
    fireEvent.pointerUp(figure(), pointer(600, 500))
    expect(video().style.transform).toBe('none')

    fireEvent.click(button('放大'))
    fireEvent.click(button('放大'))
    const before = video().style.transform
    fireEvent.pointerDown(figure(), pointer(500, 500))
    fireEvent.pointerMove(figure(), pointer(450, 500))
    fireEvent.pointerUp(figure(), pointer(450, 500))
    const after = video().style.transform
    expect(after).not.toBe(before)
    // Moving after the release does nothing
    fireEvent.pointerMove(figure(), pointer(100, 500))
    expect(video().style.transform).toBe(after)
  })

  it('a mouse whose release went missing is not dragging when it comes back', () => {
    renderTile()
    fireEvent.click(button('放大'))
    fireEvent.click(button('放大'))
    const press = { pointerId: 1, button: 0, pointerType: 'mouse', isPrimary: true }
    fireEvent.pointerDown(figure(), { ...press, clientX: 500, clientY: 500, buttons: 1 })
    const before = video().style.transform
    fireEvent.pointerMove(figure(), { ...press, clientX: 300, clientY: 500, buttons: 0 })
    fireEvent.pointerMove(figure(), { ...press, clientX: 100, clientY: 500, buttons: 0 })
    expect(video().style.transform).toBe(before)
  })

  it('two fingers pinch: spreading them zooms in', () => {
    renderTile()
    const finger = (id: number, x: number, y = 500) => ({
      pointerId: id,
      clientX: x,
      clientY: y,
      pointerType: 'touch',
      isPrimary: id === 1,
    })
    fireEvent.pointerDown(figure(), finger(1, 400))
    fireEvent.pointerDown(figure(), finger(2, 600))
    fireEvent.pointerMove(figure(), finger(2, 800))
    expect(zoom()).toBeCloseTo(2)
    fireEvent.pointerMove(figure(), finger(1, 200))
    expect(zoom()).toBeCloseTo(3)
    fireEvent.pointerUp(figure(), finger(1, 200))
    fireEvent.pointerUp(figure(), finger(2, 800))
  })

  it('a press on a control is not a drag on the picture', () => {
    renderTile()
    fireEvent.click(button('放大'))
    fireEvent.click(button('放大'))
    const before = video().style.transform
    const control = button('放大')
    fireEvent.pointerDown(control, { pointerId: 1, clientX: 900, clientY: 900, button: 0 })
    fireEvent.pointerMove(control, { pointerId: 1, clientX: 100, clientY: 900 })
    expect(video().style.transform).toBe(before)
  })

  it('keys with focus on the tile: + − 0 and arrows, and they stop there', () => {
    renderTile()
    expect(figure()).toHaveAttribute('tabindex', '0')
    const outer = vi.fn()
    document.body.addEventListener('keydown', outer)
    fireEvent.keyDown(figure(), { key: '+' })
    expect(zoom()).toBe(1.25)
    fireEvent.keyDown(figure(), { key: '=' })
    expect(zoom()).toBe(1.5625)
    const before = video().style.transform
    fireEvent.keyDown(figure(), { key: 'ArrowRight' })
    expect(video().style.transform).not.toBe(before)
    fireEvent.keyDown(figure(), { key: '-' })
    expect(zoom()).toBe(1.25)
    fireEvent.keyDown(figure(), { key: '0' })
    expect(zoom()).toBe(1)
    expect(outer).not.toHaveBeenCalled()
    // At 100% the arrows are not ours (the pager's), nor are modified keys or room shortcuts
    fireEvent.keyDown(figure(), { key: 'ArrowRight' })
    fireEvent.keyDown(figure(), { key: '+', ctrlKey: true })
    fireEvent.keyDown(figure(), { key: 'm' })
    expect(outer).toHaveBeenCalledTimes(3)
    expect(zoom()).toBe(1)
    document.body.removeEventListener('keydown', outer)
  })

  it('leaves keys alone in the picker on the tile', () => {
    renderTile({
      picker: (
        <div role="menu">
          <button type="button">picker item</button>
        </div>
      ),
    })
    fireEvent.keyDown(screen.getByText('picker item'), { key: '+' })
    expect(zoom()).toBe(1)
  })
})

describe('fullscreen', () => {
  const enable = () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
  }

  it('no button where the browser cannot (iPhone Safari), and double-click does nothing', () => {
    expect(canFullscreen()).toBe(false)
    renderTile()
    expect(screen.queryByRole('button', { name: '全螢幕' })).toBeNull()
    const request = vi.fn()
    figure().requestFullscreen = request
    fireEvent.doubleClick(figure())
    expect(request).not.toHaveBeenCalled()
  })

  it('the button, double-click and F all go fullscreen on the tile; it follows the browser', () => {
    enable()
    renderTile({ recording: 'Gene 正在錄影' })
    const request = vi.fn().mockResolvedValue(undefined)
    figure().requestFullscreen = request
    fireEvent.click(button('全螢幕'))
    fireEvent.doubleClick(video())
    fireEvent.keyDown(figure(), { key: 'f' })
    expect(request).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('Gene 正在錄影')).toBeNull()

    // The browser went fullscreen: the top bar's red light is hidden, so the tile says it
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => figure(),
    })
    act(() => void document.dispatchEvent(new Event('fullscreenchange')))
    expect(screen.getByText('Gene 正在錄影')).toBeVisible()
    const exit = vi.fn().mockResolvedValue(undefined)
    document.exitFullscreen = exit
    fireEvent.click(button('離開全螢幕'))
    expect(exit).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null })
    act(() => void document.dispatchEvent(new Event('fullscreenchange')))
    expect(button('全螢幕')).toBeInTheDocument()
    expect(screen.queryByText('Gene 正在錄影')).toBeNull()
    delete (document as unknown as Record<string, unknown>).fullscreenElement
  })

  it('double-clicking a control does not go fullscreen', () => {
    enable()
    renderTile()
    const request = vi.fn().mockResolvedValue(undefined)
    figure().requestFullscreen = request
    fireEvent.doubleClick(button('放大'))
    expect(request).not.toHaveBeenCalled()
  })

  it('shortcuts that show something step out of fullscreen; mic, camera and hand do not', () => {
    for (const action of ['chat', 'participants', 'leave', 'help', 'share'] as const) {
      expect(showsOnPage(action)).toBe(true)
    }
    for (const action of ['mic', 'cam', 'hand', 'close'] as const) {
      expect(showsOnPage(action)).toBe(false)
    }
  })
})

describe('layer selection when zoomed', () => {
  function reportedDemand() {
    const store = new VideoDemandStore()
    render(
      <VideoDemandContext.Provider value={store}>
        <ShareTile name="Bob" video={track} />
      </VideoDemandContext.Provider>,
    )
    return store
  }

  it('reports the drawn size: the zoom times the tile', () => {
    // jsdom's clientWidth is 0: the ResizeObserver stub gives the size
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      },
    )
    const store = reportedDemand()
    act(() => {
      for (const callback of callbacks) {
        callback(
          [{ contentRect: { width: 500, height: 300 } }] as unknown as ResizeObserverEntry[],
          {} as ResizeObserver,
        )
      }
    })
    expect(store.get(track)?.width).toBe(500)
    fireEvent.click(button('放大'))
    fireEvent.click(button('放大'))
    expect(store.get(track)?.width).toBe(781)
    expect(store.get(track)?.height).toBe(469)
    // Back to fit, back to the tile's size
    fireEvent.click(button(/重設縮放/))
    expect(store.get(track)?.width).toBe(500)
    vi.unstubAllGlobals()
  })

  it('a small main share steps up to the top layer when zoomed in, and stays capped there', () => {
    const fitted: VideoDemand = { width: 640, height: 360, visible: true, aspect: 16 / 9 }
    const zoomed: VideoDemand = { ...fitted, width: 640 * 3, height: 360 * 3 }
    expect(layerForSize('screen', fitted, null)).not.toBe('high')
    expect(layerForSize('screen', zoomed, null)).toBe('high')
    const huge = { ...fitted, width: 640 * 40, height: 360 * 40 }
    expect(layerForSize('screen', huge, null)).toBe('high')
    const chosen = chooseLayers(
      [{ key: 'share', kind: 'screen', demand: zoomed, current: null }],
      3_400_000,
    )
    expect(chosen.get('share')).toBe('high')
  })
})

describe('annotation entry', () => {
  it('no button without permission (a null annotator)', () => {
    renderTile()
    expect(screen.queryByRole('button', { name: '標註' })).toBeNull()
  })

  it('says it is only yours for now', () => {
    renderTile({ annotator: 'me' })
    expect(button('標註')).toHaveAttribute('title', '標註（目前只有你看得到，關掉就會清除）')
  })

  it('loads the canvas on the first press, and takes it away on the next', async () => {
    renderTile({ annotator: 'me' })
    expect(screen.queryByRole('img', { name: '標註畫布' })).toBeNull()
    fireEvent.click(button('標註'))
    expect(button('標註')).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('img', { name: '標註畫布' })).toBeInTheDocument()
    fireEvent.click(button('標註'))
    await waitFor(() => expect(screen.queryByRole('img', { name: '標註畫布' })).toBeNull())
  })

  it('while drawing, one pointer does not pan the zoomed picture', async () => {
    renderTile({ annotator: 'me' })
    fireEvent.click(button('放大'))
    fireEvent.click(button('放大'))
    fireEvent.click(button('標註'))
    const surface = await screen.findByRole('img', { name: '標註畫布' })
    const before = video().style.transform
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 500, clientY: 500, isPrimary: true })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 600, clientY: 500, isPrimary: true })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 600, clientY: 500, isPrimary: true })
    expect(video().style.transform).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------

/** A 2D context that records what is drawn */
function fakeContext() {
  const calls: string[] = []
  const points: [string, number, number][] = []
  const log =
    (name: string) =>
    (...args: number[]) => {
      calls.push(name)
      if (args.length >= 2) points.push([name, args[args.length - 2], args[args.length - 1]])
    }
  return {
    calls,
    points,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    lineCap: '',
    lineJoin: '',
    font: '',
    textBaseline: '',
    save: log('save'),
    restore: log('restore'),
    beginPath: log('beginPath'),
    moveTo: log('moveTo'),
    lineTo: log('lineTo'),
    quadraticCurveTo: log('quadraticCurveTo'),
    rect: log('rect'),
    clip: log('clip'),
    stroke: log('stroke'),
    fill: log('fill'),
    arc: log('arc'),
    clearRect: log('clearRect'),
    fillText: (text: string, x: number, y: number) => {
      calls.push(`fillText:${text}`)
      points.push(['fillText', x, y])
    },
  }
}

const context = (fake: ReturnType<typeof fakeContext>) =>
  fake as unknown as CanvasRenderingContext2D

const stroke = (extra: Partial<Stroke>): Stroke => ({
  id: 's',
  by: 'a',
  tool: 'pen',
  color: 'teal',
  width: 'medium',
  points: [
    [0, 0],
    [1, 1],
  ],
  ...extra,
})

const RECT: Rect = { x: 100, y: 50, width: 800, height: 450 }

describe('drawing (device pixels)', () => {
  it('maps points through the rectangle and the pixel ratio', () => {
    const fake = fakeContext()
    drawStroke(context(fake), stroke({}), RECT, 2)
    expect(fake.points).toContainEqual(['moveTo', 200, 100])
    expect(fake.points).toContainEqual(['lineTo', 1800, 1000])
    expect(fake.calls).toContain('stroke')
  })

  it('smooths a path with curves through midpoints', () => {
    const fake = fakeContext()
    drawStroke(
      context(fake),
      stroke({
        points: [
          [0, 0],
          [0.5, 0],
          [1, 1],
        ],
      }),
      RECT,
      1,
    )
    expect(fake.calls).toContain('quadraticCurveTo')
  })

  it('a tap is a dot, not an invisible line', () => {
    const fake = fakeContext()
    drawStroke(context(fake), stroke({ points: [[0.5, 0.5]] }), RECT, 1)
    expect(fake.calls).toContain('arc')
    expect(fake.calls).toContain('fill')
    expect(fake.calls).not.toContain('stroke')
  })

  it('draws an arrow head and a rectangle by its corners', () => {
    const arrow = fakeContext()
    drawStroke(context(arrow), stroke({ tool: 'arrow' }), RECT, 1)
    expect(arrow.calls.filter((call) => call === 'moveTo')).toHaveLength(3)
    const rect = fakeContext()
    drawStroke(context(rect), stroke({ tool: 'rect' }), RECT, 1)
    expect(rect.points).toContainEqual(['rect', 800, 450])
  })

  it('writes each line of a text mark', () => {
    const fake = fakeContext()
    drawStroke(context(fake), stroke({ tool: 'text', points: [[0, 0]], text: 'a\nb' }), RECT, 1)
    expect(fake.calls).toContain('fillText:a')
    expect(fake.calls).toContain('fillText:b')
    const [first, second] = fake.points.filter(([name]) => name === 'fillText')
    expect(second[2]).toBeGreaterThan(first[2])
  })

  it('takes colours from the tokens, and lets a highlighter show through', () => {
    const seen: { strokeStyle: string; alpha: number }[] = []
    const fake = fakeContext()
    const real = fake.stroke
    fake.stroke = (...args: number[]) => {
      seen.push({ strokeStyle: fake.strokeStyle, alpha: fake.globalAlpha })
      real(...args)
    }
    drawStroke(context(fake), stroke({ tool: 'highlighter', color: 'amber' }), RECT, 1)
    expect(seen[0]).toEqual({
      strokeStyle: annotation.colors.amber,
      alpha: annotation.highlighterAlpha,
    })
  })

  it('thickness follows the picture on screen, and never disappears', () => {
    const widths: number[] = []
    const at = (rect: Rect, ratio: number) => {
      const fake = fakeContext()
      const real = fake.stroke
      fake.stroke = (...args: number[]) => {
        widths.push(fake.lineWidth)
        real(...args)
      }
      drawStroke(context(fake), stroke({ width: 'thin' }), rect, ratio)
    }
    at(RECT, 1)
    at({ ...RECT, width: 1600, height: 900 }, 1)
    at({ ...RECT, width: 80, height: 45 }, 2)
    expect(widths[1]).toBeCloseTo(widths[0] * 2)
    expect(widths[2]).toBe(2)
  })

  it('clears, then clips to the picture: nothing on the letterbox bars', () => {
    const fake = fakeContext()
    drawStrokes(context(fake), [stroke({})], RECT, 2, { width: 2000, height: 2000 })
    expect(fake.calls[0]).toBe('clearRect')
    expect(fake.points).toContainEqual(['rect', 1600, 900])
    expect(fake.calls.indexOf('clip')).toBeLessThan(fake.calls.indexOf('stroke'))
  })
})

describe('AnnotationCanvas', () => {
  const rect = contentRect(BOX, SOURCE)!
  const geometry = (pixelRatio = 2) => ({
    box: BOX,
    source: SOURCE,
    view: { zoom: 1, cx: 0.5, cy: 0.5 },
    rect,
    pixelRatio,
    clientToContent: (x: number, y: number) => ({
      x: (x - rect.x) / rect.width,
      y: (y - rect.y) / rect.height,
    }),
    contentToClient: () => null,
  })
  let fake: ReturnType<typeof fakeContext>

  beforeEach(() => {
    fake = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context(fake) as never)
    // Without it the canvas paints at once rather than at the next frame
    vi.stubGlobal('requestAnimationFrame', undefined)
  })

  afterEach(() => vi.unstubAllGlobals())

  function renderCanvas(pixelRatio = 2) {
    const view = render(
      <ShareGeometryContext.Provider value={geometry(pixelRatio)}>
        <AnnotationCanvas by="me" />
      </ShareGeometryContext.Provider>,
    )
    return { ...view, surface: screen.getByRole('img', { name: '標註畫布' }) as HTMLCanvasElement }
  }

  const strokes = () => fake.calls.filter((call) => call === 'stroke').length

  it('its backing store is the tile times the pixel ratio', () => {
    const { surface } = renderCanvas(2)
    expect(surface.width).toBe(2000)
    expect(surface.height).toBe(2000)
  })

  it('a resize or a new pixel ratio resizes it and draws again', () => {
    const { surface, rerender } = renderCanvas(1)
    expect(surface.width).toBe(1000)
    rerender(
      <ShareGeometryContext.Provider value={geometry(3)}>
        <AnnotationCanvas by="me" />
      </ShareGeometryContext.Provider>,
    )
    expect(surface.width).toBe(3000)
  })

  it('draws a stroke with the pointer, keeps it after lifting', () => {
    const { surface } = renderCanvas()
    fireEvent.pointerDown(surface, {
      pointerId: 1,
      clientX: 300,
      clientY: 400,
      button: 0,
      isPrimary: true,
    })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 500, clientY: 500, isPrimary: true })
    expect(strokes()).toBeGreaterThan(0)
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 500, clientY: 500, isPrimary: true })
    const after = strokes()
    expect(after).toBeGreaterThan(0)
    // Later repaints still have it
    fireEvent.pointerDown(surface, {
      pointerId: 2,
      clientX: 600,
      clientY: 400,
      button: 0,
      isPrimary: true,
    })
    expect(strokes()).toBeGreaterThan(after)
  })

  it('a press on the letterbox bars draws nothing', () => {
    const { surface } = renderCanvas()
    fireEvent.pointerDown(surface, {
      pointerId: 1,
      clientX: 500,
      clientY: 50,
      button: 0,
      isPrimary: true,
    })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 500, clientY: 500, isPrimary: true })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 500, clientY: 500, isPrimary: true })
    expect(strokes()).toBe(0)
  })

  it('a second finger cancels the stroke, leaving no mark', () => {
    const { surface } = renderCanvas()
    fireEvent.pointerDown(surface, {
      pointerId: 1,
      clientX: 300,
      clientY: 400,
      button: 0,
      isPrimary: true,
    })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 500, clientY: 500, isPrimary: true })
    fake.calls.length = 0
    fireEvent.pointerDown(surface, {
      pointerId: 2,
      clientX: 700,
      clientY: 500,
      isPrimary: false,
    })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 500, clientY: 500, isPrimary: true })
    expect(strokes()).toBe(0)
  })

  it('a cancelled pointer leaves no mark', () => {
    const { surface } = renderCanvas()
    fireEvent.pointerDown(surface, {
      pointerId: 1,
      clientX: 300,
      clientY: 400,
      button: 0,
      isPrimary: true,
    })
    fireEvent.pointerCancel(surface, { pointerId: 1 })
    fake.calls.length = 0
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 500, clientY: 500, isPrimary: true })
    expect(strokes()).toBe(0)
  })

  it('outside any share tile the geometry says there is no picture', () => {
    function Probe() {
      const { rect: nothing, clientToContent, contentToClient } = useShareGeometry()
      return (
        <p>
          {String(nothing)} {String(clientToContent(1, 1))}{' '}
          {String(contentToClient({ x: 0, y: 0 }))}
        </p>
      )
    }
    render(<Probe />)
    expect(screen.getByText('null null null')).toBeVisible()
  })
})

describe('the geometry a child of the tile sees', () => {
  function Probe() {
    const { rect, view, clientToContent, contentToClient, pixelRatio } = useShareGeometry()
    const at = clientToContent(500, 500)
    const back = contentToClient({ x: 0, y: 0 })
    return <output>{JSON.stringify({ rect, zoom: view.zoom, at, back, pixelRatio })}</output>
  }

  it('maps screen to content through the letterbox, and follows the zoom', () => {
    // The probe sits in the tile through the picker slot, like J2's toolbar will
    renderTile({ picker: <Probe /> })
    const read = () => JSON.parse(screen.getByRole('status').textContent ?? '{}')
    const fitted = read()
    expect(fitted.rect.width).toBe(1000)
    expect(fitted.rect.height).toBeCloseTo(562.5)
    expect(fitted.at.x).toBeCloseTo(0.5)
    expect(fitted.at.y).toBeCloseTo(0.5)
    expect(fitted.back.y).toBeCloseTo(218.75)
    fireEvent.click(button('放大'))
    const zoomed = read()
    expect(zoomed.zoom).toBe(1.25)
    expect(zoomed.rect.width).toBe(1250)
    expect(zoomed.at.x).toBeCloseTo(0.5)
  })
})

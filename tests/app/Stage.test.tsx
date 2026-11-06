import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Stage } from '../../src/components/Stage.tsx'
import { Tile } from '../../src/components/Tile.tsx'
import { TileSeat } from '../../src/components/TileSeat.tsx'
import { VideoDemandContext } from '../../src/components/useVideoDemand.ts'
import { VideoDemandStore } from '../../src/room/videoDemand.ts'
import { strings } from '../../src/strings.ts'

/** A ResizeObserver the test drives: resize(width, height) reports a new content box */
class FakeResizeObserver {
  static last: FakeResizeObserver | null = null
  readonly callback: ResizeObserverCallback
  disconnected = false
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.last = this
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
  resize(width: number, height: number) {
    act(() =>
      this.callback(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      ),
    )
  }
}

const tiles = (count: number) =>
  Array.from({ length: count }, (_, i) => <figure key={`m${i}`} aria-label={`m${i}`} />)

beforeEach(() => vi.stubGlobal('ResizeObserver', FakeResizeObserver))
afterEach(() => vi.unstubAllGlobals())

describe('Stage (e4-t04)', () => {
  it('lays the tiles out for the space it has and re-lays them out on resize', () => {
    const { rerender, unmount } = render(<Stage>{tiles(4)}</Stage>)
    const grid = screen.getByRole('region', { name: strings.room.grid })
    FakeResizeObserver.last!.resize(1280, 720)
    expect(grid).toHaveAttribute('data-cols', '2')
    expect(grid).toHaveAttribute('data-rows', '2')
    const cell = screen.getByRole('figure', { name: 'm0' }).parentElement!
    expect(cell.style.width).toBe('632px')
    expect(cell.style.height).toBe('355px')

    // Narrowed to a phone held upright: square tiles, two by two
    FakeResizeObserver.last!.resize(390, 700)
    expect(grid).toHaveAttribute('data-cols', '2')
    expect(grid).toHaveAttribute('data-rows', '2')
    expect(cell.style.width).toBe('191px')
    expect(cell.style.height).toBe('191px')

    // Someone joins: the same space, more tiles
    FakeResizeObserver.last!.resize(1280, 720)
    rerender(<Stage>{tiles(8)}</Stage>)
    expect(grid).toHaveAttribute('data-cols', '3')
    expect(grid).toHaveAttribute('data-rows', '3')
    expect(screen.getAllByRole('figure')).toHaveLength(8)

    unmount()
    expect(FakeResizeObserver.last!.disconnected).toBe(true)
  })

  it('keeps the tiles even before it is measured', () => {
    render(<Stage>{tiles(2)}</Stage>)
    expect(screen.getAllByRole('figure')).toHaveLength(2)
    expect(screen.getByRole('region', { name: strings.room.grid })).toHaveAttribute(
      'data-cols',
      '0',
    )
  })
})

const video = { kind: 'video' } as MediaStreamTrack
const videoTiles = (count: number) =>
  Array.from({ length: count }, (_, i) => <Tile key={`m${i}`} name={`m${i}`} video={video} />)
const playing = () => screen.queryAllByLabelText(/的畫面$/).map((v) => v.getAttribute('aria-label'))

describe('Stage, paged (e4-t07, a phone held upright)', () => {
  it('shows one page of up to four without page controls', () => {
    render(<Stage mode="paged">{videoTiles(4)}</Stage>)
    FakeResizeObserver.last!.resize(374, 560)
    const pager = screen.getByRole('region', { name: strings.room.grid })
    expect(pager).toHaveAttribute('data-cols', '2')
    expect(pager).toHaveAttribute('data-rows', '2')
    expect(pager).toHaveAttribute('data-pages', '1')
    expect(screen.queryByRole('group', { name: strings.stage.pages })).toBeNull()
    expect(playing()).toHaveLength(4)
  })

  it('pages four at a time; only the page in view plays video', () => {
    render(<Stage mode="paged">{videoTiles(6)}</Stage>)
    FakeResizeObserver.last!.resize(374, 560)
    const pager = screen.getByRole('region', { name: strings.room.grid })
    expect(pager).toHaveAttribute('data-pages', '2')
    const first = screen.getByRole('group', { name: strings.stage.page(1, 2) })
    const second = screen.getByRole('group', { name: strings.stage.page(2, 2) })
    expect(within(first).getAllByRole('figure')).toHaveLength(4)
    expect(within(second).getAllByRole('figure')).toHaveLength(2)
    // Every tile is there (names, mute marks); the second page's without video
    expect(playing()).toEqual(['m0 的畫面', 'm1 的畫面', 'm2 的畫面', 'm3 的畫面'])

    const dots = screen.getByRole('group', { name: strings.stage.pages })
    const [dot1, dot2] = within(dots).getAllByRole('button')
    expect(dot1).toHaveAttribute('aria-current', 'true')
    fireEvent.click(dot2)
    expect(dot2).toHaveAttribute('aria-current', 'true')
    expect(dot1).not.toHaveAttribute('aria-current')
    expect(playing()).toEqual(['m4 的畫面', 'm5 的畫面'])

    // Previous / next, for a mouse (jsdom has none: hidden), with the ends disabled
    const step = (name: string) =>
      document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!
    expect(step(strings.stage.next)).toBeDisabled()
    fireEvent.click(step(strings.stage.previous))
    expect(pager).toHaveAttribute('data-page', '0')
    expect(step(strings.stage.previous)).toBeDisabled()
  })

  it('turns pages with the keyboard once it has focus', () => {
    render(<Stage mode="paged">{videoTiles(9)}</Stage>)
    FakeResizeObserver.last!.resize(374, 560)
    const pager = screen.getByRole('region', { name: strings.room.grid })
    expect(pager).toHaveAttribute('tabindex', '0')
    expect(pager).toHaveAccessibleDescription(strings.stage.hint)
    fireEvent.keyDown(pager, { key: 'ArrowRight' })
    expect(pager).toHaveAttribute('data-page', '1')
    fireEvent.keyDown(pager, { key: 'End' })
    expect(pager).toHaveAttribute('data-page', '2')
    fireEvent.keyDown(pager, { key: 'ArrowRight' })
    expect(pager).toHaveAttribute('data-page', '2')
    fireEvent.keyDown(pager, { key: 'PageUp' })
    expect(pager).toHaveAttribute('data-page', '1')
    fireEvent.keyDown(pager, { key: 'Home' })
    expect(pager).toHaveAttribute('data-page', '0')
  })

  it('follows a swipe: both pages play while both show, then the one it lands on', () => {
    render(<Stage mode="paged">{videoTiles(6)}</Stage>)
    FakeResizeObserver.last!.resize(374, 560)
    const pager = screen.getByRole('region', { name: strings.room.grid })
    Object.defineProperty(pager, 'clientWidth', { value: 374, configurable: true })
    pager.scrollLeft = 120
    fireEvent.scroll(pager)
    expect(playing()).toHaveLength(6)
    expect(pager).toHaveAttribute('data-page', '0')
    pager.scrollLeft = 374
    fireEvent.scroll(pager)
    expect(pager).toHaveAttribute('data-page', '1')
    expect(playing()).toEqual(['m4 的畫面', 'm5 的畫面'])
  })

  it('stays on a page that still exists when people leave', () => {
    const { rerender } = render(<Stage mode="paged">{videoTiles(6)}</Stage>)
    FakeResizeObserver.last!.resize(374, 560)
    fireEvent.click(screen.getByRole('button', { name: strings.stage.page(2, 2) }))
    rerender(<Stage mode="paged">{videoTiles(4)}</Stage>)
    const pager = screen.getByRole('region', { name: strings.room.grid })
    expect(pager).toHaveAttribute('data-pages', '1')
    expect(pager).toHaveAttribute('data-page', '0')
    expect(playing()).toHaveLength(4)
  })
})

describe('Stage, speaker (e4-t07, a phone held sideways)', () => {
  it('shows the speaker big and the others in a strip', () => {
    const { rerender } = render(
      <Stage mode="speaker" speaker={2}>
        {videoTiles(4)}
      </Stage>,
    )
    FakeResizeObserver.last!.resize(812, 290)
    const stage = screen.getByRole('region', { name: strings.room.grid })
    expect(stage).toHaveAttribute('data-mode', 'speaker')
    const main = stage.querySelector('[data-speaker]')!
    expect(within(main as HTMLElement).getByRole('figure')).toHaveAccessibleName('m2')
    const strip = screen.getByLabelText(strings.stage.strip)
    expect(
      within(strip)
        .getAllByRole('figure')
        .map((f) => f.getAttribute('aria-label')),
    ).toEqual(['m0', 'm1', 'm3'])
    expect((main as HTMLElement).style.height).toBe('289px')
    // Someone else speaks: they take the big tile
    rerender(
      <Stage mode="speaker" speaker={0}>
        {videoTiles(4)}
      </Stage>,
    )
    expect(
      within(stage.querySelector('[data-speaker]') as HTMLElement).getByRole('figure'),
    ).toHaveAccessibleName('m0')
  })

  it('is the plain gallery for one person', () => {
    render(<Stage mode="speaker">{videoTiles(1)}</Stage>)
    expect(screen.getByRole('region', { name: strings.room.grid })).toHaveAttribute(
      'data-mode',
      'grid',
    )
  })
})

describe('Stage, a large room on a desktop (L1, e10-t02)', () => {
  it('stays one grid up to sixteen tiles', () => {
    render(<Stage>{tiles(16)}</Stage>)
    expect(screen.getByRole('region', { name: strings.room.grid })).toHaveAttribute(
      'data-mode',
      'grid',
    )
  })

  it('goes to pages of sixteen past that, with an indicator and the keyboard', () => {
    render(<Stage>{tiles(25)}</Stage>)
    FakeResizeObserver.last!.resize(1000, 640)
    const pager = screen.getByRole('region', { name: strings.room.grid })
    expect(pager).toHaveAttribute('data-mode', 'paged')
    expect(pager).toHaveAttribute('data-pages', '2')
    const first = screen.getByRole('group', { name: strings.stage.page(1, 2) })
    expect(within(first).getAllByRole('figure')).toHaveLength(16)
    const dots = screen.getByRole('group', { name: strings.stage.pages })
    expect(within(dots).getAllByRole('button')).toHaveLength(2)
    fireEvent.keyDown(pager, { key: 'PageDown' })
    expect(pager).toHaveAttribute('data-page', '1')
    fireEvent.keyDown(pager, { key: 'Home' })
    expect(pager).toHaveAttribute('data-page', '0')
  })

  it('moves the speaker on another page to the side, and back when their page is shown', () => {
    render(<Stage sideSpeaker={20}>{tiles(25)}</Stage>)
    FakeResizeObserver.last!.resize(1000, 640)
    const side = screen.getByRole('group', { name: strings.stage.sideSpeaker })
    expect(within(side).getByRole('figure', { name: 'm20' })).toBeInTheDocument()
    const pager = screen.getByRole('region', { name: strings.room.grid })
    expect(within(pager).queryByRole('figure', { name: 'm20' })).toBeNull()
    fireEvent.keyDown(pager, { key: 'End' })
    expect(within(side).queryByRole('figure', { name: 'm20' })).toBeNull()
    expect(within(pager).getByRole('figure', { name: 'm20' })).toBeInTheDocument()
  })

  it('shows nobody at the side when the speaker is on this page, or nobody has spoken', () => {
    const { rerender } = render(<Stage sideSpeaker={2}>{tiles(25)}</Stage>)
    const side = screen.getByRole('group', { name: strings.stage.sideSpeaker })
    expect(within(side).queryByRole('figure')).toBeNull()
    rerender(<Stage sideSpeaker={null}>{tiles(25)}</Stage>)
    expect(within(side).queryByRole('figure')).toBeNull()
  })

  it('a phone stays at four a page with no side column', () => {
    render(
      <Stage mode="paged" sideSpeaker={5}>
        {tiles(6)}
      </Stage>,
    )
    expect(screen.queryByRole('group', { name: strings.stage.sideSpeaker })).toBeNull()
    FakeResizeObserver.last!.resize(374, 560)
    const first = screen.getByRole('group', { name: strings.stage.page(1, 2) })
    expect(within(first).getAllByRole('figure')).toHaveLength(4)
  })

  it('reports each tile in its pager as in sight or not, and the pointer on a button as near', () => {
    const store = new VideoDemandStore()
    const cells = Array.from({ length: 17 }, (_, i) => (
      <TileSeat key={`m${i}`} camera={`cam${i}`}>
        <figure aria-label={`m${i}`} />
      </TileSeat>
    ))
    render(
      <VideoDemandContext.Provider value={store}>
        <Stage>{cells}</Stage>
      </VideoDemandContext.Provider>,
    )
    FakeResizeObserver.last!.resize(1000, 640)
    expect(store.inSight().has('cam0')).toBe(true)
    expect(store.inSight().has('cam16')).toBe(false)
    const next = screen.getByRole('button', { name: strings.stage.page(2, 2) })
    fireEvent.pointerEnter(next)
    expect(store.inSight().has('cam16')).toBe(true)
    expect(store.seatDemand('cam16')).toMatchObject({ visible: false })
    fireEvent.pointerLeave(next)
    expect(store.inSight().has('cam16')).toBe(false)
    fireEvent.click(next)
    expect(store.inSight().has('cam16')).toBe(true)
    expect(store.inSight().has('cam0')).toBe(false)
  })
})

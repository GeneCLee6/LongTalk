import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Stage } from '../../src/components/Stage.tsx'
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

import { describe, expect, it } from 'vitest'
import {
  clampPage,
  DEFAULT_GRID_GAP,
  DEFAULT_TILE_ASPECT,
  gridLayout,
  MAX_GRID_TILES,
  pageCount,
  pagedLayout,
  pageRange,
  pagesInView,
  PHONE_PAGE_SIZE,
  pickSpeaker,
  PORTRAIT_TILE_ASPECT,
  shareLayout,
  speakerLayout,
  tileAspect,
} from '../../shared/layout.ts'

const ASPECT = 16 / 9
const GAP = DEFAULT_GRID_GAP

/** Five container shapes (e4 risk table): wide desktop, 16:9, 4:3, square, phone portrait */
const containers = {
  ultrawide: { width: 2000, height: 700 },
  wide: { width: 1280, height: 720 },
  standard: { width: 1024, height: 768 },
  square: { width: 800, height: 800 },
  portrait: { width: 390, height: 700 },
} as const

const counts = Array.from({ length: MAX_GRID_TILES }, (_, i) => i + 1)

const shape = (count: number, size: { width: number; height: number }) => {
  const { cols, rows } = gridLayout({ count, ...size })
  return `${cols}x${rows}`
}

describe('gridLayout (e4-t04, AC-4.3)', () => {
  describe.each(Object.entries(containers))('in a %s container', (_, size) => {
    it.each(counts)('fits %i tiles without overflow, gaps and the aspect ratio kept', (count) => {
      const grid = gridLayout({ count, ...size })
      // Enough cells, and no whole row left empty
      expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(count)
      expect((grid.rows - 1) * grid.cols).toBeLessThan(count)
      expect(grid.tileWidth).toBeGreaterThan(0)
      expect(Number.isInteger(grid.tileWidth) && Number.isInteger(grid.tileHeight)).toBe(true)
      expect(Math.abs(grid.tileWidth / grid.tileHeight - ASPECT)).toBeLessThan(0.02)
      expect(grid.width).toBe(grid.cols * grid.tileWidth + (grid.cols - 1) * GAP)
      expect(grid.height).toBe(grid.rows * grid.tileHeight + (grid.rows - 1) * GAP)
      expect(grid.width).toBeLessThanOrEqual(size.width)
      expect(grid.height).toBeLessThanOrEqual(size.height)
    })

    it('makes tiles smaller (never bigger) as people join', () => {
      const widths = counts.map((count) => gridLayout({ count, ...size }).tileWidth)
      for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThanOrEqual(widths[i - 1])
    })

    it('fills the container on one side: no other grid has bigger tiles', () => {
      for (const count of counts) {
        const grid = gridLayout({ count, ...size })
        const freeWidth = size.width - grid.width
        const freeHeight = size.height - grid.height
        // Bounded by the width or by the height, within a pixel per column / row of rounding
        expect(Math.min(freeWidth / grid.cols, (freeHeight / grid.rows) * ASPECT)).toBeLessThan(2)
      }
    })
  })

  it('lays out the usual cases like Zoom does on a 16:9 screen', () => {
    const wide = containers.wide
    expect(counts.map((count) => shape(count, wide))).toEqual([
      '1x1',
      '2x1',
      '2x2',
      '2x2',
      '3x2',
      '3x2',
      '3x3',
      '3x3',
    ])
  })

  it('puts tiles side by side when wide and stacks them when tall', () => {
    expect(shape(3, containers.ultrawide)).toBe('3x1')
    expect(shape(4, containers.ultrawide)).toBe('2x2')
    expect(shape(2, containers.portrait)).toBe('1x2')
    expect(shape(4, containers.portrait)).toBe('1x4')
    expect(shape(8, containers.portrait)).toBe('2x4')
  })

  it('one tile takes the whole width or the whole height', () => {
    expect(gridLayout({ count: 1, width: 1280, height: 720 })).toEqual({
      cols: 1,
      rows: 1,
      tileWidth: 1280,
      tileHeight: 720,
      width: 1280,
      height: 720,
    })
    expect(gridLayout({ count: 1, width: 1600, height: 450 }).tileWidth).toBe(800)
    expect(gridLayout({ count: 1, width: 390, height: 700 }).tileHeight).toBe(219)
  })

  it('reflows as the container is resized: wider never means smaller tiles', () => {
    for (const count of counts) {
      let previous = 0
      for (let width = 320; width <= 2400; width += 40) {
        const { tileWidth } = gridLayout({ count, width, height: 720 })
        expect(tileWidth).toBeGreaterThanOrEqual(previous)
        previous = tileWidth
      }
    }
    // A desktop window narrowed to a phone's width goes from a row of two to a column of two
    expect(shape(2, { width: 1280, height: 600 })).toBe('2x1')
    expect(shape(2, { width: 420, height: 600 })).toBe('1x2')
  })

  it('takes another aspect ratio and gap', () => {
    const grid = gridLayout({ count: 4, width: 808, height: 808, aspect: 1, gap: 8 })
    expect(grid).toMatchObject({ cols: 2, rows: 2, tileWidth: 400, tileHeight: 400 })
    expect(gridLayout({ count: 2, width: 400, height: 300, gap: 0 })).toMatchObject({
      cols: 1,
      rows: 2,
      width: 266,
    })
  })

  it('gives an empty grid for nothing to lay out or no room', () => {
    const empty = { cols: 0, rows: 0, tileWidth: 0, tileHeight: 0, width: 0, height: 0 }
    expect(gridLayout({ count: 0, width: 800, height: 600 })).toEqual(empty)
    expect(gridLayout({ count: 3, width: 0, height: 600 })).toEqual(empty)
    expect(gridLayout({ count: 3, width: 800, height: -1 })).toEqual(empty)
    expect(gridLayout({ count: Number.NaN, width: 800, height: 600 })).toEqual(empty)
    expect(gridLayout({ count: 8, width: 20, height: 20, gap: 8 })).toEqual(empty)
  })

  it('uses square tiles in a portrait container, so a phone gets a 2 × 2 grid like the mockup', () => {
    expect(tileAspect(1280, 720)).toBe(DEFAULT_TILE_ASPECT)
    expect(tileAspect(800, 800)).toBe(DEFAULT_TILE_ASPECT)
    expect(tileAspect(390, 700)).toBe(PORTRAIT_TILE_ASPECT)
    const portrait = (count: number) => {
      const grid = gridLayout({ count, width: 390, height: 700, aspect: tileAspect(390, 700) })
      expect(grid.tileWidth).toBe(grid.tileHeight)
      expect(grid.height).toBeLessThanOrEqual(700)
      return `${grid.cols}x${grid.rows}`
    }
    expect(counts.map(portrait)).toEqual(['1x1', '1x2', '1x3', '2x2', '2x3', '2x3', '2x4', '2x4'])
  })
})

describe('phone paging (e4-t07, AC-4.6)', () => {
  it('counts pages of four', () => {
    expect([0, 1, 4, 5, 8, 9, 16].map((n) => pageCount(n))).toEqual([0, 1, 1, 2, 2, 3, 4])
    expect(PHONE_PAGE_SIZE).toBe(4)
    expect(pageCount(6, 3)).toBe(2)
    expect(pageCount(-1)).toBe(0)
    expect(pageCount(Number.NaN)).toBe(0)
  })

  it('keeps a page index on an existing page', () => {
    expect(clampPage(0, 2)).toBe(0)
    expect(clampPage(5, 2)).toBe(1)
    expect(clampPage(-3, 2)).toBe(0)
    expect(clampPage(1, 0)).toBe(0)
    expect(clampPage(Number.NaN, 3)).toBe(0)
    expect(clampPage(1.4, 3)).toBe(1)
  })

  it('slices the tiles of a page; the last page may be short', () => {
    expect(pageRange(0, 6)).toEqual({ start: 0, end: 4 })
    expect(pageRange(1, 6)).toEqual({ start: 4, end: 6 })
    // Past the end (someone left while we were on the last page): the last page
    expect(pageRange(3, 6)).toEqual({ start: 4, end: 6 })
    expect(pageRange(0, 0)).toEqual({ start: 0, end: 0 })
  })

  it('tells which pages a swipe shows', () => {
    const width = 390
    expect(pagesInView(0, width, 2)).toEqual({ first: 0, last: 0, current: 0 })
    // Mid-swipe: both pages are on screen, the dots follow the one mostly shown
    expect(pagesInView(100, width, 2)).toEqual({ first: 0, last: 1, current: 0 })
    expect(pagesInView(250, width, 2)).toEqual({ first: 0, last: 1, current: 1 })
    expect(pagesInView(390, width, 2)).toEqual({ first: 1, last: 1, current: 1 })
    // Sub-pixel offsets and overscroll do not count as the next page
    expect(pagesInView(389.8, width, 2)).toEqual({ first: 1, last: 1, current: 1 })
    expect(pagesInView(0.4, width, 2)).toEqual({ first: 0, last: 0, current: 0 })
    expect(pagesInView(-30, width, 2)).toEqual({ first: 0, last: 0, current: 0 })
    expect(pagesInView(900, width, 2)).toEqual({ first: 1, last: 1, current: 1 })
    expect(pagesInView(100, 0, 2)).toEqual({ first: 0, last: 0, current: 0 })
  })

  it('lays every page out for a full page, two by two on a phone held upright', () => {
    const phone = { width: 374, height: 560 }
    const aspect = tileAspect(phone.width, phone.height)
    const four = pagedLayout({ count: 4, ...phone, aspect })
    expect(four).toMatchObject({ cols: 2, rows: 2, pages: 1 })
    for (const count of [5, 6, 8]) {
      const paged = pagedLayout({ count, ...phone, aspect })
      // The same tile size on every page, whatever the count
      expect(paged).toEqual({ ...four, pages: 2 })
    }
    expect(pagedLayout({ count: 9, ...phone, aspect }).pages).toBe(3)
    // Fewer than a page: the gallery's own layout
    expect(pagedLayout({ count: 3, ...phone, aspect })).toEqual({
      ...gridLayout({ count: 3, ...phone, aspect }),
      pages: 1,
    })
    expect(pagedLayout({ count: 0, ...phone, aspect }).pages).toBe(0)
  })
})

describe('speakerLayout (e4-t07, a phone held sideways)', () => {
  const landscape = { width: 812, height: 290 }

  it('gives one person the whole stage', () => {
    const { main, strip } = speakerLayout({ count: 1, ...landscape })
    expect(strip).toBeNull()
    expect(main.height).toBeGreaterThanOrEqual(289)
    expect(main.width).toBeLessThanOrEqual(812)
  })

  it('puts the others in a column on the right of a wide stage, everything within it', () => {
    for (let count = 2; count <= MAX_GRID_TILES; count++) {
      const { main, strip } = speakerLayout({ count, ...landscape })
      expect(strip?.side).toBe('right')
      expect(main.width + GAP + strip!.tileWidth).toBeLessThanOrEqual(landscape.width)
      expect(main.height).toBeLessThanOrEqual(landscape.height)
      // The speaker is the biggest tile
      expect(main.width).toBeGreaterThan(strip!.tileWidth)
      expect(Math.abs(strip!.tileWidth / strip!.tileHeight - ASPECT)).toBeLessThan(0.05)
      // Never smaller than a readable tile: past that the strip scrolls
      expect(strip!.tileHeight).toBeGreaterThanOrEqual(71)
    }
    // Two others fit the column without scrolling
    const three = speakerLayout({ count: 3, ...landscape }).strip!
    expect(2 * three.tileHeight + GAP).toBeLessThanOrEqual(landscape.height)
  })

  it('puts the strip under a tall stage', () => {
    const { main, strip } = speakerLayout({ count: 4, width: 390, height: 640 })
    expect(strip?.side).toBe('bottom')
    expect(main.height + GAP + strip!.tileHeight).toBeLessThanOrEqual(640)
    expect(main.width).toBeLessThanOrEqual(390)
  })

  it('has nothing to lay out without tiles or space', () => {
    expect(speakerLayout({ count: 0, ...landscape }).main.width).toBe(0)
    expect(speakerLayout({ count: 3, width: 0, height: 0 }).main.width).toBe(0)
  })
})

describe('pickSpeaker (e4-t07)', () => {
  const ids = ['gene', 'wei', 'ming']

  it('shows the last person heard, never ourselves unless alone', () => {
    expect(pickSpeaker(ids, 'gene', 'ming')).toBe('ming')
    expect(pickSpeaker(ids, 'gene', 'gene')).toBe('wei')
    expect(pickSpeaker(ids, 'gene', null)).toBe('wei')
    // They left: back to the first other member
    expect(pickSpeaker(ids, 'gene', 'yu')).toBe('wei')
    expect(pickSpeaker(['gene'], 'gene', null)).toBe('gene')
    expect(pickSpeaker([], 'gene', null)).toBeNull()
  })
})

describe('shareLayout (e3-t05, e4-t08; AC-3.1, AC-4.3)', () => {
  const desktop = { width: 1280, height: 640 }

  it('gives the share the whole stage when nobody is in the strip', () => {
    expect(shareLayout({ count: 0, ...desktop })).toEqual({ main: desktop, strip: null })
  })

  it('gives the share about three quarters of a wide stage, the people a column on the right', () => {
    for (let count = 1; count <= MAX_GRID_TILES; count++) {
      const { main, strip } = shareLayout({ count, ...desktop })
      expect(strip?.side).toBe('right')
      // All the height, and the width the strip leaves (not fitted to an aspect)
      expect(main.height).toBe(desktop.height)
      expect(main.width + GAP + strip!.tileWidth).toBe(desktop.width)
      expect(main.width / desktop.width).toBeGreaterThanOrEqual(0.74)
      expect(Math.abs(strip!.tileWidth / strip!.tileHeight - ASPECT)).toBeLessThan(0.05)
      expect(strip!.tileHeight).toBeGreaterThanOrEqual(71)
    }
    // A few people fit the column without scrolling
    const three = shareLayout({ count: 3, ...desktop }).strip!
    expect(3 * three.tileHeight + 2 * GAP).toBeLessThanOrEqual(desktop.height)
  })

  it('puts the share on top and the people in a row under it on a phone held upright', () => {
    const portrait = { width: 374, height: 600 }
    for (let count = 1; count <= MAX_GRID_TILES; count++) {
      const { main, strip } = shareLayout({ count, ...portrait })
      expect(strip?.side).toBe('bottom')
      expect(main.width).toBe(portrait.width)
      expect(main.height + GAP + strip!.tileHeight).toBe(portrait.height)
      // The share stays the main thing
      expect(main.height).toBeGreaterThan(portrait.height / 2)
    }
  })

  it('makes the share the big tile on a phone held sideways, people on the right', () => {
    const landscape = { width: 812, height: 290 }
    const { main, strip } = shareLayout({ count: 4, ...landscape })
    expect(strip?.side).toBe('right')
    expect(main.width).toBeGreaterThan(landscape.width / 2)
    expect(main.height).toBe(landscape.height)
  })

  it('never makes the main area smaller as the stage grows', () => {
    let last = 0
    for (let width = 600; width <= 2400; width += 200) {
      const { main } = shareLayout({ count: 5, width, height: 600 })
      expect(main.width).toBeGreaterThanOrEqual(last)
      last = main.width
    }
  })

  it('has nothing to lay out without space', () => {
    expect(shareLayout({ count: 3, width: 0, height: 0 })).toEqual({
      main: { width: 0, height: 0 },
      strip: null,
    })
  })
})

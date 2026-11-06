import { describe, expect, it } from 'vitest'
import {
  clampPage,
  DEFAULT_GRID_GAP,
  DEFAULT_TILE_ASPECT,
  focusFirst,
  gridLayout,
  holdSpeaker,
  isLayoutChoice,
  MAX_GRID_TILES,
  pageCount,
  pagedLayout,
  pageRange,
  pagesInView,
  PHONE_PAGE_SIZE,
  pickSpeaker,
  PORTRAIT_TILE_ASPECT,
  shareLayout,
  shareSlots,
  SPEAKER_SWITCH_MS,
  speakerLayout,
  stageFocus,
  stageLayout,
  tileAspect,
  visibleTiles,
  type TileEntry,
  GALLERY_PAGE_SIZE,
  galleryIsPaged,
  gallerySide,
  sideTile,
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

describe('desktop speaker layout (G2, e4-t10): a row under the speaker', () => {
  it('puts the strip under the speaker even on a wide stage', () => {
    const { main, strip } = speakerLayout({ count: 5, width: 1600, height: 900, side: 'bottom' })
    expect(strip?.side).toBe('bottom')
    expect(strip!.tileWidth / strip!.tileHeight).toBeCloseTo(ASPECT, 1)
    // The speaker gets what the strip leaves, at 16:9
    expect(main.height + GAP + strip!.tileHeight).toBeLessThanOrEqual(900)
    expect(main.width).toBeLessThanOrEqual(1600)
    expect(main.width / main.height).toBeCloseTo(ASPECT, 1)
    // About a quarter of the stage, within bounds
    expect(strip!.tileHeight).toBeGreaterThanOrEqual(112)
    expect(strip!.tileHeight).toBeLessThanOrEqual(240)
  })

  it('shrinks the strip tiles to fit everyone, down to the minimum, then scrolls', () => {
    const few = speakerLayout({ count: 4, width: 1200, height: 800, side: 'bottom' }).strip!
    const many = speakerLayout({ count: 40, width: 1200, height: 800, side: 'bottom' }).strip!
    expect(many.tileWidth).toBeLessThan(few.tileWidth)
    expect(many.tileHeight).toBeGreaterThanOrEqual(72)
  })

  it('keeps the phone layouts as they were (auto)', () => {
    expect(speakerLayout({ count: 3, width: 800, height: 360 }).strip?.side).toBe('right')
    expect(speakerLayout({ count: 3, width: 360, height: 700 }).strip?.side).toBe('bottom')
    expect(speakerLayout({ count: 3, width: 800, height: 360, side: 'right' }).strip?.side).toBe(
      'right',
    )
  })
})

/** 'a+ b- c+': a and c with video, b without */
const tiles = (spec: string): TileEntry[] =>
  spec.split(' ').map((entry) => ({ id: entry.slice(0, -1), video: entry.endsWith('+') }))

describe('visibleTiles (G2, e4-t11): hide yourself, hide non-video', () => {
  const base = { you: 'a', hideSelf: false, hideNoVideo: false }

  it('shows everyone by default, in the room order', () => {
    expect(visibleTiles({ ...base, tiles: tiles('a+ b- c+') })).toEqual({
      ids: ['a', 'b', 'c'],
      hiddenNoVideo: 0,
    })
  })

  it('hides our own tile, unless that would leave the stage empty', () => {
    expect(visibleTiles({ ...base, hideSelf: true, tiles: tiles('a+ b- c+') }).ids).toEqual([
      'b',
      'c',
    ])
    expect(visibleTiles({ ...base, hideSelf: true, tiles: tiles('a+') }).ids).toEqual(['a'])
    // Everyone else hidden for having no video: we stay too
    expect(
      visibleTiles({ ...base, hideSelf: true, hideNoVideo: true, tiles: tiles('a+ b- c-') }),
    ).toEqual({ ids: ['a'], hiddenNoVideo: 2 })
  })

  it('hides others without video and counts them; our own tile follows hideSelf only', () => {
    expect(visibleTiles({ ...base, hideNoVideo: true, tiles: tiles('a- b- c+ d-') })).toEqual({
      ids: ['a', 'c'],
      hiddenNoVideo: 2,
    })
  })

  it('always shows the pinned and the spotlighted member', () => {
    expect(
      visibleTiles({ ...base, hideNoVideo: true, tiles: tiles('a+ b- c- d+'), keep: ['b', null] })
        .ids,
    ).toEqual(['a', 'b', 'd'])
    // Spotlighted ourselves: shown even with 隱藏自己
    expect(
      visibleTiles({ ...base, hideSelf: true, tiles: tiles('a+ b+'), keep: [null, 'a'] }).ids,
    ).toEqual(['a', 'b'])
  })

  it('handles the time before the room welcomed us', () => {
    expect(visibleTiles({ ...base, you: null, hideSelf: true, tiles: tiles('b+') }).ids).toEqual([
      'b',
    ])
  })
})

describe('stageFocus, focusFirst, stageLayout (G2, e4-t10, e4-t11)', () => {
  const ids = ['a', 'b', 'c']

  it('gives the big tile to our pin, then the spotlight, then the speaker', () => {
    expect(stageFocus(ids, 'c', 'b', 'a')).toEqual({ id: 'c', reason: 'pin' })
    expect(stageFocus(ids, null, 'b', 'a')).toEqual({ id: 'b', reason: 'spotlight' })
    expect(stageFocus(ids, null, null, 'a')).toEqual({ id: 'a', reason: 'speaker' })
    // Someone not on the stage does not count
    expect(stageFocus(ids, 'z', 'y', 'x')).toEqual({ id: 'a', reason: 'speaker' })
    expect(stageFocus([], 'a', null, null)).toBeNull()
  })

  it('puts the pinned or spotlighted member first (the share strip), not the speaker', () => {
    expect(focusFirst(ids, { id: 'c', reason: 'pin' })).toEqual(['c', 'a', 'b'])
    expect(focusFirst(ids, { id: 'b', reason: 'spotlight' })).toEqual(['b', 'a', 'c'])
    expect(focusFirst(ids, { id: 'c', reason: 'speaker' })).toEqual(ids)
    expect(focusFirst(ids, null)).toEqual(ids)
  })

  it('shows the chosen layout on a desktop, the phone layouts on phones', () => {
    const speaker = { id: 'a', reason: 'speaker' } as const
    expect(stageLayout('grid', null, speaker)).toBe('grid')
    expect(stageLayout('speaker', null, speaker)).toBe('speaker')
    expect(stageLayout('grid', 'portrait', speaker)).toBe('paged')
    expect(stageLayout('grid', 'landscape', speaker)).toBe('speaker')
    expect(stageLayout('grid', null, null)).toBe('grid')
  })

  it('turns any layout into the speaker one for a pin or a spotlight', () => {
    for (const reason of ['pin', 'spotlight'] as const) {
      const focus = { id: 'b', reason }
      expect(stageLayout('grid', null, focus)).toBe('speaker')
      expect(stageLayout('grid', 'portrait', focus)).toBe('speaker')
      expect(stageLayout('speaker', 'landscape', focus)).toBe('speaker')
    }
  })

  it('knows a layout choice', () => {
    expect(isLayoutChoice('grid')).toBe(true)
    expect(isLayoutChoice('speaker')).toBe(true)
    expect(isLayoutChoice('paged')).toBe(false)
    expect(isLayoutChoice(null)).toBe(false)
  })
})

describe('holdSpeaker (G2, e4-t10): the big tile does not flip back and forth', () => {
  const ids = ['a', 'b', 'c']

  it('gives it to the first speaker at once', () => {
    expect(holdSpeaker(null, 'a', ids, 1000)).toEqual({ held: { id: 'a', since: 1000 }, wait: 0 })
    expect(holdSpeaker(null, null, ids, 1000)).toEqual({ held: null, wait: 0 })
  })

  it('keeps it with the speaker until SPEAKER_SWITCH_MS have passed', () => {
    const held = { id: 'a', since: 1000 }
    expect(holdSpeaker(held, 'a', ids, 1500)).toEqual({ held, wait: 0 })
    expect(holdSpeaker(held, 'b', ids, 2000)).toEqual({ held, wait: SPEAKER_SWITCH_MS - 1000 })
    expect(holdSpeaker(held, 'b', ids, 1000 + SPEAKER_SWITCH_MS)).toEqual({
      held: { id: 'b', since: 1000 + SPEAKER_SWITCH_MS },
      wait: 0,
    })
  })

  it('moves at once when the holder left the stage', () => {
    expect(holdSpeaker({ id: 'z', since: 1000 }, 'b', ids, 1100)).toEqual({
      held: { id: 'b', since: 1100 },
      wait: 0,
    })
  })
})

describe('shareSlots (H5, e3-t07): which share is in the main area', () => {
  it('shows the latest share big and the others in the strip, never our own', () => {
    expect(shareSlots([], 'me', null)).toEqual({ main: null, strip: [] })
    expect(shareSlots(['me'], 'me', null)).toEqual({ main: null, strip: [] })
    expect(shareSlots(['a', 'b', 'c'], 'me', null)).toEqual({ main: 'c', strip: ['a', 'b'] })
    expect(shareSlots(['a', 'me', 'b'], 'me', null)).toEqual({ main: 'b', strip: ['a'] })
  })

  it('keeps the viewer’s choice while that member shares, else the latest again', () => {
    expect(shareSlots(['a', 'b', 'c'], 'me', 'a')).toEqual({ main: 'a', strip: ['b', 'c'] })
    // They stopped: the latest; our own share is never a choice
    expect(shareSlots(['b', 'c'], 'me', 'a')).toEqual({ main: 'c', strip: ['b'] })
    expect(shareSlots(['b', 'me'], 'me', 'me')).toEqual({ main: 'b', strip: [] })
  })
})

describe('a large room on a desktop (L1, e10-t02)', () => {
  it('goes to pages only past sixteen tiles', () => {
    expect(GALLERY_PAGE_SIZE).toBe(16)
    expect(galleryIsPaged(16)).toBe(false)
    expect(galleryIsPaged(17)).toBe(true)
    expect(pageCount(25, GALLERY_PAGE_SIZE)).toBe(2)
    expect(pageRange(1, 25, GALLERY_PAGE_SIZE)).toEqual({ start: 16, end: 25 })
  })

  it('a page keeps the same tile size however few are on it', () => {
    const size = { width: 1040, height: 640 }
    const full = pagedLayout({ count: 25, pageSize: GALLERY_PAGE_SIZE, ...size })
    const sixteen = gridLayout({ count: 16, ...size })
    expect(full.tileWidth).toBe(sixteen.tileWidth)
    expect(full.cols * full.rows).toBeGreaterThanOrEqual(16)
    expect(full.pages).toBe(2)
  })

  it('sizes the side column within bounds, 16:9, and never more than a third', () => {
    expect(gallerySide(1280, 720)).toEqual({ tileWidth: 200, tileHeight: 112 })
    expect(gallerySide(900, 600).tileWidth).toBe(144)
    expect(gallerySide(600, 600).tileWidth).toBe(112)
    expect(gallerySide(240, 600).tileWidth).toBe(80)
    expect(gallerySide(0, 600)).toEqual({ tileWidth: 0, tileHeight: 0 })
  })

  it('shows the speaker at the side only when their page is out of view', () => {
    const first = { first: 0, last: 0, current: 0 }
    const second = { first: 1, last: 1, current: 1 }
    const between = { first: 0, last: 1, current: 0 }
    expect(sideTile(20, first, 25)).toBe(20)
    expect(sideTile(20, second, 25)).toBeNull()
    expect(sideTile(3, second, 25)).toBe(3)
    expect(sideTile(20, between, 25)).toBeNull()
    expect(sideTile(null, first, 25)).toBeNull()
    expect(sideTile(-1, first, 25)).toBeNull()
    expect(sideTile(30, first, 25)).toBeNull()
  })
})

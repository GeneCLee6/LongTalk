// The gallery grid (e4-t04, AC-4.3): how many columns and rows, and how big a tile, for `count`
// tiles of one aspect ratio in a container. Pure: the room page feeds it the stage's size from a
// ResizeObserver and lets CSS place the tiles (no per-tile positioning in JS).

/** The gallery holds up to this many tiles (M0; pages up to 16 are M2) */
export const MAX_GRID_TILES = 8

/** Video tiles are 16:9 unless the caller says otherwise */
export const DEFAULT_TILE_ASPECT = 16 / 9

/** DESIGN.md §3: 8 px between tiles */
export const DEFAULT_GRID_GAP = 8

/** Tiles in a portrait container (a phone held upright) are square, like the mockup's phone */
export const PORTRAIT_TILE_ASPECT = 1

/** The tile shape for a container: 16:9 when it is wider than tall, square when taller */
export function tileAspect(width: number, height: number): number {
  return height > width ? PORTRAIT_TILE_ASPECT : DEFAULT_TILE_ASPECT
}

export interface GridInput {
  /** Tiles to lay out */
  count: number
  /** The container's inner size, px */
  width: number
  height: number
  /** Tile width / height; DEFAULT_TILE_ASPECT */
  aspect?: number
  /** Space between tiles, px; DEFAULT_GRID_GAP */
  gap?: number
}

export interface GridLayout {
  cols: number
  rows: number
  /** Every tile's size, whole px, so a row of `cols` tiles and gaps never wraps early */
  tileWidth: number
  tileHeight: number
  /** The space the tiles take, gaps included (≤ the container) */
  width: number
  height: number
}

const EMPTY: GridLayout = { cols: 0, rows: 0, tileWidth: 0, tileHeight: 0, width: 0, height: 0 }

/** The largest tile of `aspect` that fits `cols` × `rows` in the container */
function fit(
  cols: number,
  rows: number,
  width: number,
  height: number,
  aspect: number,
  gap: number,
): number {
  const cellWidth = (width - gap * (cols - 1)) / cols
  const cellHeight = (height - gap * (rows - 1)) / rows
  if (cellWidth <= 0 || cellHeight <= 0) return 0
  return Math.min(cellWidth, cellHeight * aspect)
}

/**
 * Tries every column count from 1 to `count` (rows follow) and keeps the one with the biggest
 * tiles; on a tie (within half a pixel) the one with fewer empty cells, else the fewer columns.
 * Wide containers get a row of tiles, tall ones a column, square ones a square-ish grid.
 */
export function gridLayout({
  count,
  width,
  height,
  aspect = DEFAULT_TILE_ASPECT,
  gap = DEFAULT_GRID_GAP,
}: GridInput): GridLayout {
  const n = Math.floor(count)
  if (!(n > 0) || !(width > 0) || !(height > 0) || !(aspect > 0)) return EMPTY
  const spacing = Math.max(0, gap)
  let best: { cols: number; rows: number; tileWidth: number } | null = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const tileWidth = fit(cols, rows, width, height, aspect, spacing)
    if (!best) {
      best = { cols, rows, tileWidth }
      continue
    }
    const bigger = tileWidth > best.tileWidth + 0.5
    const tie = Math.abs(tileWidth - best.tileWidth) <= 0.5
    const fewerEmpty = cols * rows - n < best.cols * best.rows - n
    if (bigger || (tie && fewerEmpty)) best = { cols, rows, tileWidth }
  }
  // Gaps alone fill the container: nothing fits
  if (!best || best.tileWidth / aspect < 1) return EMPTY
  const tileWidth = Math.floor(best.tileWidth)
  const tileHeight = Math.floor(tileWidth / aspect)
  return {
    cols: best.cols,
    rows: best.rows,
    tileWidth,
    tileHeight,
    width: best.cols * tileWidth + (best.cols - 1) * spacing,
    height: best.rows * tileHeight + (best.rows - 1) * spacing,
  }
}

// ---------------------------------------------------------------------------------------------
// Phones (e4-t07, AC-4.6): held upright the gallery is paged, four tiles a page, swiped sideways;
// held sideways it is a speaker layout (the speaker big, everyone else in a strip).

/** Tiles on one page of the phone gallery (DESIGN.md §4.3: 4 a page, swipe for the rest) */
export const PHONE_PAGE_SIZE = 4

/** Pages needed for `count` tiles (0 for none) */
export function pageCount(count: number, pageSize = PHONE_PAGE_SIZE): number {
  const n = Math.floor(count)
  const size = Math.floor(pageSize)
  if (!(n > 0) || !(size > 0)) return 0
  return Math.ceil(n / size)
}

/** A page index kept within 0 … pages − 1 (0 when there are none) */
export function clampPage(page: number, pages: number): number {
  if (!(pages > 0) || !Number.isFinite(page)) return 0
  return Math.min(Math.max(0, Math.round(page)), pages - 1)
}

/** The tiles on `page`: indexes start (inclusive) to end (exclusive) */
export function pageRange(
  page: number,
  count: number,
  pageSize = PHONE_PAGE_SIZE,
): { start: number; end: number } {
  const pages = pageCount(count, pageSize)
  if (pages === 0) return { start: 0, end: 0 }
  const start = clampPage(page, pages) * pageSize
  return { start, end: Math.min(start + pageSize, Math.floor(count)) }
}

export interface PagesInView {
  /** The first and last page with any part on screen (equal when one page fills it) */
  first: number
  last: number
  /** The page mostly on screen: the one the dots mark */
  current: number
}

/**
 * Which pages a horizontal pager shows, from its scroll offset and page width. Mid-swipe two
 * pages are in view; their videos play, the others' do not (Stage pauses offscreen tiles).
 */
export function pagesInView(scrollLeft: number, pageWidth: number, pages: number): PagesInView {
  if (!(pages > 0) || !(pageWidth > 0) || !Number.isFinite(scrollLeft)) {
    return { first: 0, last: 0, current: 0 }
  }
  const at = Math.max(0, scrollLeft / pageWidth)
  // Sub-pixel scroll offsets (zoom, fractional widths) do not count as the next page showing
  const slack = 0.01
  return {
    first: clampPage(Math.floor(at + slack), pages),
    last: clampPage(Math.ceil(at - slack), pages),
    current: clampPage(Math.round(at), pages),
  }
}

/** The paged gallery's grid: every page laid out for a full page, so tiles keep one size */
export function pagedLayout({
  count,
  pageSize = PHONE_PAGE_SIZE,
  ...rest
}: GridInput & { pageSize?: number }): GridLayout & { pages: number } {
  const pages = pageCount(count, pageSize)
  return { ...gridLayout({ ...rest, count: Math.min(Math.floor(count), pageSize) }), pages }
}

/** The strip beside (or under) the speaker takes about this share of the stage, within bounds */
const STRIP_SHARE = 0.24
const STRIP_MIN = 112
const STRIP_MAX = 240
/** Strip tiles never get smaller than this (px, the short side): past that the strip scrolls */
const STRIP_TILE_MIN = 72

export interface SpeakerLayout {
  /** The speaker's tile */
  main: { width: number; height: number }
  /** Where everyone else goes: a column on the right of a wide stage, a row under a tall one */
  strip: null | {
    side: 'right' | 'bottom'
    tileWidth: number
    tileHeight: number
  }
}

const NO_SPEAKER: SpeakerLayout = { main: { width: 0, height: 0 }, strip: null }

/**
 * The speaker layout (a phone held sideways, AC-4.6; later D1's share layout): the speaker's
 * tile as big as the room left by the strip allows, the others in a strip of equal tiles that
 * scrolls when they do not fit. Strip tiles shrink to fit everyone, but not below
 * STRIP_TILE_MIN.
 */
export function speakerLayout({
  count,
  width,
  height,
  aspect = DEFAULT_TILE_ASPECT,
  gap = DEFAULT_GRID_GAP,
}: GridInput): SpeakerLayout {
  const n = Math.floor(count)
  if (!(n > 0) || !(width > 0) || !(height > 0) || !(aspect > 0)) return NO_SPEAKER
  const spacing = Math.max(0, gap)
  const main = (w: number, h: number) => {
    const fit = gridLayout({ count: 1, width: w, height: h, aspect, gap: spacing })
    return { width: fit.tileWidth, height: fit.tileHeight }
  }
  if (n === 1) return { main: main(width, height), strip: null }
  const others = n - 1
  const bound = (length: number) =>
    Math.min(Math.max(Math.round(length * STRIP_SHARE), STRIP_MIN), STRIP_MAX, length / 2)
  if (width >= height) {
    // A column on the right: tiles as wide as the strip, or smaller so everyone fits
    const fitHeight = (height - spacing * (others - 1)) / others
    const tileHeight = Math.floor(
      Math.min(bound(width) / aspect, Math.max(fitHeight, STRIP_TILE_MIN)),
    )
    const tileWidth = Math.floor(tileHeight * aspect)
    return {
      main: main(width - tileWidth - spacing, height),
      strip: { side: 'right', tileWidth, tileHeight },
    }
  }
  const fitWidth = (width - spacing * (others - 1)) / others
  const tileWidth = Math.floor(
    Math.min(bound(height) * aspect, Math.max(fitWidth, STRIP_TILE_MIN * aspect)),
  )
  const tileHeight = Math.floor(tileWidth / aspect)
  return {
    main: main(width, height - tileHeight - spacing),
    strip: { side: 'bottom', tileWidth, tileHeight },
  }
}

/**
 * Who the speaker layout shows big: the last person heard (not ourselves: we know what we look
 * like), else the first other member, else us when alone
 */
export function pickSpeaker(
  ids: readonly string[],
  you: string | null,
  lastHeard: string | null,
): string | null {
  if (lastHeard !== null && lastHeard !== you && ids.includes(lastHeard)) return lastHeard
  return ids.find((id) => id !== you) ?? ids[0] ?? null
}

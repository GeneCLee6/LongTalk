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

/** The strip beside (or under) the big tile takes about this share of the stage, within bounds */
const STRIP_SHARE = 0.24
const STRIP_MIN = 112
const STRIP_MAX = 240
/** Strip tiles never get smaller than this (px, the short side): past that the strip scrolls */
const STRIP_TILE_MIN = 72

/**
 * Where the strip goes: `auto` is a column right of a wide stage and a row under a tall one (a
 * phone, the share layout); the desktop speaker layout always has a row under the speaker
 * (PRD e4: 講話者大格＋底部列)
 */
export type StripSide = 'auto' | 'right' | 'bottom'

/** Where the others go beside a big tile: a column right of a wide stage, a row under a tall one */
export interface Strip {
  side: 'right' | 'bottom'
  tileWidth: number
  tileHeight: number
}

/**
 * The strip of `others` equal tiles beside (or under) a big one: about STRIP_SHARE of the stage
 * (DESIGN.md §4.3: the share takes 75 %), tiles shrinking to fit everyone but not below
 * STRIP_TILE_MIN (past that the strip scrolls)
 */
function stripFor(
  others: number,
  width: number,
  height: number,
  aspect: number,
  spacing: number,
  side: StripSide = 'auto',
): Strip {
  const bound = (length: number) =>
    Math.min(Math.max(Math.round(length * STRIP_SHARE), STRIP_MIN), STRIP_MAX, length / 2)
  if (side === 'right' || (side === 'auto' && width >= height)) {
    // A column on the right: tiles as wide as the strip, or smaller so everyone fits
    const fitHeight = (height - spacing * (others - 1)) / others
    const tileHeight = Math.floor(
      Math.min(bound(width) / aspect, Math.max(fitHeight, STRIP_TILE_MIN)),
    )
    return { side: 'right', tileWidth: Math.floor(tileHeight * aspect), tileHeight }
  }
  const fitWidth = (width - spacing * (others - 1)) / others
  const tileWidth = Math.floor(
    Math.min(bound(height) * aspect, Math.max(fitWidth, STRIP_TILE_MIN * aspect)),
  )
  return { side: 'bottom', tileWidth, tileHeight: Math.floor(tileWidth / aspect) }
}

/** The room the strip leaves for the big tile */
function besideStrip(width: number, height: number, strip: Strip, spacing: number) {
  return strip.side === 'right'
    ? { width: width - strip.tileWidth - spacing, height }
    : { width, height: height - strip.tileHeight - spacing }
}

export interface SpeakerLayout {
  /** The speaker's tile */
  main: { width: number; height: number }
  /** Where everyone else goes: a column on the right of a wide stage, a row under a tall one */
  strip: Strip | null
}

const NO_SPEAKER: SpeakerLayout = { main: { width: 0, height: 0 }, strip: null }

/**
 * The speaker layout (a phone held sideways, AC-4.6; the desktop's 演講者, e4-t10, AC-4.4): the
 * speaker's tile as big as the room left by the strip allows, the others in a strip of equal
 * tiles that scrolls when they do not fit (stripFor). `side`: where the strip goes (StripSide).
 */
export function speakerLayout({
  count,
  width,
  height,
  aspect = DEFAULT_TILE_ASPECT,
  gap = DEFAULT_GRID_GAP,
  side = 'auto',
}: GridInput & { side?: StripSide }): SpeakerLayout {
  const n = Math.floor(count)
  if (!(n > 0) || !(width > 0) || !(height > 0) || !(aspect > 0)) return NO_SPEAKER
  const spacing = Math.max(0, gap)
  const main = (box: { width: number; height: number }) => {
    const fit = gridLayout({ count: 1, ...box, aspect, gap: spacing })
    return { width: fit.tileWidth, height: fit.tileHeight }
  }
  if (n === 1) return { main: main({ width, height }), strip: null }
  const strip = stripFor(n - 1, width, height, aspect, spacing, side)
  return { main: main(besideStrip(width, height, strip, spacing)), strip }
}

// ---------------------------------------------------------------------------------------------
// Sharing (e3-t05, e4-t08; AC-3.1, AC-4.3): the share takes the main area and everyone is in the
// strip beside it, on desktops and phones alike (a phone held upright: the share on top, the
// people in a row under it; held sideways: the share big, the people on the right).

export interface ShareLayout {
  /**
   * The main area for the share: all the room the strip leaves, not fitted to an aspect (a shared
   * window can be any shape; the video letterboxes inside it)
   */
  main: { width: number; height: number }
  /** The people, or null when there are none to show */
  strip: Strip | null
}

const NO_SHARE: ShareLayout = { main: { width: 0, height: 0 }, strip: null }

/** The share layout for a share and `count` people tiles in the strip */
export function shareLayout({
  count,
  width,
  height,
  aspect = DEFAULT_TILE_ASPECT,
  gap = DEFAULT_GRID_GAP,
}: GridInput): ShareLayout {
  if (!(width > 0) || !(height > 0) || !(aspect > 0)) return NO_SHARE
  const n = Math.max(0, Math.floor(count))
  const spacing = Math.max(0, gap)
  const whole = { width: Math.floor(width), height: Math.floor(height) }
  if (!(n > 0)) return { main: whole, strip: null }
  const strip = stripFor(n, width, height, aspect, spacing)
  const main = besideStrip(width, height, strip, spacing)
  return { main: { width: Math.floor(main.width), height: Math.floor(main.height) }, strip }
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

// ---------------------------------------------------------------------------------------------
// What the stage shows (e4-t10, e4-t11; AC-4.4): which tiles, which one is big, and in which
// layout. The person chooses the gallery or the speaker layout (desktop; phones follow how they
// are held), may pin anyone for themselves, and a host or co-host may spotlight someone for
// everyone (RoomInfo.spotlight). Precedence for the big tile: our own pin, then the spotlight,
// then the last person heard. A share still takes the main area (e4-t08): then the pinned or
// spotlighted person goes first in the strip instead.

/** The layout the person chose (desktop): the gallery, or the speaker big with a strip */
export type LayoutChoice = 'grid' | 'speaker'

export const isLayoutChoice = (value: unknown): value is LayoutChoice =>
  value === 'grid' || value === 'speaker'

/** One member's tile, as far as choosing what to show goes */
export interface TileEntry {
  id: string
  /** Their camera is on (and, for others, received): hide-non-video leaves them out otherwise */
  video: boolean
}

export interface VisibleInput {
  /** Every member, in the room's order */
  tiles: readonly TileEntry[]
  /** Our own id (null before the room welcomed us) */
  you: string | null
  /** 隱藏自己: our own tile is left out */
  hideSelf: boolean
  /** 隱藏沒有視訊的人: others without video are left out (our own tile follows hideSelf) */
  hideNoVideo: boolean
  /** Shown whatever the settings say: the pinned and the spotlighted member */
  keep?: readonly (string | null)[]
}

export interface VisibleTiles {
  /** The tiles to show, in the room's order */
  ids: string[]
  /** Others left out for having no video (the stage says how many, with a way to show them) */
  hiddenNoVideo: number
}

/**
 * The tiles to show. Hiding ourselves never empties the stage: alone (or with everyone else
 * hidden) our tile stays. The pinned and the spotlighted member always show. Their sound plays
 * on either way: it is not in the tiles (MemberAudio).
 */
export function visibleTiles({
  tiles,
  you,
  hideSelf,
  hideNoVideo,
  keep = [],
}: VisibleInput): VisibleTiles {
  const kept = (id: string) => keep.includes(id)
  let hiddenNoVideo = 0
  const others = tiles.filter((tile) => {
    if (tile.id === you) return false
    if (hideNoVideo && !tile.video && !kept(tile.id)) {
      hiddenNoVideo += 1
      return false
    }
    return true
  })
  const selfShown =
    you !== null &&
    tiles.some((tile) => tile.id === you) &&
    (!hideSelf || kept(you) || others.length === 0)
  const ids = tiles
    .filter((tile) => (tile.id === you ? selfShown : others.includes(tile)))
    .map((tile) => tile.id)
  return { ids, hiddenNoVideo }
}

/** Why a tile is the big one: our pin, the host's spotlight, or the last person heard */
export type FocusReason = 'pin' | 'spotlight' | 'speaker'

export interface StageFocus {
  id: string
  reason: FocusReason
}

/**
 * The big tile among `ids` (the tiles shown): our pin, else the spotlight, else the speaker
 * (pickSpeaker, held by holdSpeaker); null when there are no tiles
 */
export function stageFocus(
  ids: readonly string[],
  pinned: string | null,
  spotlight: string | null,
  speaker: string | null,
): StageFocus | null {
  if (pinned !== null && ids.includes(pinned)) return { id: pinned, reason: 'pin' }
  if (spotlight !== null && ids.includes(spotlight)) return { id: spotlight, reason: 'spotlight' }
  if (speaker !== null && ids.includes(speaker)) return { id: speaker, reason: 'speaker' }
  return ids[0] === undefined ? null : { id: ids[0], reason: 'speaker' }
}

/** The pinned or spotlighted member first, the rest in the room's order (the share's strip) */
export function focusFirst(ids: readonly string[], focus: StageFocus | null): string[] {
  if (!focus || focus.reason === 'speaker' || !ids.includes(focus.id)) return [...ids]
  return [focus.id, ...ids.filter((id) => id !== focus.id)]
}

/** The phone layout in use (src/components/layoutContext.ts), null on a desktop */
export type PhoneOrientation = 'portrait' | 'landscape' | null

/** The stage's layouts: the gallery, a phone's pages, the speaker big with a strip */
export type StageLayout = 'grid' | 'paged' | 'speaker'

/**
 * The layout: a pin or a spotlight turns any layout into the speaker one (the person asked to
 * see someone big); otherwise a phone held upright pages, held sideways shows the speaker, and a
 * desktop shows what the person chose
 */
export function stageLayout(
  choice: LayoutChoice,
  phone: PhoneOrientation,
  focus: StageFocus | null,
): StageLayout {
  const forced = focus !== null && focus.reason !== 'speaker'
  if (phone === 'landscape' || forced) return 'speaker'
  if (phone === 'portrait') return 'paged'
  return choice
}

/** How long the big tile stays with someone before another speaker may take it */
export const SPEAKER_SWITCH_MS = 3000

/** Who has the big tile in the speaker layout, since when */
export interface HeldSpeaker {
  id: string
  since: number
}

/**
 * Hysteresis for the big tile (on top of pickSpeaker's second of speech, e4-t07): the speaker
 * keeps it for at least `holdMs`, so two people talking over each other do not flip it back and
 * forth. `wanted` is pickSpeaker's answer now; `ids` who is on the stage (someone who left gives
 * it up at once). `wait` is how long until `wanted` may take it (0: it has it, or nobody does).
 */
export function holdSpeaker(
  held: HeldSpeaker | null,
  wanted: string | null,
  ids: readonly string[],
  now: number,
  holdMs = SPEAKER_SWITCH_MS,
): { held: HeldSpeaker | null; wait: number } {
  if (wanted === null) return { held: null, wait: 0 }
  if (held?.id === wanted) return { held, wait: 0 }
  if (!held || !ids.includes(held.id)) return { held: { id: wanted, since: now }, wait: 0 }
  const elapsed = now - held.since
  if (elapsed >= holdMs) return { held: { id: wanted, since: now }, wait: 0 }
  return { held, wait: holdMs - elapsed }
}

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

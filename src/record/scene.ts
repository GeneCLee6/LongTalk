// What a local recording shows (I4, e8-t01): the stage as the recorder sees it, laid out on the
// recording's canvas with the stage's own layout functions (shared/layout.ts): the gallery, the
// speaker big with a row under it (a pin or spotlight, or the 演講者 layout), or a share in the
// main area with the people beside it. Pure: the composer draws what placeScene says.
import type { Stroke } from '../../shared/annotation.ts'
import {
  DEFAULT_GRID_GAP,
  DEFAULT_TILE_ASPECT,
  gridLayout,
  shareLayout,
  speakerLayout,
  type Strip,
} from '../../shared/layout.ts'

/** One person's tile in the recording */
export interface SceneTile {
  id: string
  name: string
  /** Their camera, or null: the tile shows their initial */
  video: MediaStreamTrack | null
  micMuted: boolean
  /** Our own tile (錄影設定 「包含我的鏡頭」 decides whether our camera shows) */
  you: boolean
}

/** A screen share in the recording's main area */
export interface SceneShare {
  id: string
  name: string
  video: MediaStreamTrack | null
  /**
   * The marks on the share as they are at this frame (J2; read for every frame, they change far
   * more often than the scene is built). The laser pointer is not recorded.
   */
  marks?: () => readonly Stroke[]
}

/** Everything the recorder reads for each frame (the room page keeps it up to date) */
export interface Scene {
  /** The people, in the stage's order */
  tiles: SceneTile[]
  /** The share in the main area, if anyone shares */
  share: SceneShare | null
  /** The recorder's layout: the gallery, or the speaker big (`focus`) with the others in a row */
  layout: 'grid' | 'speaker'
  /** Who is big in the speaker layout (a pin, the spotlight, the last speaker) */
  focus: string | null
  /** Every sound to mix: the others' microphones and shares' sound, our own microphone */
  audio: MediaStreamTrack[]
}

export const EMPTY_SCENE: Scene = { tiles: [], share: null, layout: 'grid', focus: null, audio: [] }

/** The scene without our own camera (錄影設定 「包含我的鏡頭」 off): our tile shows our initial */
export function withoutOwnCamera(scene: Scene): Scene {
  if (!scene.tiles.some((tile) => tile.you && tile.video)) return scene
  return {
    ...scene,
    tiles: scene.tiles.map((tile) => (tile.you ? { ...tile, video: null } : tile)),
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Something to draw, where: a share is letterboxed (contain), a person's camera fills (cover) */
export type Placement =
  { kind: 'share'; rect: Rect; share: SceneShare } | { kind: 'tile'; rect: Rect; tile: SceneTile }

/** The canvas's margin and the space between tiles, relative to a 720p canvas */
const BASE_HEIGHT = 720
const MARGIN = 16

/** The strip's tiles that fit along its side; the rest are left out of the recording */
function stripRects(strip: Strip, area: Rect, count: number, gap: number): Rect[] {
  const along = strip.side === 'right' ? area.height : area.width
  const step = (strip.side === 'right' ? strip.tileHeight : strip.tileWidth) + gap
  const fits = Math.max(0, Math.min(count, Math.floor((along + gap) / step)))
  const length = fits * step - gap
  const start = (along - length) / 2
  return Array.from({ length: fits }, (_, i) =>
    strip.side === 'right'
      ? {
          x: area.x + area.width - strip.tileWidth,
          y: area.y + start + i * step,
          width: strip.tileWidth,
          height: strip.tileHeight,
        }
      : {
          x: area.x + start + i * step,
          y: area.y + area.height - strip.tileHeight,
          width: strip.tileWidth,
          height: strip.tileHeight,
        },
  )
}

/** A box of `width` × `height` centred in `area` */
const centred = (area: Rect, width: number, height: number): Rect => ({
  x: area.x + (area.width - width) / 2,
  y: area.y + (area.height - height) / 2,
  width,
  height,
})

/** The gallery: shared/layout.ts gridLayout, the last row centred like the rest */
function grid(tiles: SceneTile[], area: Rect, gap: number): Placement[] {
  const layout = gridLayout({ count: tiles.length, width: area.width, height: area.height, gap })
  if (layout.cols === 0) return []
  const block = centred(area, layout.width, layout.height)
  return tiles.map((tile, index) => {
    const row = Math.floor(index / layout.cols)
    const inRow = Math.min(layout.cols, tiles.length - row * layout.cols)
    const rowWidth = inRow * layout.tileWidth + (inRow - 1) * gap
    const col = index - row * layout.cols
    return {
      kind: 'tile',
      tile,
      rect: {
        x: block.x + (layout.width - rowWidth) / 2 + col * (layout.tileWidth + gap),
        y: block.y + row * (layout.tileHeight + gap),
        width: layout.tileWidth,
        height: layout.tileHeight,
      },
    }
  })
}

/**
 * Where everything goes on a `width` × `height` canvas: with a share, the share in the main area
 * and the people in the strip (shareLayout); in the speaker layout the focus big and the others
 * in a row under it (speakerLayout, like the desktop's 演講者); otherwise the gallery
 * (gridLayout). People who do not fit the strip are left out (a recording cannot scroll).
 */
export function placeScene(scene: Scene, width: number, height: number): Placement[] {
  const scale = height / BASE_HEIGHT
  const margin = Math.round(MARGIN * scale)
  const gap = Math.round(DEFAULT_GRID_GAP * scale)
  const area: Rect = {
    x: margin,
    y: margin,
    width: width - 2 * margin,
    height: height - 2 * margin,
  }
  if (!(area.width > 0) || !(area.height > 0)) return []
  const { tiles } = scene
  if (scene.share) {
    const layout = shareLayout({ count: tiles.length, width: area.width, height: area.height, gap })
    const main: Placement = {
      kind: 'share',
      share: scene.share,
      rect: { x: area.x, y: area.y, width: layout.main.width, height: layout.main.height },
    }
    if (!layout.strip) return [main]
    const rects = stripRects(layout.strip, area, tiles.length, gap)
    return [main, ...rects.map((rect, i): Placement => ({ kind: 'tile', tile: tiles[i], rect }))]
  }
  if (tiles.length === 0) return []
  const focusIndex = Math.max(
    0,
    tiles.findIndex((tile) => tile.id === scene.focus),
  )
  if (scene.layout === 'speaker' && tiles.length > 1) {
    const focus = tiles[focusIndex]
    const others = tiles.filter((_, i) => i !== focusIndex)
    const layout = speakerLayout({
      count: tiles.length,
      width: area.width,
      height: area.height,
      aspect: DEFAULT_TILE_ASPECT,
      gap,
      side: 'bottom',
    })
    const above: Rect = layout.strip
      ? { ...area, height: area.height - layout.strip.tileHeight - gap }
      : area
    const big: Placement = {
      kind: 'tile',
      tile: focus,
      rect: centred(above, layout.main.width, layout.main.height),
    }
    if (!layout.strip) return [big]
    const rects = stripRects(layout.strip, area, others.length, gap)
    return [big, ...rects.map((rect, i): Placement => ({ kind: 'tile', tile: others[i], rect }))]
  }
  return grid(tiles, area, gap)
}

/** A video's source rectangle for `fit` into `rect` (cover crops, contain letterboxes) */
export function fitVideo(
  videoWidth: number,
  videoHeight: number,
  rect: Rect,
  fit: 'cover' | 'contain',
): { source: Rect; target: Rect } | null {
  if (!(videoWidth > 0) || !(videoHeight > 0) || !(rect.width > 0) || !(rect.height > 0)) {
    return null
  }
  const videoAspect = videoWidth / videoHeight
  const rectAspect = rect.width / rect.height
  const whole = { x: 0, y: 0, width: videoWidth, height: videoHeight }
  if (fit === 'contain') {
    const width = videoAspect > rectAspect ? rect.width : rect.height * videoAspect
    const height = videoAspect > rectAspect ? rect.width / videoAspect : rect.height
    return { source: whole, target: centred(rect, width, height) }
  }
  // Cover: the middle of the video, cropped to the tile's shape
  const width = videoAspect > rectAspect ? videoHeight * rectAspect : videoWidth
  const height = videoAspect > rectAspect ? videoHeight : videoWidth / rectAspect
  return {
    source: { x: (videoWidth - width) / 2, y: (videoHeight - height) / 2, width, height },
    target: rect,
  }
}

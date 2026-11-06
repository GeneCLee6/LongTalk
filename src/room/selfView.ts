// Where the floating self-view tile sits (e6-t07): how far along the stage's free space, 0–1 on
// each axis (0, 0: top left; 1, 1: bottom right, where it starts). Fractions rather than pixels, so
// it cannot leave the stage however the window, the side panel or the phone's rotation resizes it.
// Pure, for tests; SelfView.tsx draws it and session.ts remembers it.

export interface SelfViewAt {
  x: number
  y: number
}

export const SELF_VIEW_START: SelfViewAt = { x: 1, y: 1 }
/** How far an arrow key moves it, and with Shift */
export const SELF_VIEW_KEY_PX = 24
export const SELF_VIEW_KEY_BIG_PX = 96

const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1)

export const clampSelfView = (at: SelfViewAt): SelfViewAt => ({ x: unit(at.x), y: unit(at.y) })

/**
 * Moved by (dx, dy) pixels in a stage with this much free space (the stage less the tile). Without
 * free space on an axis it stays where it is on that axis.
 */
export function moveSelfView(
  at: SelfViewAt,
  dx: number,
  dy: number,
  freeWidth: number,
  freeHeight: number,
): SelfViewAt {
  return clampSelfView({
    x: freeWidth > 0 ? at.x + dx / freeWidth : at.x,
    y: freeHeight > 0 ? at.y + dy / freeHeight : at.y,
  })
}

/** The move an arrow key asks for; null for any other key */
export function selfViewKey(key: string, big: boolean): { dx: number; dy: number } | null {
  const step = big ? SELF_VIEW_KEY_BIG_PX : SELF_VIEW_KEY_PX
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 }
    case 'ArrowRight':
      return { dx: step, dy: 0 }
    case 'ArrowUp':
      return { dx: 0, dy: -step }
    case 'ArrowDown':
      return { dx: 0, dy: step }
    default:
      return null
  }
}

/**
 * Whether our own tile floats instead of taking a place on the stage: asked for, with someone else
 * to look at, and not while we are what the stage is showing big (pinned or spotlighted: the
 * layout has already given us the main place)
 */
export function floatsSelf({
  wanted,
  you,
  shown,
  focus,
}: {
  wanted: boolean
  you: string | null
  shown: readonly string[]
  focus: string | null
}): boolean {
  return wanted && you !== null && shown.includes(you) && shown.length > 1 && focus !== you
}

// Which simulcast layer each received video should come in (e2-t12, AC-2.6; ADR-001
// 「Simulcast」): pure functions, no WebRTC and no DOM, so RoomMedia runs them and the tests pin
// them down.
//
// 1. Size: every tile reports how big its video is drawn, in device pixels (CSS size times
//    devicePixelRatio, capped at MAX_PIXEL_RATIO), and whether it is on screen at all. A camera
//    fills its tile (object-fit: cover), a screen fits inside its box (contain): what matters is
//    the short side of the source that ends up on screen. The smallest layer good enough for that
//    (its short side at least UPSCALE_OK of it) is the one to ask for.
// 2. Visibility: a video that is not drawn (a page out of view, a strip scrolled past, the camera
//    shown as an initial, the browser tab in the background) gets the lowest layer. Realtime has no
//    way to pause a subscription short of closing it (a renegotiation each way), so lowest is as
//    low as it goes.
// 3. Bandwidth: everything asked for must fit DOWNLINK_BUDGET_BPS (AC-2.6: an 8-person grid
//    stays under 4 Mbps, audio included), counted at each layer's bitrate cap. Over it, the
//    smallest tiles step down first, cameras before the screen. The SFU sends what is asked for
//    (`priorityOrdering: none`: its own estimate held layers down and moved them about, ADR-001),
//    and the browser's availableIncomingBitrate is not used either: on Realtime's downlink it
//    follows what is already being received (398 kbps while receiving 362, PR preview), so as a
//    cap it holds every layer low for good. A link that carries less than the budget is H2's to
//    notice from loss and freezes and lower the budget (e2-t15).
// 4. Hysteresis: a layer already asked for stays while the tile is between "good enough" and
//    "fully covered" (so a tile resized around a boundary does not flip), and stepping up needs
//    headroom in the budget (UPGRADE_HEADROOM). Callers debounce layout changes on top.
import { SIMULCAST, type SimulcastLayer } from './encoding.ts'
import type { Layer } from './MediaTransport.ts'

export type LayeredKind = keyof typeof SIMULCAST

/** How big a received video is drawn, in device pixels, and whether it is drawn at all */
export interface VideoDemand {
  width: number
  height: number
  visible: boolean
  /** The received picture's width / height (videoWidth / videoHeight); null before frames */
  aspect: number | null
}

export interface LayerInput {
  key: string
  kind: LayeredKind
  /** Where it is drawn; null: nowhere (no tile shows it) */
  demand: VideoDemand | null
  /** The layer asked for now; null: none yet */
  current: Layer | null
}

/** Video for one member's downlink, bits per second: AC-2.6 is 4 Mbps with sound and overhead */
export const DOWNLINK_BUDGET_BPS = 3_400_000
/** Stepping up needs the result to fit this share of the budget (no flapping at the edge) */
export const UPGRADE_HEADROOM = 0.85
/** A layer is good enough when its short side is at least this share of what is drawn */
export const UPSCALE_OK = 0.8
/** Pixel ratios above this ask for no more (a phone at 3× gains little from the extra pixels) */
export const MAX_PIXEL_RATIO = 2
/** The source aspect assumed until frames arrive: cameras are captured at 16:9 (devices.ts) */
const DEFAULT_ASPECT = 16 / 9

const ORDER: Record<Layer, number> = { high: 2, medium: 1, low: 0 }

/** The layers of a kind, highest first (encoding.ts) */
export const ladder = (kind: LayeredKind): readonly SimulcastLayer[] => SIMULCAST[kind]

/** The layer a kind has nearest to `layer` (a screen has no low: medium) */
export function clampLayer(kind: LayeredKind, layer: Layer): Layer {
  const layers = ladder(kind)
  return (
    layers.find((l) => l.layer === layer)?.layer ??
    [...layers].sort(
      (a, b) => Math.abs(ORDER[a.layer] - ORDER[layer]) - Math.abs(ORDER[b.layer] - ORDER[layer]),
    )[0].layer
  )
}

/** The source's short side, in device pixels, that a tile of this size puts on screen */
export function shownShortSide(kind: LayeredKind, demand: VideoDemand): number {
  const aspect = demand.aspect && demand.aspect > 0 ? demand.aspect : DEFAULT_ASPECT
  const { width, height } = demand
  // The source scaled to height `s` (width s × aspect): cover fills the tile, contain fits in it
  const s = kind === 'cam' ? Math.max(width / aspect, height) : Math.min(width / aspect, height)
  return Math.max(0, s * Math.min(1, aspect))
}

/** The layer for one video by size alone, keeping `current` while it is in the hysteresis band */
export function layerForSize(
  kind: LayeredKind,
  demand: VideoDemand | null,
  current: Layer | null,
): Layer {
  const layers = ladder(kind)
  const lowest = layers[layers.length - 1]
  if (!demand || !demand.visible || demand.width <= 0 || demand.height <= 0) return lowest.layer
  const needed = shownShortSide(kind, demand)
  // Lowest first: the smallest layer that is good enough, else the highest there is
  const fromLowest = [...layers].reverse()
  const ideal = fromLowest.find((l) => l.shortSide >= needed * UPSCALE_OK) ?? layers[0]
  const now = current ? layers.find((l) => l.layer === current) : undefined
  if (!now || ORDER[now.layer] <= ORDER[ideal.layer]) return ideal.layer
  // Asked for more than needed: step down only to a layer that covers the tile fully
  const covering = fromLowest.find(
    (l) => ORDER[l.layer] >= ORDER[ideal.layer] && l.shortSide >= needed,
  )
  return covering && ORDER[covering.layer] < ORDER[now.layer] ? covering.layer : now.layer
}

const bitrate = (kind: LayeredKind, layer: Layer): number =>
  ladder(kind).find((l) => l.layer === layer)?.maxBitrate ?? 0

const lower = (kind: LayeredKind, layer: Layer): Layer | null => {
  const layers = ladder(kind)
  const index = layers.findIndex((l) => l.layer === layer)
  return index >= 0 && index < layers.length - 1 ? layers[index + 1].layer : null
}

/**
 * The layer for every received video: by size and visibility, then stepped down to fit the
 * budget one step at a time, and an upgrade only with headroom. Each step goes to the camera
 * that loses least by it (small tiles before big ones; equal tiles share the cut), and to the
 * screen only once no camera can go lower.
 */
export function chooseLayers(inputs: readonly LayerInput[], budgetBps: number): Map<string, Layer> {
  const chosen = new Map<string, Layer>()
  for (const input of inputs) {
    const current = input.current ? clampLayer(input.kind, input.current) : null
    chosen.set(input.key, layerForSize(input.kind, input.demand, current))
  }
  const total = () => inputs.reduce((sum, i) => sum + bitrate(i.kind, chosen.get(i.key)!), 0)
  /** How much of what the tile shows a layer covers (1: all of it) */
  const coverage = (i: LayerInput, layer: Layer) => {
    const needed = i.demand?.visible ? shownShortSide(i.kind, i.demand) : 0
    const side = ladder(i.kind).find((l) => l.layer === layer)?.shortSide ?? 0
    return needed > 0 ? Math.min(1, side / needed) : 1
  }
  const area = (i: LayerInput) => (i.demand?.visible ? i.demand.width * i.demand.height : 0)
  /**
   * The next one to step down among `candidates`: the camera whose step loses the fewest drawn
   * pixels' worth of detail (its area times the coverage it gives up), the screen only when no
   * camera can go lower; null when none can
   */
  const nextDown = (candidates: readonly LayerInput[]): LayerInput | null => {
    for (const kind of ['cam', 'screen'] as const) {
      let best: { input: LayerInput; loss: number } | null = null
      for (const input of candidates) {
        if (input.kind !== kind) continue
        const now = chosen.get(input.key)!
        const step = lower(input.kind, now)
        if (step === null) continue
        const loss = area(input) * (coverage(input, now) - coverage(input, step))
        if (!best || loss < best.loss || (loss === best.loss && input.key < best.input.key)) {
          best = { input, loss }
        }
      }
      if (best) return best.input
    }
    return null
  }
  const stepDown = (input: LayerInput) =>
    chosen.set(input.key, lower(input.kind, chosen.get(input.key)!)!)
  for (let next = nextDown(inputs); next && total() > budgetBps; next = nextDown(inputs)) {
    stepDown(next)
  }
  // Upgrades must leave headroom: take them back, no lower than the layer asked for now
  const upgraded = () =>
    inputs.filter(
      (i) => i.current !== null && ORDER[chosen.get(i.key)!] > ORDER[clampLayer(i.kind, i.current)],
    )
  for (
    let next = nextDown(upgraded());
    next && total() > budgetBps * UPGRADE_HEADROOM;
    next = nextDown(upgraded())
  ) {
    stepDown(next)
  }
  return chosen
}

/** A tile's drawn size in device pixels: CSS pixels times the pixel ratio (at most MAX_PIXEL_RATIO) */
export function devicePixels(cssPixels: number, pixelRatio: number): number {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  return Math.round(cssPixels * Math.min(ratio, MAX_PIXEL_RATIO))
}

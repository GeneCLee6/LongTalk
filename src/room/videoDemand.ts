import type { VideoDemand } from '../media/layers.ts'

// Where each received video is drawn (e2-t12): tiles report it (useVideoDemand), RoomMedia reads
// it to pick simulcast layers (media/layers.ts). Keyed by the MediaStreamTrack itself, so the
// tiles need no track addresses: whatever <video> shows a received track reports for it. A track
// shown in more than one place counts as its biggest visible one. No React here.
//
// Seats (L1, e2-t18, e10-t01): a camera not subscribed has no track and no <video>, so a tile also
// says where it would draw it, keyed by the camera's trackKey (TileSeat). That is what decides
// whether to subscribe at all (media/subscriptions.ts) and at which layer to start.

export type Demands = ReadonlyMap<MediaStreamTrack, VideoDemand>

/** Where a tile would draw a camera, whether or not it is subscribed */
export interface Seat {
  width: number
  height: number
  visible: boolean
  /** About to be visible (the pointer on the pager's button): subscribe, at the lowest layer */
  near?: boolean
}

export class VideoDemandStore {
  /** Each place a track is drawn, by a token per <video> */
  readonly #views = new Map<MediaStreamTrack, Map<object, VideoDemand>>()
  readonly #seats = new Map<string, Map<object, Seat>>()
  readonly #listeners = new Set<() => void>()
  #pageHidden = false

  /** One <video>'s report (null: it stopped drawing the track) */
  report(track: MediaStreamTrack, view: object, demand: VideoDemand | null): void {
    let views = this.#views.get(track)
    const before = views?.get(view)
    if (demand === null) {
      if (!views?.delete(view)) return
      if (views.size === 0) this.#views.delete(track)
    } else {
      if (before && sameDemand(before, demand)) return
      if (!views) this.#views.set(track, (views = new Map()))
      views.set(view, demand)
    }
    this.#emit()
  }

  /** One tile's seat for a camera, by its trackKey (null: the tile is gone or shows another) */
  reportSeat(key: string, view: object, seat: Seat | null): void {
    let views = this.#seats.get(key)
    const before = views?.get(view)
    if (seat === null) {
      if (!views?.delete(view)) return
      if (views.size === 0) this.#seats.delete(key)
    } else {
      if (before && sameSeat(before, seat)) return
      if (!views) this.#seats.set(key, (views = new Map()))
      views.set(view, seat)
    }
    this.#emit()
  }

  /** The cameras a tile shows, or is about to; none while the tab is in the background */
  inSight(): Set<string> {
    const keys = new Set<string>()
    if (this.#pageHidden) return keys
    for (const [key, views] of this.#seats) {
      for (const seat of views.values()) {
        if (seat.visible || seat.near) keys.add(key)
      }
    }
    return keys
  }

  /** Where a camera would be drawn, as a demand for its first layer; null when no tile shows it */
  seatDemand(key: string): VideoDemand | null {
    let best: Seat | null = null
    for (const seat of this.#seats.get(key)?.values() ?? []) {
      if (!best || seatRank(seat) > seatRank(best)) best = seat
    }
    if (!best) return null
    const visible = best.visible && !this.#pageHidden
    return { width: best.width, height: best.height, visible, aspect: null }
  }

  get pageHidden(): boolean {
    return this.#pageHidden
  }

  /** The browser tab is in the background: nothing is on screen */
  setPageHidden(hidden: boolean): void {
    if (hidden === this.#pageHidden) return
    this.#pageHidden = hidden
    this.#emit()
  }

  /** Where `track` is drawn: its biggest visible view (or a hidden one); null when nowhere */
  get(track: MediaStreamTrack): VideoDemand | null {
    const views = this.#views.get(track)
    if (!views || views.size === 0) return null
    let best: VideoDemand | null = null
    for (const view of views.values()) {
      if (!best || rank(view) > rank(best)) best = view
    }
    if (best && this.#pageHidden) return { ...best, visible: false }
    return best
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

const rank = (d: VideoDemand) => (d.visible ? 1 + d.width * d.height : 0)
const seatRank = (s: Seat) => (s.visible ? 1 + s.width * s.height : 0)

const sameSeat = (a: Seat, b: Seat) =>
  a.width === b.width &&
  a.height === b.height &&
  a.visible === b.visible &&
  (a.near ?? false) === (b.near ?? false)

const sameDemand = (a: VideoDemand, b: VideoDemand) =>
  a.width === b.width &&
  a.height === b.height &&
  a.visible === b.visible &&
  a.aspect === b.aspect &&
  (a.sourceShortSide ?? null) === (b.sourceShortSide ?? null)

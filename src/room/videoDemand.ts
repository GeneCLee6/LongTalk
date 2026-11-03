import type { VideoDemand } from '../media/layers.ts'

// Where each received video is drawn (e2-t12): tiles report it (useVideoDemand), RoomMedia reads
// it to pick simulcast layers (media/layers.ts). Keyed by the MediaStreamTrack itself, so the
// tiles need no track addresses: whatever <video> shows a received track reports for it. A track
// shown in more than one place counts as its biggest visible one. No React here.

export type Demands = ReadonlyMap<MediaStreamTrack, VideoDemand>

export class VideoDemandStore {
  /** Each place a track is drawn, by a token per <video> */
  readonly #views = new Map<MediaStreamTrack, Map<object, VideoDemand>>()
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

const sameDemand = (a: VideoDemand, b: VideoDemand) =>
  a.width === b.width && a.height === b.height && a.visible === b.visible && a.aspect === b.aspect

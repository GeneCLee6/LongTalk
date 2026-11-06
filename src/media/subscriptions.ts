// Which cameras to receive at all (L1, e2-t18, e10-t01, AC-10.1; ADR-001 「只訂閱看得到的人」): pure
// rules with the clock passed in, so RoomMedia runs them and the tests drive them.
//
// Realtime has no pause (ADR-001): a video not drawn still costs 120 kbps per camera at its lowest
// layer, and stopping it means closing the track, an SDP exchange each way. So:
// - A camera a tile shows, or is about to (the pointer on the pager's button), is received, once
//   it has stayed in sight for SIGHT_SETTLE_MS: pages passed on the way to another are not
//   subscribed, and a page's cameras arrive together, as one batch.
// - A camera that leaves sight stays for UNSEEN_GRACE_MS, at its lowest layer: paging back and
//   forth costs no SDP at all. With the tab in the background, for HIDDEN_GRACE_MS: looking at
//   another tab for a moment is common.
// - The cameras RoomMedia keeps (setVideoPriority: the pin, the spotlight, the big tile, whoever
//   speaks; at most KEEP_WHEN_CUT, each for a while after it was last listed) are received
//   wherever their tiles are, unless the tab is in the background: the speaker's picture is there
//   as soon as anyone looks.
// - The cameras a recording made here draws are received whatever the screen shows (`needed`):
//   the recorder reads the tracks, not the tiles.
// - Microphones and screens are not decided here: every microphone is received (PRD E10: 不可見者
//   退訂視訊但保留音訊; the sound plays outside the tiles), a muted one costs nothing, and a room
//   has at most three screens.
//
// On top of this the adaptation may cut cameras (adaptation.ts) and 純音訊模式 receives none;
// RoomMedia asks those first.

/** A camera must stay in sight this long before it is subscribed */
export const SIGHT_SETTLE_MS = 150
/** A camera out of sight is unsubscribed after this long */
export const UNSEEN_GRACE_MS = 10_000
/** The same with the tab in the background */
export const HIDDEN_GRACE_MS = 30_000
/**
 * Looking again this long after a grace ends: a page's tiles report one by one, a few ms apart,
 * and they should all go in one batch, one SDP exchange
 */
export const GRACE_BATCH_MS = 100
/** Subscriptions in one SDP exchange; worker/sfu.ts refuses more */
export const MAX_SUBSCRIBE_BATCH = 16

interface Sighting {
  /** In sight since; null: out of sight */
  since: number | null
  /** Out of sight since; null: in sight */
  leftAt: number | null
}

/** When each camera came into sight and left it */
export class CameraSight {
  readonly #sightings = new Map<string, Sighting>()

  /** Everything in sight now; returns whether anything changed */
  update(inSight: ReadonlySet<string>, now: number): boolean {
    let changed = false
    for (const key of inSight) {
      if ((this.#sightings.get(key)?.since ?? null) !== null) continue
      this.#sightings.set(key, { since: now, leftAt: null })
      changed = true
    }
    for (const [key, sighting] of this.#sightings) {
      if (inSight.has(key) || sighting.since === null) continue
      this.#sightings.set(key, { since: null, leftAt: now })
      changed = true
    }
    return changed
  }

  /**
   * Whether sight alone calls for this camera. `held`: it is received or being subscribed, so it
   * needs no settling and gets its grace; one that is not held only counts once settled.
   */
  wanted(key: string, now: number, held: boolean, graceMs = UNSEEN_GRACE_MS): boolean {
    const sighting = this.#sightings.get(key)
    if (!sighting) return false
    if (sighting.since !== null) return held || now - sighting.since >= SIGHT_SETTLE_MS
    return held && sighting.leftAt !== null && now - sighting.leftAt < graceMs
  }

  /** When an answer of `wanted` changes next, to look again then; null: not by itself */
  nextChange(now: number, graceMs = UNSEEN_GRACE_MS): number | null {
    let next: number | null = null
    const consider = (at: number) => {
      if (at > now && (next === null || at < next)) next = at
    }
    for (const sighting of this.#sightings.values()) {
      if (sighting.since !== null) consider(sighting.since + SIGHT_SETTLE_MS)
      else if (sighting.leftAt !== null && now - sighting.leftAt < graceMs + GRACE_BATCH_MS) {
        consider(sighting.leftAt + graceMs + GRACE_BATCH_MS)
      }
    }
    return next
  }
}

export interface CameraInput {
  /** CameraSight.wanted */
  seen: boolean
  /** Kept by setVideoPriority: the pin, the spotlight, the big tile, whoever speaks */
  kept: boolean
  /** A recording made here draws it */
  needed: boolean
  /** The tab is in the background */
  hidden: boolean
}

/** Whether to receive a camera (when the adaptation and 純音訊模式 have nothing against it) */
export function cameraWanted({ seen, kept, needed, hidden }: CameraInput): boolean {
  return needed || seen || (kept && !hidden)
}

/** Tracks in batches of at most `size`, the ones with something to send first */
export function subscribeBatches<T extends { muted?: boolean }>(
  tracks: readonly T[],
  size = MAX_SUBSCRIBE_BATCH,
): T[][] {
  // A track that has never sent can hold up a whole call for seconds (empty_track_error): a muted
  // one is the likeliest, and nobody is waiting to see it
  const ordered = [...tracks.filter((t) => !t.muted), ...tracks.filter((t) => t.muted)]
  const batches: T[][] = []
  for (let i = 0; i < ordered.length; i += size) batches.push(ordered.slice(i, i + size))
  return batches
}

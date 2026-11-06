// The strokes on a room's shares (J2, e7-t04): one layer per share, keyed by the sharer, and one for
// the whiteboard (J3, e7-t06, WHITEBOARD_LAYER), with its own limits. The limits are
// shared/annotation-limits.ts; RoomHost decides who may do what, this only keeps the strokes.
//
// In memory they are the truth, and every change is cheap: a stroke being drawn changes ten times a
// second and nothing is written. Storage gets them in segments: each stroke belongs to a segment
// (about SEGMENT_CHARS of strokes, in the order they came), a change marks its segment, and
// `takeWrites` hands over the marked ones to write: what makes a batch (RoomHost calls it at most
// every ANNOTATION_FLUSH_MS). A stroke's place is its segment and its place in that, so a restore
// brings back the same order.
import {
  applyStrokeUpdate,
  limitsOf,
  spaceOf,
  strokeCost,
  type NormPoint,
  type Stroke,
} from '../shared/annotation.ts'
import { SEGMENT_CHARS, SNAPSHOT_FRAME_CHARS } from '../shared/annotation-limits.ts'
import type { AnnotationsMessage } from '../shared/protocol.ts'

/** One stored batch of a share's strokes, oldest first */
export type AnnotationSegment = { share: string; segment: number; strokes: Stroke[] }

/** A segment to store; `strokes` null: delete it */
export type AnnotationWrite = { share: string; segment: number; strokes: Stroke[] | null }

type Entry = { stroke: Stroke; cost: number; segment: number }

type Tally = { strokes: number; cost: number }

class Layer {
  readonly entries = new Map<string, Entry>()
  /** Which strokes each segment holds */
  readonly segments = new Map<number, Set<string>>()
  readonly tallies = new Map<string, Tally>()
  cost = 0
  /** The segment taking new strokes, and how full it is */
  open = 0
  openCost = 0

  tally(member: string): Tally {
    let tally = this.tallies.get(member)
    if (!tally) {
      tally = { strokes: 0, cost: 0 }
      this.tallies.set(member, tally)
    }
    return tally
  }
}

const writeKey = (share: string, segment: number) => `${share}\n${segment}`

/** What a change did: the stroke as kept, and the ids that fell out to make room */
export type PutResult = { stroke: Stroke; evicted: string[] }

export class RoomAnnotations {
  private readonly layers = new Map<string, Layer>()
  private readonly dirty = new Set<string>()

  /** From storage after a wake-up; a segment of a share `live` does not list is deleted */
  constructor(
    saved: readonly AnnotationSegment[] = [],
    live: (share: string) => boolean = () => true,
  ) {
    const ordered = [...saved].sort((a, b) => a.segment - b.segment)
    for (const { share, segment, strokes } of ordered) {
      if (!live(share)) {
        this.dirty.add(writeKey(share, segment))
        continue
      }
      const layer = this.layer(share)
      layer.open = segment
      layer.openCost = 0
      for (const stroke of strokes) {
        const entry: Entry = { stroke, cost: strokeCost(stroke), segment }
        this.account(layer, entry)
        layer.openCost += entry.cost
      }
    }
  }

  private layer(share: string): Layer {
    let layer = this.layers.get(share)
    if (!layer) {
      layer = new Layer()
      this.layers.set(share, layer)
    }
    return layer
  }

  /** A stroke entering a layer: its tallies and its segment's list */
  private account(layer: Layer, entry: Entry): void {
    const { stroke, cost, segment } = entry
    layer.entries.set(stroke.id, entry)
    const ids = layer.segments.get(segment) ?? new Set<string>()
    ids.add(stroke.id)
    layer.segments.set(segment, ids)
    layer.cost += cost
    const tally = layer.tally(stroke.by)
    tally.strokes += 1
    tally.cost += cost
  }

  private drop(share: string, layer: Layer, id: string): void {
    const entry = layer.entries.get(id)
    if (!entry) return
    layer.entries.delete(id)
    layer.segments.get(entry.segment)?.delete(id)
    layer.cost -= entry.cost
    const tally = layer.tally(entry.stroke.by)
    tally.strokes -= 1
    tally.cost -= entry.cost
    this.dirty.add(writeKey(share, entry.segment))
  }

  /** Whether a stroke with this id exists on the share */
  has(share: string, id: string): boolean {
    return this.layers.get(share)?.entries.has(id) ?? false
  }

  /**
   * Whether this stroke, as new or as a change to the member's own, would take a layer that refuses
   * past its limits (the whiteboard) over them. A stroke that shrinks always fits, so finishing one
   * (simplified, shorter) is never what goes over. A layer that evicts is never full.
   */
  overflows(share: string, stroke: Stroke): boolean {
    const limits = limitsOf(share)
    if (limits.whenFull !== 'refuse') return false
    const layer = this.layers.get(share)
    const existing = layer?.entries.get(stroke.id)
    const change = strokeCost(stroke) - (existing?.cost ?? 0)
    if (existing && change <= 0) return false
    const tally = layer?.tallies.get(stroke.by)
    const added = existing ? 0 : 1
    return (
      (layer?.entries.size ?? 0) + added > limits.strokes ||
      (layer?.cost ?? 0) + change > limits.cost ||
      (tally?.strokes ?? 0) + added > limits.memberStrokes ||
      (tally?.cost ?? 0) + change > limits.memberCost
    )
  }

  /** Who has strokes on a layer, and how many */
  authors(share: string): Map<string, number> {
    const counts = new Map<string, number>()
    for (const [member, tally] of this.layers.get(share)?.tallies ?? []) {
      if (tally.strokes > 0) counts.set(member, tally.strokes)
    }
    return counts
  }

  /**
   * Adds a stroke (stamped with its member in `by`), or replaces the member's own with its id,
   * keeping its place. Null when the id is someone else's. Past the limits older strokes fall out,
   * the member's own first when it is the member's limit.
   */
  put(share: string, stroke: Stroke): PutResult | null {
    const layer = this.layer(share)
    const existing = layer.entries.get(stroke.id)
    if (existing) {
      if (existing.stroke.by !== stroke.by) return null
      return this.replace(share, layer, existing, stroke)
    }
    if (layer.openCost >= SEGMENT_CHARS) {
      layer.open += 1
      layer.openCost = 0
    }
    const entry: Entry = { stroke, cost: strokeCost(stroke), segment: layer.open }
    this.account(layer, entry)
    layer.openCost += entry.cost
    this.dirty.add(writeKey(share, layer.open))
    return { stroke, evicted: this.enforce(share, layer, stroke.by, stroke.id) }
  }

  private replace(share: string, layer: Layer, existing: Entry, stroke: Stroke): PutResult {
    const cost = strokeCost(stroke)
    const change = cost - existing.cost
    existing.stroke = stroke
    existing.cost = cost
    layer.cost += change
    layer.tally(stroke.by).cost += change
    if (existing.segment === layer.open) layer.openCost += change
    this.dirty.add(writeKey(share, existing.segment))
    return { stroke, evicted: this.enforce(share, layer, stroke.by, stroke.id) }
  }

  /** Makes room, never taking `keep`, the stroke just touched */
  private enforce(share: string, layer: Layer, member: string, keep: string): string[] {
    const limits = limitsOf(share)
    // Nothing falls out of a board: `overflows` refused what would not fit
    if (limits.whenFull === 'refuse') return []
    const evicted: string[] = []
    const memberTally = layer.tally(member)
    const oldest = (mine: boolean): string | null => {
      for (const [id, entry] of layer.entries) {
        if (id !== keep && (!mine || entry.stroke.by === member)) return id
      }
      return null
    }
    const take = (mine: boolean): boolean => {
      const id = oldest(mine)
      if (id === null) return false
      this.drop(share, layer, id)
      evicted.push(id)
      return true
    }
    while (memberTally.strokes > limits.memberStrokes || memberTally.cost > limits.memberCost) {
      if (!take(true)) break
    }
    while (layer.entries.size > limits.strokes || layer.cost > limits.cost) {
      if (!take(false)) break
    }
    return evicted
  }

  /**
   * A stroke being drawn (applyStrokeUpdate), by its own member. Null when there is no such stroke
   * of theirs (it fell out, or the share restarted) or the update does not apply: the final `add`
   * still brings the whole stroke.
   */
  update(
    share: string,
    member: string,
    id: string,
    at: number,
    points: readonly NormPoint[],
  ): PutResult | null {
    const layer = this.layers.get(share)
    const existing = layer?.entries.get(id)
    if (!layer || !existing || existing.stroke.by !== member) return null
    const stroke = applyStrokeUpdate(existing.stroke, at, points, spaceOf(share))
    if (!stroke || this.overflows(share, stroke)) return null
    return this.replace(share, layer, existing, stroke)
  }

  /** The member's own stroke goes; false when there is no such stroke of theirs */
  remove(share: string, member: string, id: string): boolean {
    const layer = this.layers.get(share)
    if (layer?.entries.get(id)?.stroke.by !== member) return false
    this.drop(share, layer, id)
    return true
  }

  /** Every stroke of the member's on the share */
  clearBy(share: string, member: string): void {
    const layer = this.layers.get(share)
    if (!layer) return
    for (const [id, entry] of [...layer.entries]) {
      if (entry.stroke.by === member) this.drop(share, layer, id)
    }
  }

  /** The share stopped: its layer goes, with everything stored of it */
  clearShare(share: string): boolean {
    const layer = this.layers.get(share)
    if (!layer) return false
    for (const segment of layer.segments.keys()) this.dirty.add(writeKey(share, segment))
    this.layers.delete(share)
    return true
  }

  /** The room closed: its storage goes as a whole, nothing to write */
  reset(): void {
    this.layers.clear()
    this.dirty.clear()
  }

  /** The strokes of a share in order, oldest first */
  strokes(share: string): Stroke[] {
    return [...(this.layers.get(share)?.entries.values() ?? [])].map((entry) => entry.stroke)
  }

  /**
   * What an arriving member gets (see AnnotationsMessage): frames of about SNAPSHOT_FRAME_CHARS,
   * `reset` on the first and `done` on the last; one frame with neither strokes nor share when
   * there is nothing.
   */
  snapshot(): AnnotationsMessage[] {
    const frames: AnnotationsMessage[] = []
    for (const [share, layer] of this.layers) {
      let strokes: Stroke[] = []
      let size = 0
      for (const { stroke, cost } of layer.entries.values()) {
        if (size + cost > SNAPSHOT_FRAME_CHARS && strokes.length > 0) {
          frames.push({ t: 'annotations', share, strokes })
          strokes = []
          size = 0
        }
        strokes.push(stroke)
        size += cost
      }
      if (strokes.length > 0) frames.push({ t: 'annotations', share, strokes })
    }
    if (frames.length === 0) frames.push({ t: 'annotations', share: null, strokes: [] })
    frames[0].reset = true
    frames[frames.length - 1].done = true
    return frames
  }

  get hasWrites(): boolean {
    return this.dirty.size > 0
  }

  /** The segments that changed since the last call, to store now */
  takeWrites(): AnnotationWrite[] {
    const writes: AnnotationWrite[] = []
    for (const key of this.dirty) {
      const [share, segment] = key.split('\n')
      const number = Number(segment)
      const layer = this.layers.get(share)
      const ids = layer?.segments.get(number)
      if (!layer || !ids || ids.size === 0) {
        layer?.segments.delete(number)
        writes.push({ share, segment: number, strokes: null })
      } else {
        const strokes = [...layer.entries.values()]
          .filter((entry) => entry.segment === number)
          .map((entry) => entry.stroke)
        writes.push({ share, segment: number, strokes })
      }
    }
    this.dirty.clear()
    return writes
  }
}

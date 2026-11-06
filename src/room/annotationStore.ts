import { ACTIVE_STROKE_MS, LASER_FADE_MS } from '../../shared/annotation-limits.ts'
import {
  applyStrokeUpdate,
  spaceOf,
  type AnnotationColor,
  type AnnotationOp,
  type NormPoint,
  type Stroke,
} from '../../shared/annotation.ts'
import type {
  AnnotationMessage,
  AnnotationsMessage,
  ClientMessage,
} from '../../shared/protocol.ts'

/** Someone's laser pointer as last heard: `heardAt` is when (this browser's clock) */
export interface LaserState {
  by: string
  at: NormPoint
  color: AnnotationColor
  heardAt: number
}

/** A stroke being drawn right now: who, and when we last heard of it */
export interface ActiveStroke {
  by: string
  at: number
}

class Layer {
  readonly strokes = new Map<string, Stroke>()
  readonly active = new Map<string, ActiveStroke>()
  readonly lasers = new Map<string, LaserState>()
  /** Oldest first; made again after a change */
  list: readonly Stroke[] | null = null
  /** Grows whenever a stroke not being drawn changes: the canvas keeps those in a picture */
  settled = 0
}

export interface AnnotationStoreDeps {
  send: (message: ClientMessage) => void
  isOpen: () => boolean
  now?: () => number
}

const EMPTY: readonly Stroke[] = []
const NO_ACTIVE: ReadonlyMap<string, ActiveStroke> = new Map()

/**
 * What this browser knows of the marks on the room's shares (J2, e7-t04): one layer per share, fed
 * by the room's `annotation` and `annotations` messages and by our own drawing. In the room's first
 * load, because anyone must receive strokes from the moment they join; the canvas, the toolbar and
 * the drawing (src/annotate/) load only when there is something to show or the member starts to
 * draw (CLAUDE.md rule 6). Outside React's state on purpose: a stroke changes ten times a second,
 * and only the canvas of its share listens.
 */
export class AnnotationStore {
  private readonly layers = new Map<string, Layer>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly snapshotListeners = new Set<() => void>()
  private readonly deps: AnnotationStoreDeps
  /** Numbers Layer.settled across layers: a layer gone and made anew never repeats a value */
  private stamp = 0

  constructor(deps: AnnotationStoreDeps) {
    this.deps = deps
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** The socket is up: what is sent now reaches the room */
  get open(): boolean {
    return this.deps.isOpen()
  }

  /** One frame of ops to the room (src/annotate/sync.ts paces them) */
  send(share: string, ops: AnnotationOp[]): void {
    this.deps.send({ t: 'annotate', share, ops })
  }

  /** Clears a layer, or one member's strokes on it, for everyone: the room decides (J3, e7-t05) */
  clearLayer(share: string, by: string | null): void {
    this.deps.send({ t: 'clearAnnotations', share, by })
  }

  /** A message from the room */
  receive(message: AnnotationMessage | AnnotationsMessage): void {
    if (message.t === 'annotations') {
      this.receiveSnapshot(message)
      return
    }
    for (const op of message.ops) this.applyOp(message.share, message.by, op)
    this.notify(message.share)
  }

  private receiveSnapshot({ share, strokes, reset, done }: AnnotationsMessage): void {
    if (reset) {
      const known = [...this.layers.keys()]
      this.layers.clear()
      for (const id of known) this.notify(id)
    }
    if (share !== null) {
      const layer = this.layerFor(share)
      for (const stroke of strokes) layer.strokes.set(stroke.id, stroke)
      layer.list = null
      layer.settled = ++this.stamp
      this.notify(share)
    }
    if (done) for (const listener of this.snapshotListeners) listener()
  }

  /** Our own op, applied at once: the room only hears about it (it does not send it back) */
  applyLocal(share: string, by: string, op: AnnotationOp): void {
    this.applyOp(share, by, op)
    this.notify(share)
  }

  private layerFor(share: string): Layer {
    let layer = this.layers.get(share)
    if (!layer) {
      layer = new Layer()
      this.layers.set(share, layer)
    }
    return layer
  }

  private applyOp(share: string, by: string | null, op: AnnotationOp): void {
    const now = this.now
    switch (op.op) {
      case 'add': {
        const layer = this.layerFor(share)
        const { id } = op.stroke
        layer.strokes.set(id, op.stroke)
        layer.list = null
        if (op.live) {
          layer.active.set(id, { by: op.stroke.by, at: now })
        } else {
          layer.active.delete(id)
          layer.settled = ++this.stamp
        }
        return
      }
      case 'update': {
        const layer = this.layers.get(share)
        const stroke = layer?.strokes.get(op.id)
        const next = stroke && applyStrokeUpdate(stroke, op.at, op.points, spaceOf(share))
        if (!layer || !next) return
        layer.strokes.set(op.id, next)
        layer.list = null
        layer.active.set(op.id, { by: next.by, at: now })
        return
      }
      case 'remove': {
        const layer = this.layers.get(share)
        if (!layer?.strokes.delete(op.id)) return
        layer.active.delete(op.id)
        layer.list = null
        layer.settled = ++this.stamp
        return
      }
      case 'clear': {
        const layer = this.layers.get(share)
        if (!layer) return
        if (op.by === undefined) {
          this.layers.delete(share)
          return
        }
        for (const [id, stroke] of layer.strokes) {
          if (stroke.by !== op.by) continue
          layer.strokes.delete(id)
          layer.active.delete(id)
        }
        layer.list = null
        layer.settled = ++this.stamp
        return
      }
      case 'laser': {
        if (by === null) return
        const layer = this.layerFor(share)
        const last = layer.lasers.get(by)
        if (op.at !== null) {
          layer.lasers.set(by, { by, at: op.at, color: op.color, heardAt: now })
        } else if (last) {
          // Gone from the picture: it fades from where it was, from now
          layer.lasers.set(by, { ...last, heardAt: now })
        }
        return
      }
    }
  }

  /** Listens for changes to one share's layer; returns a function that stops listening */
  subscribe(share: string, listener: () => void): () => void {
    let listeners = this.listeners.get(share)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(share, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** The whole set arrived after a welcome; returns a function that stops listening */
  onSnapshot(listener: () => void): () => void {
    this.snapshotListeners.add(listener)
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  private notify(share: string): void {
    for (const listener of this.listeners.get(share) ?? []) listener()
  }

  /** A share's strokes, oldest first */
  strokes(share: string): readonly Stroke[] {
    const layer = this.layers.get(share)
    if (!layer) return EMPTY
    layer.list ??= [...layer.strokes.values()]
    return layer.list
  }

  has(share: string, id: string): boolean {
    return this.layers.get(share)?.strokes.has(id) ?? false
  }

  /** Who has strokes on a layer and how many, in the order they first drew */
  authors(share: string): Map<string, number> {
    const counts = new Map<string, number>()
    for (const { by } of this.strokes(share)) counts.set(by, (counts.get(by) ?? 0) + 1)
    return counts
  }

  /** Grows when a stroke not being drawn changes, see Layer */
  settledVersion(share: string): number {
    return this.layers.get(share)?.settled ?? 0
  }

  /** The strokes being drawn now. One going quiet (its member vanished) stops counting */
  active(share: string): ReadonlyMap<string, ActiveStroke> {
    const layer = this.layers.get(share)
    if (!layer) return NO_ACTIVE
    const now = this.now
    for (const [id, { at }] of layer.active) {
      if (now - at > ACTIVE_STROKE_MS) layer.active.delete(id)
    }
    return layer.active
  }

  /** The laser pointers still visible; ones past LASER_FADE_MS are forgotten */
  lasers(share: string): LaserState[] {
    const layer = this.layers.get(share)
    if (!layer) return []
    const now = this.now
    for (const [by, { heardAt }] of layer.lasers) {
      if (now - heardAt >= LASER_FADE_MS) layer.lasers.delete(by)
    }
    return [...layer.lasers.values()]
  }

  /** Whether there is anything to show on this share: what loads the canvas */
  marked(share: string): boolean {
    const layer = this.layers.get(share)
    return !!layer && (layer.strokes.size > 0 || layer.lasers.size > 0)
  }
}

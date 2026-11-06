import {
  ANNOTATION_FRAME_CHARS,
  ANNOTATION_SEND_MS,
  MAX_ANNOTATION_HISTORY,
  MAX_ANNOTATION_OUTBOX,
  MAX_FRAME_OPS,
} from '../../shared/annotation-limits.ts'
import {
  beginStroke,
  extendStroke,
  finishStroke,
  normalizePoint,
  spaceOf,
  strokeAt,
  type AnnotationColor,
  type AnnotationOp,
  type AnnotationTool,
  type AnnotationWidth,
  type CoordSpace,
  type Stroke,
} from '../../shared/annotation.ts'
import type { Point } from '../../shared/shareGeometry.ts'
import type { AnnotationStore } from '../room/annotationStore.ts'

export interface DrawerClock {
  now: () => number
  setTimeout: (work: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

const systemClock: DrawerClock = {
  now: () => Date.now(),
  setTimeout: (work, ms) => setTimeout(work, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

type HistoryEntry = { kind: 'draw' | 'erase'; stroke: Stroke }

/** The ops worth keeping while the socket is away: not a position, not a stroke half-sent */
const lasting = (op: AnnotationOp): boolean =>
  op.op === 'remove' || op.op === 'clear' || (op.op === 'add' && !op.live)

const opStroke = (op: AnnotationOp): string | null =>
  op.op === 'add' ? op.stroke.id : op.op === 'update' ? op.id : null

/**
 * One member drawing on one share (e7-t03, e7-t04). Everything happens in the store at once, so our
 * own marks never wait for the network; what goes to the room is paced here:
 *
 * - at most one frame every ANNOTATION_SEND_MS, carrying everything since the last (PRD E7: 100 ms;
 *   the socket limit SOCKET_MESSAGE_RATE cannot be reached however fast someone scribbles);
 * - a stroke being drawn sends only its new points; the end of a stroke sends it whole, simplified;
 * - while the socket is away, what lasts is kept and sent after the room's snapshot; a stroke still
 *   being drawn then goes whole again.
 *
 * Undo and redo are per member and only touch their own strokes (and their own erasures). Clearing
 * is not undoable: bringing back hundreds of strokes would run into the stroke limit.
 */
export class AnnotationDrawer {
  private readonly store: AnnotationStore
  private readonly share: string
  /** A share's 0–1, or the whiteboard's world (J3) */
  private readonly space: CoordSpace
  private readonly by: string
  private readonly clock: DrawerClock
  private queue: AnnotationOp[] = []
  private timer: unknown = null
  private lastSent = Number.NEGATIVE_INFINITY
  private outbox: AnnotationOp[] = []
  private current: { stroke: Stroke; sent: number; changed: boolean } | null = null
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private version = 0
  private readonly listeners = new Set<() => void>()

  constructor(store: AnnotationStore, share: string, by: string, clock: DrawerClock = systemClock) {
    this.store = store
    this.share = share
    this.space = spaceOf(share)
    this.by = by
    this.clock = clock
    store.onSnapshot(() => this.afterSnapshot())
  }

  /** For the toolbar: grows when canUndo or canRedo may have changed */
  getVersion = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  get drawing(): boolean {
    return this.current !== null
  }

  private apply(op: AnnotationOp): void {
    this.store.applyLocal(this.share, this.by, op)
  }

  private remember(entry: HistoryEntry): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > MAX_ANNOTATION_HISTORY) this.undoStack.shift()
    this.redoStack = []
    this.changed()
  }

  // ── Sending ────────────────────────────────────────────────────────────────────────────────

  private enqueue(op: AnnotationOp): void {
    // A newer whole stroke makes what is queued of it pointless
    if (op.op === 'add') {
      this.queue = this.queue.filter((queued) => opStroke(queued) !== op.stroke.id)
    }
    // Only the latest position counts
    if (op.op === 'laser') this.queue = this.queue.filter((queued) => queued.op !== 'laser')
    this.queue.push(op)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer !== null) return
    const wait = this.lastSent + ANNOTATION_SEND_MS - this.clock.now()
    if (wait <= 0) {
      this.flush()
      return
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.flush()
    }, wait)
  }

  private flush(): void {
    const { current } = this
    if (current?.changed) {
      const { stroke, sent } = current
      this.queue.push({ op: 'update', id: stroke.id, at: sent, points: stroke.points.slice(sent) })
      current.sent = stroke.points.length
      current.changed = false
    }
    if (this.queue.length === 0) return
    const ops: AnnotationOp[] = []
    let size = 0
    while (this.queue.length > 0 && ops.length < MAX_FRAME_OPS) {
      const length = JSON.stringify(this.queue[0]).length
      if (ops.length > 0 && size + length > ANNOTATION_FRAME_CHARS) break
      size += length
      ops.push(this.queue.shift()!)
    }
    this.lastSent = this.clock.now()
    if (this.store.open) {
      this.store.send(this.share, ops)
    } else {
      this.outbox.push(...ops.filter(lasting))
      this.outbox.splice(0, Math.max(0, this.outbox.length - MAX_ANNOTATION_OUTBOX))
    }
    if (this.queue.length > 0) this.schedule()
  }

  /** The room's snapshot replaced everything: what it could not know yet goes again */
  private afterSnapshot(): void {
    const kept = this.outbox
    this.outbox = []
    for (const op of kept) {
      this.apply(op)
      this.enqueue(op)
    }
    const { current } = this
    if (current) {
      const op: AnnotationOp = { op: 'add', stroke: current.stroke, live: true }
      this.apply(op)
      current.sent = current.stroke.points.length
      current.changed = false
      this.enqueue(op)
    }
  }

  // ── Drawing ────────────────────────────────────────────────────────────────────────────────

  /** A stroke starts; false when the point is not usable */
  begin(options: {
    tool: AnnotationTool
    color: AnnotationColor
    width: AnnotationWidth
    at: Point
  }): boolean {
    this.cancel()
    const stroke = beginStroke({ by: this.by, ...options, space: this.space })
    if (!stroke) return false
    this.current = { stroke, sent: stroke.points.length, changed: false }
    const op: AnnotationOp = { op: 'add', stroke, live: true }
    this.apply(op)
    this.enqueue(op)
    return true
  }

  move(at: Point, aspect: number): void {
    const { current } = this
    if (!current) return
    const next = extendStroke(current.stroke, at, aspect, this.space)
    if (next === current.stroke) return
    if (next.tool === 'arrow' || next.tool === 'rect') current.sent = 1
    // Thinned at the cap: the points so far changed, so all of them go again
    else if (next.points.length < current.stroke.points.length) current.sent = 0
    current.stroke = next
    current.changed = true
    this.apply({ op: 'add', stroke: next, live: true })
    this.schedule()
  }

  /** The pointer lifted: the stroke is kept, simplified, or goes if it came to nothing */
  end(aspect: number): void {
    const { current } = this
    if (!current) return
    this.current = null
    const finished = finishStroke(current.stroke, aspect)
    if (!finished) {
      this.discard(current.stroke.id)
      return
    }
    const op: AnnotationOp = { op: 'add', stroke: finished }
    this.apply(op)
    this.enqueue(op)
    this.remember({ kind: 'draw', stroke: finished })
  }

  /** A second finger came down, or the browser took the pointer: the stroke never happened */
  cancel(): void {
    const { current } = this
    if (!current) return
    this.current = null
    this.discard(current.stroke.id)
  }

  private discard(id: string): void {
    this.queue = this.queue.filter((queued) => opStroke(queued) !== id)
    const op: AnnotationOp = { op: 'remove', id }
    this.apply(op)
    this.enqueue(op)
  }

  /** A text mark; false when there is nothing to keep */
  addText(options: {
    text: string
    color: AnnotationColor
    width: AnnotationWidth
    at: Point
  }): boolean {
    const begun = beginStroke({ by: this.by, tool: 'text', ...options, space: this.space })
    const finished = begun && finishStroke(begun, 1)
    if (!finished) return false
    const op: AnnotationOp = { op: 'add', stroke: finished }
    this.apply(op)
    this.enqueue(op)
    this.remember({ kind: 'draw', stroke: finished })
    return true
  }

  /**
   * Erases our own topmost stroke under the point. Others' strokes go only with the clear a host or
   * the layer's owner asks for (J3: ClearMarks.tsx, confirmed), never by a stray drag
   */
  eraseAt(at: Point, aspect: number): boolean {
    const point = normalizePoint(at.x, at.y, this.space)
    if (!point) return false
    const own = this.store.strokes(this.share).filter((stroke) => stroke.by === this.by)
    const hit = strokeAt(own, point, aspect)
    if (!hit) return false
    const op: AnnotationOp = { op: 'remove', id: hit.id }
    this.apply(op)
    this.enqueue(op)
    this.remember({ kind: 'erase', stroke: hit })
    return true
  }

  undo(): void {
    if (this.current) return
    while (this.undoStack.length > 0) {
      const entry = this.undoStack.pop()!
      if (entry.kind === 'draw') {
        // It fell out, or a host cleared it: nothing to take back, the one before it then
        if (!this.store.has(this.share, entry.stroke.id)) continue
        const op: AnnotationOp = { op: 'remove', id: entry.stroke.id }
        this.apply(op)
        this.enqueue(op)
      } else {
        const op: AnnotationOp = { op: 'add', stroke: entry.stroke }
        this.apply(op)
        this.enqueue(op)
      }
      this.redoStack.push(entry)
      break
    }
    this.changed()
  }

  redo(): void {
    if (this.current) return
    const entry = this.redoStack.pop()
    if (!entry) return
    const op: AnnotationOp =
      entry.kind === 'draw'
        ? { op: 'add', stroke: entry.stroke }
        : { op: 'remove', id: entry.stroke.id }
    this.apply(op)
    this.enqueue(op)
    this.undoStack.push(entry)
    this.changed()
  }

  /** Every stroke of ours on this share; the history goes with them */
  clearOwn(): void {
    this.cancel()
    this.queue = this.queue.filter((queued) => queued.op === 'laser')
    const op: AnnotationOp = { op: 'clear' }
    this.apply({ op: 'clear', by: this.by })
    this.enqueue(op)
    this.undoStack = []
    this.redoStack = []
    this.changed()
  }

  // ── The laser pointer: never kept anywhere, it fades where it was last heard ────────────────

  laser(at: Point | null, color: AnnotationColor): void {
    const point = at && normalizePoint(at.x, at.y, this.space)
    if (at && !point) return
    const op: AnnotationOp = { op: 'laser', at: point ?? null, color }
    this.apply(op)
    this.enqueue(op)
  }
}

const drawers = new WeakMap<AnnotationStore, Map<string, AnnotationDrawer>>()

/** The drawer of a member on a share: lives as long as the store, so undo survives a tile's remount */
export function drawerFor(store: AnnotationStore, share: string, by: string): AnnotationDrawer {
  let forStore = drawers.get(store)
  if (!forStore) {
    forStore = new Map()
    drawers.set(store, forStore)
  }
  let drawer = forStore.get(share)
  if (!drawer) {
    drawer = new AnnotationDrawer(store, share, by)
    forStore.set(share, drawer)
  }
  return drawer
}

import { useEffect, useEffectEvent } from 'react'
import type { Stroke } from '../../shared/annotation.ts'
import type { AnnotationStore } from './annotationStore.ts'

/** How long one member's drawing on our share stays told: after that, new strokes tell again */
export const MARK_NOTICE_MS = 30_000

/**
 * Who started drawing on our share since we last looked (the sharer cannot see their own share
 * unless they open it, so they must be told). A stroke is told once, by its id, however often it
 * changes; each author at most once every MARK_NOTICE_MS. Our own strokes never count, nor do the
 * strokes already there when the watch starts (a snapshot after a reconnect brings the same ids).
 */
export class MarkNotices {
  private readonly seen = new Set<string>()
  private readonly toldAt = new Map<string, number>()
  private readonly me: string
  private readonly windowMs: number

  constructor(me: string, existing: readonly Stroke[] = [], windowMs = MARK_NOTICE_MS) {
    this.me = me
    this.windowMs = windowMs
    for (const stroke of existing) this.seen.add(stroke.id)
  }

  /** The authors to tell about now, in the order their new strokes came */
  take(strokes: readonly Stroke[], now: number): string[] {
    const fresh = new Set<string>()
    for (const { id, by } of strokes) {
      if (this.seen.has(id)) continue
      this.seen.add(id)
      if (by !== this.me) fresh.add(by)
    }
    const tell: string[] = []
    for (const by of fresh) {
      const last = this.toldAt.get(by)
      if (last !== undefined && now - last < this.windowMs) continue
      this.toldAt.set(by, now)
      tell.push(by)
    }
    return tell
  }
}

/**
 * Calls `onMarked` with who began drawing on our share (`layer`: our member id while we share,
 * null otherwise), as MarkNotices decides. A new share starts a new watch.
 */
export function useMarkedOnMyShareNotice(
  store: AnnotationStore,
  layer: string | null,
  onMarked: (authors: string[]) => void,
  now: () => number = () => Date.now(),
): void {
  const marked = useEffectEvent((authors: string[]) => onMarked(authors))
  const clock = useEffectEvent(() => now())
  useEffect(() => {
    if (layer === null) return
    const notices = new MarkNotices(layer, store.strokes(layer))
    return store.subscribe(layer, () => {
      const authors = notices.take(store.strokes(layer), clock())
      if (authors.length > 0) marked(authors)
    })
  }, [store, layer])
}

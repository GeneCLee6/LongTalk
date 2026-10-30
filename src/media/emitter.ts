import type { MediaTransportEvent, MediaTransportEvents, Unsubscribe } from './MediaTransport.ts'

type Handler<E extends MediaTransportEvent> = (payload: MediaTransportEvents[E]) => void

/** The event half of a MediaTransport, shared by every implementation */
export class TransportEmitter {
  #handlers = new Map<MediaTransportEvent, Set<(payload: never) => void>>()

  on<E extends MediaTransportEvent>(event: E, handler: Handler<E>): Unsubscribe {
    let set = this.#handlers.get(event)
    if (!set) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    const stored = handler as (payload: never) => void
    set.add(stored)
    return () => set.delete(stored)
  }

  emit<E extends MediaTransportEvent>(event: E, payload: MediaTransportEvents[E]): void {
    for (const handler of [...(this.#handlers.get(event) ?? [])]) {
      ;(handler as Handler<E>)(payload)
    }
  }

  clear(): void {
    this.#handlers.clear()
  }
}

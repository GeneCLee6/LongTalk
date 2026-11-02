// The browser's hints that the network changed (e2-t08): `online` / `offline` on window, and the
// page coming back to the foreground (visibilitychange), when timers were throttled and the
// socket may have died unnoticed. RoomConnection and RoomMedia react; this only listens.

export interface NetworkHandlers {
  online?: () => void
  offline?: () => void
  /** The page became visible again */
  visible?: () => void
}

export interface NetworkTargets {
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
  document?:
    | (Pick<Document, 'addEventListener' | 'removeEventListener'> & {
        visibilityState: DocumentVisibilityState
      })
    | null
}

/** Listens until the returned function is called */
export function watchNetwork(handlers: NetworkHandlers, targets: NetworkTargets = {}): () => void {
  const win = targets.window === undefined ? globalThis.window : targets.window
  const doc = targets.document === undefined ? globalThis.document : targets.document
  const online = () => handlers.online?.()
  const offline = () => handlers.offline?.()
  const visibility = () => {
    if (doc?.visibilityState === 'visible') handlers.visible?.()
  }
  win?.addEventListener('online', online)
  win?.addEventListener('offline', offline)
  doc?.addEventListener('visibilitychange', visibility)
  return () => {
    win?.removeEventListener('online', online)
    win?.removeEventListener('offline', offline)
    doc?.removeEventListener('visibilitychange', visibility)
  }
}

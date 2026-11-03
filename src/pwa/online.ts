import { useSyncExternalStore } from 'react'

// Whether the browser thinks it is online (navigator.onLine, `online` / `offline`), for the
// offline shell (e4-t12): the home page and the pre-join gate say 「你目前離線」. A meeting does
// not use this: its own reconnecting (e2-t08) handles a network that comes and goes.

function subscribe(listener: () => void) {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

const online = () => navigator.onLine !== false

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, online, () => true)
}

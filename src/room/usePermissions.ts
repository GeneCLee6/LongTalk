import { useEffect, useState } from 'react'

// What the browser says about the microphone and camera permissions (G1, e4-t09), through the
// Permissions API where there is one (canQueryPermissions in capabilities.ts). The pre-join screen
// uses it to tell a browser block from a system one, and to try again by itself once the person
// allows it in the site settings. Firefox before 131 and older Safari reject the `camera` and
// `microphone` names: then the state is `unknown` and nothing changes on its own.

export type PermissionValue = 'granted' | 'denied' | 'prompt' | 'unknown'

export interface MediaPermissions {
  mic: PermissionValue
  cam: PermissionValue
  /** Whether a change will be reported (so the screen can say it retries by itself) */
  watching: boolean
}

/** The part of navigator.permissions used here, so tests can pass a fake */
export interface PermissionsLike {
  query(descriptor: { name: string }): Promise<{
    state: string
    onchange: (() => void) | null
  }>
}

const asValue = (state: string): PermissionValue =>
  state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown'

function browserPermissions(): PermissionsLike | null {
  if (typeof navigator === 'undefined') return null
  const permissions = (navigator as { permissions?: unknown }).permissions
  return permissions && typeof (permissions as PermissionsLike).query === 'function'
    ? (permissions as PermissionsLike)
    : null
}

const UNKNOWN: MediaPermissions = { mic: 'unknown', cam: 'unknown', watching: false }

export function useMediaPermissions(
  permissions: PermissionsLike | null = browserPermissions(),
): MediaPermissions {
  const [state, setState] = useState<MediaPermissions>(UNKNOWN)
  const [source] = useState(() => permissions)
  useEffect(() => {
    if (!source) return
    let cancelled = false
    const watched: { onchange: (() => void) | null }[] = []
    for (const [kind, name] of [
      ['mic', 'microphone'],
      ['cam', 'camera'],
    ] as const) {
      source.query({ name }).then(
        (status) => {
          if (cancelled) return
          const update = () => {
            if (!cancelled)
              setState((s) => ({ ...s, [kind]: asValue(status.state), watching: true }))
          }
          status.onchange = update
          watched.push(status)
          update()
        },
        () => undefined,
      )
    }
    return () => {
      cancelled = true
      for (const status of watched) status.onchange = null
    }
  }, [source])
  return state
}

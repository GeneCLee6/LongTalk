import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { media } from '../styles/tokens.ts'

/**
 * The phone layout in use (e4-t07): held upright (paged gallery), sideways (speaker layout), or
 * none (desktop). The room page decides once from media queries and provides it; components read
 * it to switch to their phone forms (Menu opens as a bottom sheet). Outside the room: null.
 */
export type PhoneLayout = 'portrait' | 'landscape' | null

export const PhoneLayoutContext = createContext<PhoneLayout>(null)

export const usePhoneLayout = (): PhoneLayout => useContext(PhoneLayoutContext)

/**
 * Whether a tile is on screen (e4-t07): the paged gallery says no for tiles on pages out of
 * view, and the tile shows its initial instead of a <video> until it is back (the track is still
 * received: pausing the subscription itself is for layer selection, e2-t11 / e2-t12)
 */
export const TileVisibleContext = createContext(true)

const hasMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'

/** A media query's current answer, following changes (false where matchMedia is missing) */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener?.('change', onChange)
      return () => list.removeEventListener?.('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => hasMatchMedia() && window.matchMedia(query).matches,
    () => false,
  )
}

/** The phone layout this screen calls for, from the same queries the CSS uses */
export function usePhoneLayoutQuery(): PhoneLayout {
  const portrait = useMediaQuery(media.phonePortrait)
  const landscape = useMediaQuery(media.phoneLandscape)
  return portrait ? 'portrait' : landscape ? 'landscape' : null
}

/** prefers-reduced-motion: scroll and slide without animating (DESIGN.md §6) */
export const useReducedMotion = (): boolean => useMediaQuery(media.reducedMotion)

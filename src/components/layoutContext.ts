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
 * view, and the tile shows its initial instead of a <video> until it is back (its camera is
 * unsubscribed after a while: TileSeat, media/subscriptions.ts, L1)
 */
export const TileVisibleContext = createContext(true)

/**
 * How a tile's seat knows it is in sight (L1, TileSeat): `observe` by an IntersectionObserver
 * (everywhere but a pager); inside a pager the pager says so, at once when a page is turned:
 * `shown`, `near` (the pointer is on the button to its page: worth subscribing ahead), `away`
 */
export type TileSight = 'observe' | 'shown' | 'near' | 'away'

export const TileSightContext = createContext<TileSight>('observe')

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

/**
 * Motion turned off by the app rather than the system: 省電模式 (e6-t05) provides true in the
 * room, and every reduced-motion path follows it (GlobalStyle's `html[data-motion='off']` for
 * the CSS)
 */
export const MotionOffContext = createContext(false)

/** prefers-reduced-motion, or 省電模式: scroll and slide without animating (DESIGN.md §6) */
export const useReducedMotion = (): boolean => {
  const system = useMediaQuery(media.reducedMotion)
  const app = useContext(MotionOffContext)
  return system || app
}

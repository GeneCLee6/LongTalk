import { createContext, useContext, useEffect, type RefObject } from 'react'
import { devicePixels } from '../media/layers.ts'
import type { VideoDemandStore } from '../room/videoDemand.ts'

/**
 * Where received videos report how big they are drawn (e2-t12): the room page provides its
 * RoomMedia's store; elsewhere (the pre-join preview, tests) there is none and nothing reports
 */
export const VideoDemandContext = createContext<VideoDemandStore | null>(null)

/**
 * Reports a <video>'s drawn size (device pixels) and whether it is on screen, for the layer
 * choice of the track it shows: a ResizeObserver for the size (a new layout, a resized window),
 * an IntersectionObserver for visibility (a strip scrolled past, a page swiped away: clipped by
 * the scroller like anything else) and the picture's aspect once frames arrive. Stops reporting
 * when the track goes or the element unmounts. Our own camera is never received: no report.
 */
export function useVideoDemand(
  ref: RefObject<HTMLVideoElement | null>,
  track: MediaStreamTrack | null,
): void {
  const store = useContext(VideoDemandContext)
  useEffect(() => {
    const element = ref.current
    if (!store || !element || !track) return
    // One token per mounted <video>: the same track may be drawn in two places
    const view = {}
    let width = element.clientWidth
    let height = element.clientHeight
    let visible = true
    const report = () => {
      const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
      const aspect =
        element.videoWidth > 0 && element.videoHeight > 0
          ? element.videoWidth / element.videoHeight
          : null
      store.report(track, view, {
        width: devicePixels(width, ratio),
        height: devicePixels(height, ratio),
        visible,
        aspect,
      })
    }
    report()
    const observers: { disconnect: () => void }[] = []
    if (typeof ResizeObserver !== 'undefined') {
      const resize = new ResizeObserver(([entry]) => {
        width = Math.round(entry.contentRect.width)
        height = Math.round(entry.contentRect.height)
        report()
      })
      resize.observe(element)
      observers.push(resize)
    }
    if (typeof IntersectionObserver !== 'undefined') {
      const intersection = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting
        report()
      })
      intersection.observe(element)
      observers.push(intersection)
    }
    // The picture's shape (a phone held upright sends a tall one), and again when it changes
    element.addEventListener('resize', report)
    return () => {
      for (const observer of observers) observer.disconnect()
      element.removeEventListener('resize', report)
      store.report(track, view, null)
    }
  }, [store, ref, track])
}

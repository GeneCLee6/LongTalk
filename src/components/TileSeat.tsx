import { useContext, useEffect, useRef, type ReactNode } from 'react'
import styled from 'styled-components'
import { devicePixels } from '../media/layers.ts'
import { TileSightContext } from './layoutContext.ts'
import { VideoDemandContext } from './useVideoDemand.ts'

/**
 * Says where a tile would draw a member's camera (L1, e2-t18): reported even while the camera is
 * not subscribed, which is what brings it back when the tile comes into view (RoomMedia,
 * media/subscriptions.ts). A pager says itself which pages are in view (TileSightContext); anywhere
 * else (the gallery, a strip, the big tile) an IntersectionObserver does: scrolled out of a strip
 * is clipped like anything else.
 */
export function TileSeat({
  camera,
  children,
}: {
  /** The camera's trackKey; null: it has none, nothing to report */
  camera: string | null
  children: ReactNode
}) {
  const store = useContext(VideoDemandContext)
  const sight = useContext(TileSightContext)
  const ref = useRef<HTMLDivElement>(null)
  const sightNow = useRef(sight)
  const reportNow = useRef<(() => void) | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!store || !element || camera === null) return
    const view = {}
    let width = element.clientWidth
    let height = element.clientHeight
    let intersecting = true
    const report = () => {
      const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
      const pager = sightNow.current
      store.reportSeat(camera, view, {
        width: devicePixels(width, ratio),
        height: devicePixels(height, ratio),
        visible: pager === 'observe' ? intersecting : pager === 'shown',
        near: pager === 'near',
      })
    }
    reportNow.current = report
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
        intersecting = entry.isIntersecting
        report()
      })
      intersection.observe(element)
      observers.push(intersection)
    }
    return () => {
      for (const observer of observers) observer.disconnect()
      reportNow.current = null
      store.reportSeat(camera, view, null)
    }
  }, [store, camera])
  useEffect(() => {
    sightNow.current = sight
    reportNow.current?.()
  }, [sight])
  return <Box ref={ref}>{children}</Box>
}

const Box = styled.div`
  width: 100%;
  height: 100%;
`

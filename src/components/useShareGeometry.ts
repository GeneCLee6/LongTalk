import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react'
import {
  FIT_VIEW,
  clampView,
  contentRect,
  contentToTile,
  panBy as panView,
  tileToContent,
  zoomAt,
  type Point,
  type Rect,
  type ShareView,
  type Size,
} from '../../shared/shareGeometry.ts'

/**
 * Where a share's picture is on screen (e3-t11), for whatever lines up with it: the annotation
 * canvas now, the toolbar and laser in J2, remote control's pointer in E9. All sizes are CSS px
 * from the tile's top-left corner unless they say otherwise.
 */
export interface ShareGeometry {
  /** The tile (the <video>'s box before zooming) */
  box: Size
  /** The picture's own size; null until frames arrive */
  source: Size | null
  view: ShareView
  /** The picture on screen, under letterboxing, zoom and pan; null until frames arrive */
  rect: Rect | null
  pixelRatio: number
  /** Screen coordinates (`clientX`, `clientY`) to content 0–1; outside 0–1 when off the picture */
  clientToContent: (clientX: number, clientY: number) => Point | null
  /** Content 0–1 to screen coordinates */
  contentToClient: (point: Point) => Point | null
}

const NOTHING: ShareGeometry = {
  box: { width: 0, height: 0 },
  source: null,
  view: FIT_VIEW,
  rect: null,
  pixelRatio: 1,
  clientToContent: () => null,
  contentToClient: () => null,
}

export const ShareGeometryContext = createContext<ShareGeometry>(NOTHING)

/** The share tile around this component: where its picture is, right now */
export const useShareGeometry = (): ShareGeometry => useContext(ShareGeometryContext)

const currentRatio = () =>
  typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1

/** devicePixelRatio, following a move to another screen or a browser zoom */
function usePixelRatio(): number {
  const [ratio, setRatio] = useState(currentRatio)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(`(resolution: ${ratio}dppx)`)
    const onChange = () => setRatio(currentRatio())
    list.addEventListener?.('change', onChange)
    return () => list.removeEventListener?.('change', onChange)
  }, [ratio])
  return ratio
}

export interface ShareViewport {
  geometry: ShareGeometry
  /** Sets the zoom, keeping the content under `anchor` (tile px; default the centre) in place */
  zoomTo: (zoom: number | ((zoom: number) => number), anchor?: Point) => void
  /** Moves the picture by this many tile px */
  panBy: (dx: number, dy: number) => void
  reset: () => void
}

/**
 * The owner of one share's geometry (ShareTile): measures the tile and the picture, and holds the
 * view. `active` is false for a strip share, which is not zoomed and needs no measuring.
 */
export function useShareViewport(
  frameRef: RefObject<HTMLElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
  active: boolean,
): ShareViewport {
  const [box, setBox] = useState<Size>(NOTHING.box)
  const [source, setSource] = useState<Size | null>(null)
  const [wanted, setWanted] = useState<ShareView>(FIT_VIEW)
  const pixelRatio = usePixelRatio()

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!active || !frame) return
    const measure = () => {
      const { width, height } = frame.getBoundingClientRect()
      setBox((now) => (now.width === width && now.height === height ? now : { width, height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [active, frameRef])

  useEffect(() => {
    const video = videoRef.current
    if (!active || !video) return
    const read = () => {
      const { videoWidth: width, videoHeight: height } = video
      setSource((now) => {
        if (width <= 0 || height <= 0) return null
        return now?.width === width && now.height === height ? now : { width, height }
      })
    }
    read()
    video.addEventListener('loadedmetadata', read)
    video.addEventListener('resize', read)
    return () => {
      video.removeEventListener('loadedmetadata', read)
      video.removeEventListener('resize', read)
    }
  }, [active, videoRef])

  // What is wanted stays as it was through a resize; what is shown is the nearest allowed now
  const view = useMemo(() => clampView(box, source, wanted), [box, source, wanted])
  const rect = useMemo(() => contentRect(box, source, view), [box, source, view])

  const geometry = useMemo<ShareGeometry>(() => {
    const origin = () => frameRef.current?.getBoundingClientRect() ?? null
    return {
      box,
      source,
      view,
      rect,
      pixelRatio,
      clientToContent: (clientX, clientY) => {
        const at = origin()
        return at && rect
          ? tileToContent(rect, { x: clientX - at.left, y: clientY - at.top })
          : null
      },
      contentToClient: (point) => {
        const at = origin()
        if (!at || !rect) return null
        const tile = contentToTile(rect, point)
        return { x: tile.x + at.left, y: tile.y + at.top }
      },
    }
  }, [box, source, view, rect, pixelRatio, frameRef])

  const zoomTo = useCallback<ShareViewport['zoomTo']>(
    (zoom, anchor) =>
      setWanted((now) => {
        const from = clampView(box, source, now)
        const next = typeof zoom === 'function' ? zoom(from.zoom) : zoom
        return zoomAt(box, source, from, next, anchor)
      }),
    [box, source],
  )
  const panBy = useCallback<ShareViewport['panBy']>(
    (dx, dy) => setWanted((now) => panView(box, source, now, dx, dy)),
    [box, source],
  )
  const reset = useCallback(() => setWanted(FIT_VIEW), [])

  return { geometry, zoomTo, panBy, reset }
}

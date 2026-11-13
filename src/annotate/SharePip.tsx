import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styled, { StyleSheetManager } from 'styled-components'
import { laserOpacity } from '../../shared/annotation.ts'
import { backingSize, containRect, type Rect, type Size } from '../../shared/shareGeometry.ts'
import { Button } from '../components/Button.tsx'
import { useReducedMotion } from '../components/layoutContext.ts'
import { Frame, Tag } from '../components/shareChrome.tsx'
import { useMarked } from '../components/useShareChrome.ts'
import { useTrack } from '../components/useTrack.ts'
import type { AnnotationStore } from '../room/annotationStore.ts'
import { strings } from '../strings.ts'
import { GlobalStyle } from '../styles/GlobalStyle.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { drawLaser, drawNameTag, drawStrokes } from './draw.ts'

export interface SharePipProps {
  /** The Document Picture-in-Picture window (src/room/useSharePip.ts) */
  pipWindow: Window
  /** Our own capture, never what the SFU sends back */
  track: MediaStreamTrack
  store: AnnotationStore
  /** Our share's layer: our member id */
  layer: string
  /** A member's name for the tag beside what they are drawing */
  nameOf: (memberId: string) => string | null
  /**
   * A whole screen (or the meeting itself) is shared: this window is in the share too, so its
   * picture would repeat inside itself (e3-t09). It starts with the marks only, as the own view does
   */
  mirrorRisk: boolean
}

/**
 * The sharer's floating window (Document Picture-in-Picture, Chrome and Edge): our share and the
 * marks on it, in a small window above every other app, so the sharer sees what is drawn while
 * working in what they share. Lazy-loaded once the window is open (CLAUDE.md rule 6).
 *
 * Rendered into the window's document through a portal, with styled-components writing into that
 * document's head and the colour variables (GlobalStyle) set there, dark as the room is. The
 * window has its own frames and size: it is measured and painted with its own ResizeObserver and
 * requestAnimationFrame, which keep going while the meeting's tab is hidden behind the shared app.
 * Only shows: drawing stays in the meeting.
 */
export default function SharePip({ pipWindow, ...view }: SharePipProps) {
  const doc = pipWindow.document
  const title = strings.screenShare.pipTitle
  useLayoutEffect(() => dressWindow(pipWindow, title), [pipWindow, title])
  return createPortal(
    <StyleSheetManager target={doc.head}>
      <GlobalStyle />
      <PipView pipWindow={pipWindow} {...view} />
    </StyleSheetManager>,
    doc.body,
  )
}

/** The window's document: the room's dark scheme, the page's language, its own title */
function dressWindow(pipWindow: Window, title: string): void {
  const root = pipWindow.document.documentElement
  root.dataset.theme = 'dark'
  root.lang = document.documentElement.lang
  pipWindow.document.title = title
}

/** The picture's own size, from the track until the video knows it */
function trackSize(track: MediaStreamTrack): Size | null {
  const { width, height } = track.getSettings?.() ?? {}
  return width && height ? { width, height } : null
}

function PipView({ pipWindow, track, store, layer, nameOf, mirrorRisk }: SharePipProps) {
  const videoRef = useTrack<HTMLVideoElement>(track)
  const frameRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState<Size>({ width: 0, height: 0 })
  const [source, setSource] = useState<Size | null>(() => trackSize(track))
  const [pictureOn, setPictureOn] = useState(!mirrorRisk)
  const marked = useMarked(store, layer)
  const reducedMotion = useReducedMotion()
  const ratio = pipWindow.devicePixelRatio > 0 ? pipWindow.devicePixelRatio : 1
  // The room page makes a new one on every render: read the latest without painting anew for it
  const nameRef = useRef(nameOf)
  useEffect(() => {
    nameRef.current = nameOf
  }, [nameOf])

  // The window's size, with the window's own observer (one from the meeting's page may not see it)
  useLayoutEffect(() => {
    const element = frameRef.current
    if (!element) return
    const measure = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      setBox((now) => (now.width === width && now.height === height ? now : { width, height }))
    }
    measure()
    const Observer = (pipWindow as typeof window).ResizeObserver
    if (typeof Observer !== 'function') {
      pipWindow.addEventListener('resize', measure)
      return () => pipWindow.removeEventListener('resize', measure)
    }
    const observer = new Observer(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [pipWindow])

  // The picture's shape, as the video learns it (a resized window or a new capture size)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const update = () => {
      const { videoWidth: width, videoHeight: height } = video
      if (width > 0 && height > 0) {
        setSource((now) =>
          now?.width === width && now.height === height ? now : { width, height },
        )
      }
    }
    video.addEventListener('loadedmetadata', update)
    video.addEventListener('resize', update)
    update()
    return () => {
      video.removeEventListener('loadedmetadata', update)
      video.removeEventListener('resize', update)
    }
  }, [videoRef])

  const rect: Rect | null = useMemo(() => containRect(box, source), [box, source])

  // The marks: everything again on each change, at most once a frame of this window. The window is
  // small, so there is no picture of finished strokes as on the main tile
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = backingSize(box, ratio)
    canvas.width = size.width
    canvas.height = size.height
    let frame: number | null = null
    const paint = () => {
      frame = null
      const ctx = canvas.getContext?.('2d')
      if (!ctx) return
      if (!rect) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        return
      }
      const strokes = store.strokes(layer)
      drawStrokes(ctx, strokes, rect, ratio, canvas)
      const active = store.active(layer)
      const lasers = store.lasers(layer)
      const now = Date.now()
      ctx.save()
      ctx.beginPath()
      ctx.rect(rect.x * ratio, rect.y * ratio, rect.width * ratio, rect.height * ratio)
      ctx.clip()
      for (const stroke of strokes) {
        if (!active.has(stroke.id) || stroke.by === layer) continue
        const name = nameRef.current(stroke.by)
        const tip = stroke.points[stroke.points.length - 1]
        if (name && tip) drawNameTag(ctx, name, tip, rect, ratio)
      }
      for (const laser of lasers) {
        const opacity = reducedMotion ? 1 : laserOpacity(laser.heardAt, now)
        drawLaser(ctx, laser.at, laser.color, opacity, rect, ratio)
        const name = laser.by === layer ? null : nameRef.current(laser.by)
        if (name) drawNameTag(ctx, name, laser.at, rect, ratio)
      }
      ctx.restore()
      // Something is fading or going quiet: the next frame looks again
      if (lasers.length > 0 || active.size > 0) schedule()
    }
    const schedule = () => {
      if (frame !== null) return
      frame = pipWindow.requestAnimationFrame(paint)
    }
    paint()
    const stop = store.subscribe(layer, schedule)
    return () => {
      stop()
      if (frame !== null) pipWindow.cancelAnimationFrame(frame)
    }
  }, [pipWindow, store, layer, box, rect, ratio, reducedMotion])

  const text = strings.screenShare
  return (
    <Window
      ref={frameRef}
      aria-label={text.ownRegion}
      data-share-pip=""
      $grab={false}
      $interactive={false}
    >
      <Video
        ref={videoRef}
        aria-label={text.ownRegion}
        autoPlay
        muted
        playsInline
        $hidden={!pictureOn}
      />
      <Marks ref={canvasRef} role="img" aria-label={text.annotationCanvas} />
      <Tag>{text.ownLabel}</Tag>
      {!marked && <Empty>{text.pipEmpty}</Empty>}
      {mirrorRisk && (
        <Note>
          {!pictureOn && <p>{text.ownHidden}</p>}
          <Button variant="secondary" onClick={() => setPictureOn((on) => !on)}>
            {pictureOn ? text.ownHidePicture : text.ownShowPicture}
          </Button>
        </Note>
      )}
    </Window>
  )
}

/** The whole window, no rounded corners: the window is the tile */
const Window = styled(Frame)`
  position: fixed;
  inset: 0;
  border-radius: 0;
`

const Video = styled.video<{ $hidden: boolean }>`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  /* Still playing, so the window knows the picture's shape: only never painted (no mirror) */
  ${({ $hidden }) => ($hidden ? 'visibility: hidden;' : '')}
`

const Marks = styled.canvas`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
`

const Empty = styled.p`
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  max-width: calc(100% - ${space(6)});
  margin: 0;
  padding: ${space(1)} ${space(2.5)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  color: ${color.fg};
  font-size: ${fontSize.nameplate};
  text-align: center;
  pointer-events: none;
`

const Note = styled.div`
  position: absolute;
  left: ${space(2)};
  bottom: ${space(2)};
  display: grid;
  justify-items: start;
  gap: ${space(1)};
  max-width: min(70%, 320px);
  padding: ${space(1.5)} ${space(2.5)};
  border-radius: ${radius.button};
  background: ${color.overlay};
  color: ${color.fg};
  font-size: ${fontSize.nameplate};
  line-height: 1.4;

  p {
    margin: 0;
  }
`

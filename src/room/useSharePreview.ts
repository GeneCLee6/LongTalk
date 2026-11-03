import { useEffect, useEffectEvent, useState } from 'react'
import { selfCapture, type CapturedSurface, type SelfCapture } from '../media/share.ts'
import { MotionMeter } from '../media/shareMode.ts'
import { canSampleShare, ShareSampler } from './shareSampler.ts'

export interface SharePreview {
  /** The latest small frame of what we share; null before the first (or where none can be taken) */
  canvas: HTMLCanvasElement | null
  /** Counts the frames, so a thumbnail knows to draw again */
  frame: number
}

const NO_PREVIEW: SharePreview = { canvas: null, frame: 0 }

/**
 * Our own shared screen, sampled once a second while `track` is shared (e3-t06, e3-t08): the
 * presenter view's thumbnail, and `onMotion` with whether it keeps moving (media/shareMode.ts
 * MotionMeter), on every change
 */
export function useSharePreview(
  track: MediaStreamTrack | null,
  onMotion: (moving: boolean) => void,
): SharePreview {
  const [preview, setPreview] = useState<SharePreview>(NO_PREVIEW)
  const motion = useEffectEvent((moving: boolean) => onMotion(moving))
  useEffect(() => {
    if (!track || !canSampleShare()) return
    const meter = new MotionMeter()
    let moving = false
    const sampler = new ShareSampler(track, ({ canvas, change }) => {
      setPreview((current) => ({ canvas, frame: current.frame + 1 }))
      const now = meter.push(change)
      if (now !== moving) {
        moving = now
        motion(now)
      }
    })
    sampler.start()
    return () => {
      sampler.stop()
      setPreview(NO_PREVIEW)
      if (moving) motion(false)
    }
  }, [track])
  return preview
}

/** How long this page must stay in front, sharing a whole screen, before it counts (e3-t09) */
export const IN_FRONT_MS = 3_000

const pageInFront = () =>
  typeof document !== 'undefined' &&
  document.visibilityState === 'visible' &&
  (typeof document.hasFocus !== 'function' || document.hasFocus())

/**
 * Whether what we share shows the meeting itself (e3-t09, media/share.ts selfCapture): at once
 * for a meeting tab or window; for a whole screen, once this page has been in front (visible and
 * focused) for IN_FRONT_MS, and no longer once it is not
 */
export function useSelfCapture(surface: CapturedSurface | null): SelfCapture | null {
  const watching = surface?.surface === 'monitor'
  const [inFront, setInFront] = useState(false)
  useEffect(() => {
    if (!watching) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (!pageInFront()) {
        setInFront(false)
        return
      }
      timer = setTimeout(() => setInFront(pageInFront()), IN_FRONT_MS)
    }
    check()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('blur', check)
    return () => {
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('blur', check)
      setInFront(false)
    }
  }, [watching])
  if (!surface) return null
  const title = typeof document === 'undefined' ? '' : document.title
  return selfCapture(surface, { pageTitle: title, inFront: watching && inFront })
}

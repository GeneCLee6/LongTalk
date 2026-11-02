import { useEffect, useRef } from 'react'

/** Puts one track into a media element, or clears it (jsdom has no MediaStream) */
export function useTrack<T extends HTMLMediaElement>(track: MediaStreamTrack | null) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const element = ref.current
    if (!element || !track || typeof MediaStream === 'undefined') return
    element.srcObject = new MediaStream([track])
    void element.play?.()?.catch(() => undefined)
    return () => {
      element.srcObject = null
    }
  }, [track])
  return ref
}

import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import type { AnnotationStore } from '../room/annotationStore.ts'

/** This element in the browser's fullscreen, and the way in and out */
export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false)
  useEffect(() => {
    const onChange = () => setActive(!!ref.current && document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [ref])
  const toggle = () => {
    if (document.fullscreenElement === ref.current) void document.exitFullscreen?.()
    else void ref.current?.requestFullscreen?.()?.catch(() => undefined)
  }
  return { active, toggle }
}

const noMarks = () => () => undefined
const never = () => false

/** Whether a layer has anything to show (the store, not React state: see AnnotationStore) */
export function useMarked(store: AnnotationStore | undefined, layer: string | undefined): boolean {
  return useSyncExternalStore(
    store && layer ? (listener) => store.subscribe(layer, listener) : noMarks,
    store && layer ? () => store.marked(layer) : never,
  )
}

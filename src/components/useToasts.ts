import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from '../styles/tokens.ts'

export type ToastTone = 'neutral' | 'warn' | 'danger'

export interface ToastMessage {
  id: number
  text: string
  tone: ToastTone
}

/** Toast queue: show() adds one, each closes itself after 4 seconds (DESIGN.md §5) */
export function useToasts(durationMs: number = motion.toastMs) {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback(
    (text: string, tone: ToastTone = 'neutral') => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, text, tone }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationMs),
      )
      return id
    },
    [dismiss, durationMs],
  )

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => clearTimeout(timer))
  }, [])

  return { toasts, show, dismiss }
}

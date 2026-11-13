import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from '../styles/tokens.ts'

export type ToastTone = 'neutral' | 'warn' | 'danger'

/** A button on a toast: pressing it does this and closes the toast */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastMessage {
  id: number
  text: string
  tone: ToastTone
  actions?: readonly ToastAction[]
}

export interface ToastOptions {
  /** Buttons after the text; a toast with any stays twice as long, to leave time to reach them */
  actions?: readonly ToastAction[]
}

/**
 * Toast queue: show() adds one, each closes itself after 4 seconds (DESIGN.md §5), or 8 with
 * buttons
 */
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
    (text: string, tone: ToastTone = 'neutral', options: ToastOptions = {}) => {
      const id = nextId.current++
      const actions = options.actions?.length ? options.actions : undefined
      setToasts((current) => [...current, { id, text, tone, ...(actions ? { actions } : {}) }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), actions ? durationMs * 2 : durationMs),
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

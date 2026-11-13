import { useCallback, useEffect, useState } from 'react'
import { canDocumentPip } from '../media/capabilities.ts'

/** The floating window's first size, CSS px: a 16:9 picture with room for its tag */
export const PIP_SIZE = { width: 480, height: 300 } as const

interface DocumentPip {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}

export interface SharePip {
  /** This browser has Document Picture-in-Picture (capabilities.ts `documentPip`) */
  supported: boolean
  /** The floating window while it is open */
  window: Window | null
  /** Opens it; only works from a press (the browser asks for a user gesture), never by itself */
  open: () => void
  close: () => void
}

/**
 * The sharer's floating window (Document Picture-in-Picture, Chrome and Edge): a window above every
 * other app, so the marks on our share can be watched while working in what we share. This holds
 * only the window; what is in it is src/annotate/SharePip.tsx, loaded once it opens. It closes
 * when the share stops (`sharing` false), when the room page goes (leaving the room), and when the
 * person closes it themselves.
 */
export function useSharePip(sharing: boolean): SharePip {
  const [supported] = useState(() => canDocumentPip())
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  // Adjusted while rendering (React's pattern for state that follows a value); the effect below
  // closes the window that was let go
  if (!sharing && pipWindow !== null) setPipWindow(null)

  const open = useCallback(() => {
    if (!supported || !sharing) return
    const api = (window as unknown as { documentPictureInPicture: DocumentPip })
      .documentPictureInPicture
    api.requestWindow(PIP_SIZE).then(
      (next) => {
        next.addEventListener('pagehide', () =>
          setPipWindow((current) => (current === next ? null : current)),
        )
        setPipWindow(next)
      },
      // Refused (no user gesture, or the page is not in front): the toast and own view remain
      () => undefined,
    )
  }, [supported, sharing])

  const close = useCallback(() => setPipWindow(null), [])

  useEffect(() => {
    if (!pipWindow) return
    return () => pipWindow.close()
  }, [pipWindow])

  return { supported, window: pipWindow, open, close }
}

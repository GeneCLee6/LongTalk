import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import styled from 'styled-components'

/**
 * A polite live region that is always in the page (G5, e4-t14), for changes a screen reader
 * would otherwise miss: a region added together with its text is often not read at all, and a
 * shortcut changes a button nobody is on. `announce` says one short sentence; the same sentence
 * twice in a row is said twice (the text is cleared first). Never for speaking changes: they come
 * every few seconds.
 */
export function useAnnouncer(): { region: ReactNode; announce: (text: string) => void } {
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const announce = useCallback((next: string) => {
    clearTimeout(timer.current)
    setText('')
    timer.current = setTimeout(() => setText(next), 50)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  const region = (
    <Hidden role="status" aria-live="polite" aria-atomic="true">
      {text}
    </Hidden>
  )
  return { region, announce }
}

const Hidden = styled.div`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

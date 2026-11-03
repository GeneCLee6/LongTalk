import { useCallback, useEffect, useRef, useState } from 'react'
import { playTestTone, type ToneDeps, type TonePlayback } from '../media/testTone.ts'

export interface SpeakerTest {
  playing: boolean
  /** Plays the chime, or stops it while it plays */
  toggle: () => void
}

/**
 * The pre-join speaker test (G1, e4-t09): the chime through `speakerId`; stopped when the speaker
 * changes or the screen goes away
 */
export function useSpeakerTest(speakerId: string | null, deps?: ToneDeps): SpeakerTest {
  const [playing, setPlaying] = useState(false)
  const current = useRef<TonePlayback | null>(null)
  const latestDeps = useRef(deps)

  const stop = useCallback(() => {
    current.current?.stop()
    current.current = null
    setPlaying(false)
  }, [])

  useEffect(() => stop, [speakerId, stop])

  const toggle = useCallback(() => {
    if (current.current) {
      stop()
      return
    }
    const playback = playTestTone(speakerId, latestDeps.current)
    current.current = playback
    setPlaying(true)
    void playback.done.then(() => {
      if (current.current !== playback) return
      current.current = null
      setPlaying(false)
    })
  }, [speakerId, stop])

  return { playing, toggle }
}

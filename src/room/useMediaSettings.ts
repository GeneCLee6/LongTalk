import { useState } from 'react'
import { useMediaQuery } from '../components/layoutContext.ts'
import type { AudioProcessing } from '../media/audioProcessing.ts'
import { media } from '../styles/tokens.ts'
import { defaultHd, loadMediaPrefs, saveMediaPrefs, type MediaPrefs } from './session.ts'

export interface MediaSettings {
  processing: AudioProcessing
  /** HD as chosen, or the device's default when never chosen (session.ts defaultHd) */
  hd: boolean
  setProcessing: (processing: AudioProcessing) => void
  setHd: (on: boolean) => void
}

/**
 * The settings panel's remembered media choices (H3: e6-t01, e6-t04), for the pre-join screen and
 * the room: both read and write the same localStorage entry, so a switch changed before joining
 * is what the room opens the microphone with.
 */
export function useMediaSettings(): MediaSettings {
  const [prefs, setPrefs] = useState<MediaPrefs>(loadMediaPrefs)
  const touchPrimary = useMediaQuery(media.touchPrimary)
  const update = (changes: Partial<MediaPrefs>) => {
    const next = { ...prefs, ...changes }
    saveMediaPrefs(next)
    setPrefs(next)
  }
  return {
    processing: prefs.processing,
    hd: prefs.hd ?? defaultHd(touchPrimary),
    setProcessing: (processing) => update({ processing }),
    setHd: (hd) => update({ hd }),
  }
}

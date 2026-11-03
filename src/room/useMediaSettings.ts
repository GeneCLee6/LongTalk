import { useState } from 'react'
import { useMediaQuery } from '../components/layoutContext.ts'
import type { AudioProcessing } from '../media/audioProcessing.ts'
import { media } from '../styles/tokens.ts'
import { defaultHd, loadMediaPrefs, saveMediaPrefs, type MediaPrefs } from './session.ts'

export interface MediaSettings {
  processing: AudioProcessing
  /** HD as chosen, or the device's default when never chosen (session.ts defaultHd) */
  hd: boolean
  /** 進階噪音抑制 as chosen (e6-t02); RoomPage decides whether it runs */
  advancedNoise: boolean
  /** 省電模式 (e6-t05) */
  powerSaving: boolean
  setProcessing: (processing: AudioProcessing) => void
  setHd: (on: boolean) => void
  setAdvancedNoise: (on: boolean) => void
  setPowerSaving: (on: boolean) => void
}

/**
 * The settings panel's remembered media choices (H3: e6-t01, e6-t04; H4: e6-t02, e6-t05), for the pre-join screen and
 * the room: both read and write the same localStorage entry, so a switch changed before joining
 * is what the room opens the microphone with.
 */
export function useMediaSettings(): MediaSettings {
  const [prefs, setPrefs] = useState<MediaPrefs>(loadMediaPrefs)
  const touchPrimary = useMediaQuery(media.touchPrimary)
  // From the latest prefs: two changes in one go (a switch and an automatic turn-off) both stay
  const update = (changes: Partial<MediaPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...changes }
      saveMediaPrefs(next)
      return next
    })
  }
  return {
    processing: prefs.processing,
    hd: prefs.hd ?? defaultHd(touchPrimary),
    advancedNoise: prefs.advancedNoise,
    powerSaving: prefs.powerSaving,
    setProcessing: (processing) => update({ processing }),
    setHd: (hd) => update({ hd }),
    setAdvancedNoise: (advancedNoise) => update({ advancedNoise }),
    setPowerSaving: (powerSaving) => update({ powerSaving }),
  }
}

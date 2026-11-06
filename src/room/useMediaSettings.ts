import { useState } from 'react'
import { useMediaQuery } from '../components/layoutContext.ts'
import type { AudioProcessing } from '../media/audioProcessing.ts'
import { canBlurBackground } from '../media/capabilities.ts'
import { media } from '../styles/tokens.ts'
import type { SelfViewAt } from './selfView.ts'
import { defaultHd, loadMediaPrefs, saveMediaPrefs, type MediaPrefs } from './session.ts'

export interface MediaSettings {
  processing: AudioProcessing
  /** HD as chosen, or the device's default when never chosen (session.ts defaultHd) */
  hd: boolean
  /** 進階噪音抑制 as chosen (e6-t02); RoomPage decides whether it runs */
  advancedNoise: boolean
  /** 省電模式 (e6-t05) */
  powerSaving: boolean
  /** 背景模糊 can be offered here (e6-t06): the browser can run it, and it is not a phone or tablet */
  blurSupported: boolean
  /** 背景模糊 as chosen (e6-t06); RoomPage decides whether it runs */
  blur: boolean
  /** Our own picture mirrored for us (e6-t07) */
  mirror: boolean
  /** Our own tile floats over the stage (e6-t07), and where it was left */
  selfView: boolean
  selfViewAt: SelfViewAt
  setProcessing: (processing: AudioProcessing) => void
  setHd: (on: boolean) => void
  setAdvancedNoise: (on: boolean) => void
  setPowerSaving: (on: boolean) => void
  setBlur: (on: boolean) => void
  setMirror: (on: boolean) => void
  setSelfView: (on: boolean) => void
  setSelfViewAt: (at: SelfViewAt) => void
}

/**
 * The settings panel's remembered media choices (H3: e6-t01, e6-t04; H4: e6-t02, e6-t05), for the pre-join screen and
 * the room: both read and write the same localStorage entry, so a switch changed before joining
 * is what the room opens the microphone with.
 */
export function useMediaSettings(): MediaSettings {
  const [prefs, setPrefs] = useState<MediaPrefs>(loadMediaPrefs)
  const touchPrimary = useMediaQuery(media.touchPrimary)
  const [blurPossible] = useState(canBlurBackground)
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
    blurSupported: blurPossible && !touchPrimary,
    blur: prefs.blur,
    mirror: prefs.mirror,
    selfView: prefs.selfView,
    selfViewAt: prefs.selfViewAt,
    setProcessing: (processing) => update({ processing }),
    setHd: (hd) => update({ hd }),
    setAdvancedNoise: (advancedNoise) => update({ advancedNoise }),
    setPowerSaving: (powerSaving) => update({ powerSaving }),
    setBlur: (blur) => update({ blur }),
    setMirror: (mirror) => update({ mirror }),
    setSelfView: (selfView) => update({ selfView }),
    setSelfViewAt: (selfViewAt) => update({ selfViewAt }),
  }
}

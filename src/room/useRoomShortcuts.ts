import { useEffect, useEffectEvent, useState } from 'react'
import {
  PushToTalk,
  endsPushToTalk,
  modalOpen,
  shortcutFor,
  startsPushToTalk,
  type ShortcutAction,
} from './shortcuts.ts'

export interface RoomShortcutsOptions {
  /** In the room (not the waiting room, not reconnecting from scratch): shortcuts on */
  enabled: boolean
  micOn: boolean
  micBusy: boolean
  /** Turns the microphone on or off (push-to-talk) */
  setMic: (on: boolean) => void
  /** What a shortcut does; return false when it did nothing (the key is left to the page) */
  onAction: (action: ShortcutAction) => boolean | void
}

/**
 * The room's keyboard (G4, e4-t13): the shortcuts in shortcuts.ts, on the window, after the page
 * had its turn (a menu's or a dialog's own keys mark the event handled first). Push-to-talk
 * holds the microphone on while Space is down; letting go, the tab hiding or the window losing
 * focus mutes it again. Says whether push-to-talk is on, for the 「按住說話中」 pill.
 */
export function useRoomShortcuts({
  enabled,
  micOn,
  micBusy,
  setMic,
  onAction,
}: RoomShortcutsOptions): boolean {
  const [talking, setTalking] = useState(false)
  const [ptt] = useState(() => new PushToTalk())
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const modal = modalOpen()
    if (ptt.active && endsPushToTalk(event)) {
      // Held: the key repeats; keep the browser from scrolling or pressing anything
      event.preventDefault()
      return
    }
    if (startsPushToTalk(event, { modal })) {
      if (!ptt.active && ptt.press(micOn, micBusy)) {
        event.preventDefault()
        setMic(true)
        setTalking(true)
      }
      return
    }
    const action = shortcutFor(event, { modal })
    if (action && onAction(action) !== false) event.preventDefault()
  })
  const onKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (!endsPushToTalk(event) || !ptt.active) return
    event.preventDefault()
    ptt.release()
    setMic(false)
    setTalking(false)
  })
  const stop = useEffectEvent(() => {
    if (!ptt.release()) return
    setMic(false)
    setTalking(false)
  })

  useEffect(() => {
    if (!enabled) return
    const down = (event: KeyboardEvent) => onKeyDown(event)
    const up = (event: KeyboardEvent) => onKeyUp(event)
    const blur = () => stop()
    const hidden = () => {
      if (document.visibilityState === 'hidden') stop()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hidden)
      stop()
    }
  }, [enabled])

  return talking
}

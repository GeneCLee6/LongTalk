import { useEffect, useRef } from 'react'
import { batteryManager, type BatteryLike } from '../media/capabilities.ts'

// The low-battery hint (e6-t05): where the browser tells the battery level (the Battery Status
// API, Chromium only), a battery at or under LOW_BATTERY and not charging suggests 省電模式 once a
// meeting. It never turns the mode on by itself: the person may be about to plug in, or may
// care more about the picture. Elsewhere nothing happens.

export const LOW_BATTERY = 0.2

export const batteryLow = (battery: Pick<BatteryLike, 'level' | 'charging'>): boolean =>
  !battery.charging && battery.level <= LOW_BATTERY

export function useBatteryHint(
  /** False while 省電模式 is on (nothing to suggest) */
  enabled: boolean,
  suggest: () => void,
  getBattery: () => Promise<BatteryLike> | null = batteryManager,
): void {
  const latest = useRef({ enabled, suggest })
  useEffect(() => {
    latest.current = { enabled, suggest }
  })
  const said = useRef(false)
  useEffect(() => {
    const pending = getBattery()
    if (!pending) return
    let battery: BatteryLike | null = null
    let closed = false
    const check = () => {
      if (closed || !battery || said.current || !latest.current.enabled) return
      if (!batteryLow(battery)) return
      said.current = true
      latest.current.suggest()
    }
    pending.then(
      (found) => {
        if (closed) return
        battery = found
        battery.addEventListener('levelchange', check)
        battery.addEventListener('chargingchange', check)
        check()
      },
      () => {},
    )
    return () => {
      closed = true
      battery?.removeEventListener('levelchange', check)
      battery?.removeEventListener('chargingchange', check)
    }
  }, [getBattery])
}

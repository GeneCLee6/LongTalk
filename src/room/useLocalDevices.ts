import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LocalDevices, type DeviceNotice, type LocalDevicesState } from './LocalDevices.ts'
import { useMediaDevices } from './devicesContext.ts'
import { saveDevice, type DeviceChoices } from './session.ts'

export interface UseLocalDevices {
  state: LocalDevicesState
  /** The running controller; null until mounted */
  devices: LocalDevices | null
}

const idleState = (chosen: DeviceChoices): LocalDevicesState => ({
  ready: false,
  mic: { on: false, track: null, problem: null, opening: false },
  cam: { on: false, track: null, problem: null, opening: false },
  devices: { audioinput: [], videoinput: [], audiooutput: [] },
  chosen,
})

const noSubscribe = () => () => {}

/**
 * The room's microphone and camera (e2-t05, e2-t06): opens what the pre-join screen had on,
 * then follows the toolbar. One LocalDevices per mount, closed (every track stopped) on
 * unmount, so StrictMode leaves exactly one camera open.
 */
export function useLocalDevices(
  wanted: { mic: boolean; cam: boolean },
  chosen: DeviceChoices,
  onNotice: (notice: DeviceNotice) => void,
): UseLocalDevices {
  const mediaDevices = useMediaDevices()
  const [devices, setDevices] = useState<LocalDevices | null>(null)
  const latest = useRef({ wanted, chosen, onNotice })
  useEffect(() => {
    latest.current = { wanted, chosen, onNotice }
  })
  const [idle] = useState(() => idleState(chosen))

  useEffect(() => {
    const { wanted: start, chosen: startChosen } = latest.current
    const run = new LocalDevices({
      mediaDevices,
      chosen: startChosen,
      saveChoice: saveDevice,
      onNotice: (notice) => latest.current.onNotice(notice),
    })
    setDevices(run)
    void run.start(start)
    return () => {
      run.close()
      setDevices((current) => (current === run ? null : current))
    }
  }, [mediaDevices])

  const state = useSyncExternalStore(
    devices?.subscribe ?? noSubscribe,
    devices?.getState ?? (() => idle),
  )
  return { state, devices }
}

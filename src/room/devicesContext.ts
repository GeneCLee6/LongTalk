import { createContext, useContext, useState } from 'react'
import { browserMediaDevices, type MediaDevicesLike } from '../media/devices.ts'

/**
 * Where the pre-join screen and the room get the microphone and camera: navigator.mediaDevices
 * in the app (undefined here), a fake in tests. null means the browser has none (http:, old).
 */
export const MediaDevicesContext = createContext<MediaDevicesLike | null | undefined>(undefined)

/** The context's devices, or the browser's; fixed for the component's lifetime */
export function useMediaDevices(): MediaDevicesLike | null {
  const provided = useContext(MediaDevicesContext)
  const [devices] = useState(() => (provided === undefined ? browserMediaDevices() : provided))
  return devices
}

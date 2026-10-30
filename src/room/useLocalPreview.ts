import { useCallback, useEffect, useState } from 'react'
import {
  browserMediaDevices,
  emptyDeviceLists,
  listDevices,
  openLocalMedia,
  stopStream,
  type CreateStream,
  type DeviceLists,
  type LocalMedia,
  type LocalMediaRequest,
  type MediaDevicesLike,
  type MediaProblem,
} from '../media/devices.ts'

export interface LocalPreview {
  stream: MediaStream | null
  micProblem: MediaProblem | null
  camProblem: MediaProblem | null
  devices: DeviceLists
  /** True while the devices are being opened */
  opening: boolean
  /** Asks again (after the person allowed access, or freed the camera) */
  retry: () => void
}

export interface LocalPreviewDeps {
  mediaDevices?: MediaDevicesLike | null
  createStream?: CreateStream
}

/**
 * The pre-join preview (e4-t03): opens the microphone and camera asked for, reopens them when
 * the choice changes, keeps the device lists fresh (labels appear once there is permission; a
 * device plugged in or out fires `devicechange`) and stops every track on unmount.
 */
export function useLocalPreview(
  request: LocalMediaRequest,
  deps: LocalPreviewDeps = {},
): LocalPreview {
  const [mediaDevices] = useState(() =>
    deps.mediaDevices === undefined ? browserMediaDevices() : deps.mediaDevices,
  )
  const [createStream] = useState(() => deps.createStream)
  const [attempt, setAttempt] = useState(0)
  // The result of the last request that finished, tagged with that request
  const [opened, setOpened] = useState<{ key: string; media: LocalMedia } | null>(null)
  const [devices, setDevices] = useState<DeviceLists>(emptyDeviceLists)

  const refreshDevices = useCallback(async () => {
    if (!mediaDevices) return
    try {
      setDevices(await listDevices(mediaDevices))
    } catch {
      // Keep the lists we have
    }
  }, [mediaDevices])

  const { mic, cam, micId, camId } = request
  const key = JSON.stringify([mic, cam, micId, camId, attempt])
  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    void openLocalMedia(mediaDevices, { mic, cam, micId, camId }, createStream).then((media) => {
      if (cancelled) {
        stopStream(media.stream)
        return
      }
      stream = media.stream
      setOpened({ key, media })
      void refreshDevices()
    })
    return () => {
      cancelled = true
      stopStream(stream)
    }
  }, [mediaDevices, createStream, refreshDevices, mic, cam, micId, camId, key])

  useEffect(() => {
    if (!mediaDevices?.addEventListener) return
    const onChange = () => void refreshDevices()
    mediaDevices.addEventListener('devicechange', onChange)
    return () => mediaDevices.removeEventListener?.('devicechange', onChange)
  }, [mediaDevices, refreshDevices])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  // While a new request is opening, the previous stream is already stopped: show nothing
  if (opened?.key !== key) {
    return { stream: null, micProblem: null, camProblem: null, opening: mic || cam, devices, retry }
  }
  return { ...opened.media, opening: false, devices, retry }
}

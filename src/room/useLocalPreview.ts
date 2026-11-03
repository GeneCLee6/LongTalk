import { useCallback, useEffect, useRef, useState } from 'react'
import { useMediaDevices } from './devicesContext.ts'
import { resolveDevice } from './session.ts'
import { applyProcessing } from '../media/audioProcessing.ts'
import {
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
  /**
   * Where the remembered microphone and camera are in the lists now (resolveDevice): the same id,
   * a new id found by label, or null when gone (or not chosen)
   */
  resolved: { mic: string | null; cam: string | null }
}

/** The preview's request, with the remembered devices' labels to find them by (G1) */
export interface PreviewRequest extends LocalMediaRequest {
  micLabel?: string | null
  camLabel?: string | null
}

// The microphone's processing switches (H3, e6-t01) are not part of what reopens the preview:
// a change is applied to the open microphone, and only where the browser cannot change them live
// is the preview opened again with them.

export interface LocalPreviewDeps {
  mediaDevices?: MediaDevicesLike | null
  createStream?: CreateStream
}

/**
 * The pre-join preview (e4-t03): opens the microphone and camera asked for, reopens them when
 * the choice changes, keeps the device lists fresh (labels appear once there is permission; a
 * device plugged in or out fires `devicechange`) and stops every track on unmount. A device
 * unplugged while previewed (its track ended) is opened again (G1): the remembered choice is
 * only preferred, so another device of that kind takes over.
 */
export function useLocalPreview(
  request: PreviewRequest,
  deps: LocalPreviewDeps = {},
): LocalPreview {
  const contextDevices = useMediaDevices()
  const [mediaDevices] = useState(() =>
    deps.mediaDevices === undefined ? contextDevices : deps.mediaDevices,
  )
  const [createStream] = useState(() => deps.createStream)
  const [attempt, setAttempt] = useState(0)
  // The result of the last request that finished, tagged with that request
  const [opened, setOpened] = useState<{ key: string; media: LocalMedia } | null>(null)
  const [devices, setDevices] = useState<DeviceLists>(emptyDeviceLists)
  const shown = useRef<MediaStream | null>(null)
  useEffect(() => {
    shown.current = opened?.media.stream ?? null
  })

  const refreshDevices = useCallback(async () => {
    if (!mediaDevices) return
    try {
      setDevices(await listDevices(mediaDevices))
    } catch {
      // Keep the lists we have
    }
  }, [mediaDevices])

  // A device found under a new id is asked for by that id; a gone one stays preferred (`ideal`:
  // the browser opens another), so nothing reopens for it
  const resolved = {
    mic: resolveDevice(request.micId, request.micLabel ?? null, devices.audioinput),
    cam: resolveDevice(request.camId, request.camLabel ?? null, devices.videoinput),
  }
  const { mic, cam } = request
  const micId = resolved.mic ?? request.micId
  const camId = resolved.cam ?? request.camId
  const key = JSON.stringify([mic, cam, micId, camId, attempt])
  const { processing } = request
  const latestProcessing = useRef(processing)
  useEffect(() => {
    latestProcessing.current = processing
  })
  useEffect(() => {
    const track = shown.current?.getAudioTracks()[0]
    if (!processing || !track) return
    let cancelled = false
    void applyProcessing(track, processing).then((applied) => {
      if (!applied && !cancelled) setAttempt((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [processing])
  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    const processing = latestProcessing.current
    void openLocalMedia(
      mediaDevices,
      { mic, cam, micId, camId, processing },
      createStream,
    ).then((media) => {
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
    const onChange = () => {
      void refreshDevices()
      const ended = shown.current?.getTracks().some((track) => track.readyState === 'ended')
      if (ended) setAttempt((n) => n + 1)
    }
    mediaDevices.addEventListener('devicechange', onChange)
    return () => mediaDevices.removeEventListener?.('devicechange', onChange)
  }, [mediaDevices, refreshDevices])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  // While a new request is opening, the previous stream is already stopped: show nothing
  if (opened?.key !== key) {
    return {
      stream: null,
      micProblem: null,
      camProblem: null,
      opening: mic || cam,
      devices,
      retry,
      resolved,
    }
  }
  return { ...opened.media, opening: false, devices, retry, resolved }
}

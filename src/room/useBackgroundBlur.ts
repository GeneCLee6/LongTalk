import { useEffect, useRef, useState } from 'react'
import { BlurFpsWatch, cameraToSend, type BlurReport } from '../media/blurLoad.ts'
import type { BackgroundBlur } from '../media/backgroundBlur.ts'

// 背景模糊 in the room (e6-t06, AC-6.5): while `on`, the camera goes through the pipeline
// (media/backgroundBlur.ts) and the room sends its track; off, the room sends the camera again.
// Either way RoomMedia only replaces what the published camera sends (replaceTrack, no
// renegotiation).
//
// - The pipeline's code, the worker, the wasm and the model load only when it is first needed: on,
//   with a camera open (a lazy chunk; not in the room's first JS, CLAUDE.md rule 6).
// - What goes out while it loads: blurLoad.ts cameraToSend.
// - Too slow for this computer (blurLoad.ts), or failing to start or while running: `onStop` says
//   why, and the page turns the setting off and says so.
// - A hidden page is not judged: its timers and frames are throttled whatever the blur does.

export type BlurStatus = 'off' | 'loading' | 'on'
export type BlurStopReason = 'overloaded' | 'failed'

/** The latest second, apart from the page's state (a report every second would re-render it) */
export class BlurLoadStore {
  #value: BlurReport | null = null
  readonly #listeners = new Set<() => void>()
  get = (): BlurReport | null => this.#value
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  set(value: BlurReport | null): void {
    this.#value = value
    for (const listener of this.#listeners) listener()
  }
}

export type StartBackgroundBlur = () => Promise<BackgroundBlur>

/** The lazy chunk: the pipeline and its assets */
export const loadBackgroundBlur = async (): Promise<StartBackgroundBlur> => {
  const [{ startBackgroundBlur }, { BLUR_ASSETS }] = await Promise.all([
    import('../media/backgroundBlur.ts'),
    import('../media/blurAssets.ts'),
  ])
  return () => startBackgroundBlur(BLUR_ASSETS)
}

export interface UseBackgroundBlur {
  /** What the room sends for this camera now, and what our own tile shows */
  send: MediaStreamTrack | null
  /** What our own tile shows: never a blank for us while the model loads */
  preview: MediaStreamTrack | null
  status: BlurStatus
  load: BlurLoadStore
}

export function useBackgroundBlur({
  camera,
  on,
  onStop,
  load = loadBackgroundBlur,
  hidden = () => document.hidden,
}: {
  /** The open camera; null when it is off */
  camera: MediaStreamTrack | null
  on: boolean
  onStop: (reason: BlurStopReason) => void
  /** The lazy loader; tests pass a fake pipeline */
  load?: () => Promise<StartBackgroundBlur>
  hidden?: () => boolean
}): UseBackgroundBlur {
  const [store] = useState(() => new BlurLoadStore())
  const [blur, setBlur] = useState<BackgroundBlur | null>(null)
  const [ready, setReady] = useState(false)
  const latest = useRef({ onStop, load, hidden })
  useEffect(() => {
    latest.current = { onStop, load, hidden }
  })
  const watch = useRef(new BlurFpsWatch())

  // Was the plain camera going out when the blur was turned on? (blurLoad.ts cameraToSend)
  const [liveWhenOff, setLiveWhenOff] = useState(false)
  const live = camera !== null
  if (!on && liveWhenOff !== live) setLiveWhenOff(live)
  // The camera closed while the model loads: when it comes back the blur is already wanted
  if (on && !live && liveWhenOff) setLiveWhenOff(false)

  // Not before there is a camera to blur: someone with it off never downloads the model
  const [needed, setNeeded] = useState(false)
  if (on && live && !needed) setNeeded(true)
  if (!on && needed) setNeeded(false)

  useEffect(() => {
    if (!needed) return
    let cancelled = false
    let started: BackgroundBlur | null = null
    let off: (() => void) | null = null
    const stop = (reason: BlurStopReason) => {
      if (!cancelled) latest.current.onStop(reason)
    }
    void (async () => {
      try {
        const start = await latest.current.load()
        if (cancelled) return
        const pipeline = await start()
        if (cancelled) {
          pipeline.close()
          return
        }
        started = pipeline
        watch.current.reset()
        off = pipeline.subscribe((event) => {
          if (event.type === 'state') setReady(pipeline.ready())
          else if (event.type === 'error') stop('failed')
          else {
            store.set(event.report)
            if (latest.current.hidden()) watch.current.reset()
            else if (watch.current.push(event.report)) stop('overloaded')
          }
        })
        setReady(pipeline.ready())
        setBlur(pipeline)
      } catch {
        stop('failed')
      }
    })()
    return () => {
      cancelled = true
      off?.()
      started?.close()
      setBlur(null)
      setReady(false)
      store.set(null)
    }
  }, [needed, store])

  // A device switch, or the camera turned off and on: the pipeline takes the new one, its output
  // (what the room sends) stays
  useEffect(() => {
    if (!blur) return
    watch.current.reset()
    blur.setInput(camera)
  }, [blur, camera])

  const blurTrack = blur && ready ? blur.track : null
  return {
    send: cameraToSend({ camera, blurWanted: on, blurTrack, rawWhileLoading: liveWhenOff }),
    preview: on ? (blurTrack ?? camera) : camera,
    status: !on ? 'off' : blurTrack ? 'on' : 'loading',
    load: store,
  }
}

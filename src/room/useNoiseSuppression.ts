import { useEffect, useRef, useState } from 'react'
import { OverloadWatch, type LoadReport } from '../media/noiseLoad.ts'
import type { NoiseSuppressor } from '../media/noiseSuppression.ts'

// The advanced noise suppression in the room (e6-t02, AC-6.2): while `on`, the microphone goes
// through RNNoise (media/noiseSuppression.ts) and the room sends the pipeline's track instead of
// it; off, the room sends the microphone again. Either way RoomMedia only replaces what the
// published microphone sends (replaceTrack, no renegotiation), and muting, push-to-talk and the
// muted-speaking hint work as before: muted, the room sends null whichever track it is, and the
// hint listens to a clone of the microphone itself (useMutedSpeechHint).
//
// - The pipeline's code, the worklet and the wasm load only when it is first turned on (a lazy
//   chunk; not in the room's first JS, CLAUDE.md rule 6).
// - Until RNNoise is ready, and whenever the audio context is not running (no user gesture yet,
//   a phone call on Safari), the microphone is sent as it is: nobody stops hearing us.
// - Too slow for this computer (noiseLoad.ts: OVERLOAD_SECONDS over budget in a row), or failing
//   to start or while running: `onStop` says why, and the page turns the setting off and says so.

export type NoiseStatus = 'off' | 'loading' | 'on' | 'paused'
export type NoiseStopReason = 'overloaded' | 'failed'

/** What the stats panel shows of it: the latest second's load and the added delay */
export interface NoiseLoad extends LoadReport {
  latencyMs: number
}

/** The latest load, apart from the page's state (a report every second would re-render it) */
export class NoiseLoadStore {
  #value: NoiseLoad | null = null
  readonly #listeners = new Set<() => void>()
  get = (): NoiseLoad | null => this.#value
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  set(value: NoiseLoad | null): void {
    this.#value = value
    for (const listener of this.#listeners) listener()
  }
}

export type StartNoiseSuppression = (input: MediaStreamTrack | null) => Promise<NoiseSuppressor>

/** The lazy chunk: the pipeline and its assets */
export const loadNoiseSuppression = async (): Promise<StartNoiseSuppression> => {
  const [{ startNoiseSuppression }, { NOISE_ASSETS }] = await Promise.all([
    import('../media/noiseSuppression.ts'),
    import('../media/noiseAssets.ts'),
  ])
  return (input) => startNoiseSuppression(input, NOISE_ASSETS)
}

export interface UseNoiseSuppression {
  /** What to send instead of the microphone; null: the microphone itself */
  track: MediaStreamTrack | null
  status: NoiseStatus
  load: NoiseLoadStore
}

export function useNoiseSuppression({
  mic,
  on,
  onStop,
  load = loadNoiseSuppression,
}: {
  /** The open microphone (muted or not); null when none is open */
  mic: MediaStreamTrack | null
  on: boolean
  onStop: (reason: NoiseStopReason) => void
  /** The lazy loader; tests pass a fake pipeline */
  load?: () => Promise<StartNoiseSuppression>
}): UseNoiseSuppression {
  const [store] = useState(() => new NoiseLoadStore())
  const [suppressor, setSuppressor] = useState<NoiseSuppressor | null>(null)
  const [running, setRunning] = useState(false)
  const latest = useRef({ onStop, load })
  useEffect(() => {
    latest.current = { onStop, load }
  })

  useEffect(() => {
    if (!on) return
    let cancelled = false
    let started: NoiseSuppressor | null = null
    let off: (() => void) | null = null
    const watch = new OverloadWatch()
    const stop = (reason: NoiseStopReason) => {
      if (!cancelled) latest.current.onStop(reason)
    }
    void (async () => {
      try {
        const start = await latest.current.load()
        if (cancelled) return
        // The microphone goes in below, like every later one
        const pipeline = await start(null)
        if (cancelled) {
          void pipeline.close()
          return
        }
        started = pipeline
        off = pipeline.subscribe((event) => {
          if (event.type === 'state') setRunning(pipeline.running())
          else if (event.type === 'error') stop('failed')
          else {
            store.set({ ...event.report, latencyMs: pipeline.latencyMs })
            if (watch.push(event.report)) stop('overloaded')
          }
        })
        setRunning(pipeline.running())
        setSuppressor(pipeline)
      } catch {
        stop('failed')
      }
    })()
    return () => {
      cancelled = true
      off?.()
      void started?.close()
      setSuppressor(null)
      setRunning(false)
      store.set(null)
    }
  }, [on, store])

  // A device switch or the microphone opened again: the pipeline takes the new one, its output
  // (what the room sends) stays
  useEffect(() => {
    if (!suppressor) return
    try {
      suppressor.setInput(mic)
    } catch {
      latest.current.onStop('failed')
    }
  }, [suppressor, mic])

  const status: NoiseStatus = !on ? 'off' : !suppressor ? 'loading' : running ? 'on' : 'paused'
  return { track: suppressor && running ? suppressor.track : null, status, load: store }
}

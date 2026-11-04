// Local recording in the room (I4, e8-t01, e8-t02): the room decides (CLAUDE.md rules 1 and 4),
// the browser follows. Pressing 開始錄影 asks the room (`record` on); the recorder (src/record/,
// lazy) starts only once the room lists us in RoomInfo.recordings, so everyone sees the red
// light from the first frame. Stopping saves and downloads the file, then tells the room. When
// the room ends it (the host stopped it, or took the permission back) the browser stops and
// saves too. A tab that reloads while recording finds itself still listed and says it is not.
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ClientMessage, ErrorCode, RecordingInfo } from '../../shared/protocol.ts'
import {
  DEFAULT_RECORDING_SETTINGS,
  isResolution,
  type RecordingSettings,
} from '../record/format.ts'
import type { RecorderProblem, RecordingHandle, SavedRecording } from '../record/recorder.ts'
import type { Scene } from '../record/scene.ts'

export type RecordingPhase = 'idle' | 'claiming' | 'starting' | 'recording' | 'saving'

/** What the room page says about it (toasts) */
export type RecordingEvent =
  | { type: 'started' }
  | { type: 'saved'; saved: SavedRecording; problem: RecorderProblem | null }
  | { type: 'startFailed' }
  | { type: 'forbidden' }

/** The recorder module (lazy); a stand-in in tests */
export type RecorderModule = Pick<typeof import('../record/recorder.ts'), 'startRecording'>

const loadRecorder = (): Promise<RecorderModule> => import('../record/recorder.ts')

/** The room has this long to grant a `record` before we give up */
export const CLAIM_TIMEOUT_MS = 10_000

export interface LocalRecordingOptions {
  roomId: string
  roomName: string
  you: string | null
  /** RoomInfo.recordings; undefined before the room's view arrived */
  recordings: Readonly<Record<string, RecordingInfo>> | undefined
  send: (message: ClientMessage) => void
  onError: (listener: (code: ErrorCode) => void) => () => void
  getScene: () => Scene
  powerSaving: boolean
  notify: (event: RecordingEvent) => void
  load?: () => Promise<RecorderModule>
}

export interface LocalRecording {
  phase: RecordingPhase
  /** Asks the room, then records with these settings */
  start: (settings: RecordingSettings) => void
  /** Stops and saves (or gives up asking) */
  stop: () => void
}

export function useLocalRecording({
  roomId,
  roomName,
  you,
  recordings,
  send,
  onError,
  getScene,
  powerSaving,
  notify,
  load = loadRecorder,
}: LocalRecordingOptions): LocalRecording {
  const [phase, setPhaseState] = useState<RecordingPhase>('idle')
  const phaseRef = useRef<RecordingPhase>('idle')
  const setPhase = useCallback((next: RecordingPhase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])
  const settings = useRef<RecordingSettings | null>(null)
  const handle = useRef<RecordingHandle | null>(null)
  const problem = useRef<RecorderProblem | null>(null)
  /** Stop was asked for while the recorder was still loading */
  const cancelled = useRef(false)
  const listed = you !== null && recordings?.[you] !== undefined
  const viewKnown = recordings !== undefined && you !== null

  const notified = useRef(notify)
  useEffect(() => {
    notified.current = notify
  })
  const tell = (event: RecordingEvent) => notified.current(event)
  const scene = useRef(getScene)
  useEffect(() => {
    scene.current = getScene
  })

  /** Stops the recorder and downloads; `tellRoom`: we stop, not the room */
  const finish = useCallback(
    (tellRoom: boolean) => {
      const current = handle.current
      if (tellRoom) send({ t: 'record', on: false })
      if (!current) {
        // Still loading: begin() stops it as soon as it is there
        cancelled.current = true
        setPhase('idle')
        return
      }
      handle.current = null
      setPhase('saving')
      void current.stop().then(
        (saved) => {
          tell({ type: 'saved', saved, problem: problem.current })
          problem.current = null
          setPhase('idle')
        },
        () => {
          tell({
            type: 'saved',
            saved: { fileName: current.fileName, bytes: 0 },
            problem: 'failed',
          })
          setPhase('idle')
        },
      )
    },
    [send, setPhase],
  )

  const begin = useEffectEvent(() => {
    const chosen = settings.current
    if (!chosen) return
    cancelled.current = false
    problem.current = null
    load()
      .then((module) =>
        module.startRecording({
          roomId,
          roomName,
          settings: chosen,
          getScene: () => scene.current(),
          powerSaving,
          onProblem: (kind) => {
            problem.current = kind
            // The recorder saves by itself; the room hears we stopped
            if (phaseRef.current === 'recording') finish(true)
          },
        }),
      )
      .then(
        (started) => {
          if (cancelled.current || phaseRef.current !== 'starting') {
            void started.stop()
            return
          }
          handle.current = started
          setPhase('recording')
          tell({ type: 'started' })
        },
        () => {
          if (phaseRef.current !== 'starting') return
          send({ t: 'record', on: false })
          setPhase('idle')
          tell({ type: 'startFailed' })
        },
      )
  })

  // Follow the room: granted → start; ended by the room → stop and save; listed while we do not
  // record (a reload) → say we do not
  const follow = useEffectEvent(() => {
    if (!viewKnown) return
    if (phase === 'claiming' && listed) {
      setPhase('starting')
      begin()
    } else if ((phase === 'starting' || phase === 'recording') && !listed) {
      finish(false)
    } else if (phase === 'idle' && listed) {
      send({ t: 'record', on: false })
    }
  })
  // On the next task, not inside the effect: what it does sets state (and loads the recorder)
  useEffect(() => {
    const timer = setTimeout(follow, 0)
    return () => clearTimeout(timer)
  }, [phase, listed, viewKnown])

  // The room never answered, or refused
  useEffect(() => {
    if (phase !== 'claiming') return
    const timer = setTimeout(() => {
      if (phaseRef.current !== 'claiming') return
      send({ t: 'record', on: false })
      setPhase('idle')
      tell({ type: 'startFailed' })
    }, CLAIM_TIMEOUT_MS)
    const off = onError((code) => {
      if (code !== 'forbidden' || phaseRef.current !== 'claiming') return
      setPhase('idle')
      tell({ type: 'forbidden' })
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [phase, onError, send, setPhase])

  // Closing the tab while recording asks first (what was recorded so far stays recoverable)
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'saving') return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    addEventListener('beforeunload', onBeforeUnload)
    return () => removeEventListener('beforeunload', onBeforeUnload)
  }, [phase])

  // Leaving the room (the page goes): the recording is saved on the way out
  useEffect(
    () => () => {
      cancelled.current = true
      const current = handle.current
      handle.current = null
      if (current) void current.stop()
    },
    [],
  )

  const start = useCallback(
    (chosen: RecordingSettings) => {
      if (phaseRef.current !== 'idle') return
      settings.current = chosen
      setPhase('claiming')
      send({ t: 'record', on: true })
    },
    [send, setPhase],
  )

  const stop = useCallback(() => {
    const now = phaseRef.current
    if (now === 'claiming') {
      send({ t: 'record', on: false })
      setPhase('idle')
    } else if (now === 'starting' || now === 'recording') {
      finish(true)
    }
  }, [send, setPhase, finish])

  return { phase, start, stop }
}

const SETTINGS_KEY = 'longtalk.recording.settings'

/** 錄影設定 as chosen last time (localStorage), or the defaults */
export function loadRecordingSettings(): RecordingSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as unknown
    if (typeof raw !== 'object' || raw === null) return DEFAULT_RECORDING_SETTINGS
    const value = raw as Record<string, unknown>
    return {
      audioOnly: typeof value.audioOnly === 'boolean' ? value.audioOnly : false,
      includeSelf: typeof value.includeSelf === 'boolean' ? value.includeSelf : true,
      resolution: isResolution(value.resolution) ? value.resolution : '720p',
    }
  } catch {
    return DEFAULT_RECORDING_SETTINGS
  }
}

export function saveRecordingSettings(settings: RecordingSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Not remembered: the defaults next time
  }
}

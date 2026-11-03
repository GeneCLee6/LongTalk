import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientMessage, MemberTrack, RoomView } from '../../shared/protocol.ts'
import type { MediaTransport } from '../media/MediaTransport.ts'
import { watchNetwork } from './network.ts'
import {
  idleRoomMedia,
  RoomMedia,
  type IceConfig,
  type LocalTracks,
  type RoomMediaState,
} from './RoomMedia.ts'
import { VideoDemandStore } from './videoDemand.ts'

export interface UseRoomMediaOptions {
  /**
   * True once the room welcomed us (the SFU proxy needs the session token by then), and while the
   * socket reconnects: the media connection does not depend on the socket
   */
  enabled: boolean
  /** A new transport for each session (rebuilds make more); called inside an effect */
  createTransport: () => MediaTransport
  /** ICE servers before each session (TURN credentials, e2-t07) */
  iceConfig?: () => Promise<IceConfig | null>
  /**
   * What to send (null per kind when off); null while the devices are still opening. Changing
   * it later toggles or switches without a new session.
   */
  local: LocalTracks | null
  /** The screen to share once the room named us the sharer (D1); null when not sharing */
  screen?: MediaStreamTrack | null
  /** The screen's sound to send (D2): null when there is none or the sharer turned it off */
  screenAudio?: MediaStreamTrack | null
  send: (message: ClientMessage) => void
  /** This member's id, so its own tracks are never subscribed; a new id is a new run */
  you: string | null
  view: RoomView | null
  /** How many times the room welcomed us: a new welcome re-reports what we publish */
  welcomes?: number
}

export interface RoomMediaHandle extends RoomMediaState {
  /** After `failed`: build a new session */
  retry: () => void
  /**
   * Where the tiles draw each received video (e2-t12): the room page provides it to the stage
   * (VideoDemandContext), RoomMedia picks layers from it
   */
  demand: VideoDemandStore
}

const noSubscribe = () => () => {}
const idle = () => idleRoomMedia

/**
 * The room's media (e2-t03, e2-t04, e2-t08): while enabled, one RoomMedia publishes `local` and
 * receives every other member's tracks from the room view, rebuilding its session when the media
 * connection fails. A new RoomMedia per run (and per member id: the room forgot us after a long
 * outage), closed on cleanup, so StrictMode's mount / unmount / mount leaves exactly one session
 * publishing.
 */
export function useRoomMedia(options: UseRoomMediaOptions): RoomMediaHandle {
  const { enabled, local, you, view, welcomes = 0, screen = null, screenAudio = null } = options
  const [media, setMedia] = useState<RoomMedia | null>(null)
  // One store for the page's lifetime: tiles keep reporting into it across sessions
  const [demand] = useState(() => new VideoDemandStore())
  // Read when a run starts, without restarting it when they change
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  // Starts once the devices have opened (or failed to); toggles and device switches after that
  // go to the running RoomMedia (setLocal) instead of starting a new session
  const ready = local !== null
  useEffect(() => {
    if (!enabled || !ready || you === null) return
    const { view: startView, local: startLocal } = latest.current
    const run = new RoomMedia({
      createTransport: () => latest.current.createTransport(),
      iceConfig: () => latest.current.iceConfig?.() ?? Promise.resolve(null),
      send: (message) => latest.current.send(message),
      demand,
    })
    setMedia(run)
    void run.start(startLocal ?? { mic: null, cam: null }, startView?.usage ?? 'normal')
    const unwatch = watchNetwork({ online: () => run.nudge(), visible: () => run.nudge() })
    return () => {
      unwatch()
      void run.close()
      setMedia((current) => (current === run ? null : current))
    }
  }, [enabled, ready, you, demand])

  // A tab in the background shows nothing: every received video drops to its lowest layer
  useEffect(() => {
    if (typeof document === 'undefined') return
    const update = () => demand.setPageHidden(document.visibilityState === 'hidden')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [demand])

  const mic = local?.mic ?? null
  const cam = local?.cam ?? null
  useEffect(() => {
    void media?.setLocal({ mic, cam })
  }, [media, mic, cam])

  useEffect(() => {
    void media?.setScreen(screen, screenAudio)
  }, [media, screen, screenAudio])

  const members = view?.members
  const desired = useMemo<MemberTrack[]>(
    () =>
      Object.values(members ?? {})
        .filter((member) => member.id !== you)
        .flatMap((member) => member.tracks),
    [members, you],
  )
  useEffect(() => {
    media?.setDesired(desired)
  }, [media, desired])

  const usage = view?.usage ?? 'normal'
  useEffect(() => {
    media?.setUsage(usage)
  }, [media, usage])

  // Every welcome after the first is a rejoin: tell the room what we publish again
  useEffect(() => {
    if (welcomes > 1) media?.rejoined()
  }, [media, welcomes])

  const state = useSyncExternalStore(media?.subscribe ?? noSubscribe, media?.getState ?? idle)
  const retry = useCallback(() => media?.retry(), [media])
  return useMemo(() => ({ ...state, retry, demand }), [state, retry, demand])
}

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientMessage, MemberTrack, RoomView } from '../../shared/protocol.ts'
import type { MediaTransport } from '../media/MediaTransport.ts'
import type { ShareMode } from '../media/shareMode.ts'
import { watchNetwork } from './network.ts'
import {
  idleRoomMedia,
  RoomMedia,
  type IceConfig,
  type LocalTracks,
  type RoomMediaState,
} from './RoomMedia.ts'
import { StatsStore } from './statsStore.ts'
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
  /** How the screen is encoded (e3-t06): 文字 (the default) or 動態 */
  screenMode?: ShareMode
  send: (message: ClientMessage) => void
  /** This member's id, so its own tracks are never subscribed; a new id is a new run */
  you: string | null
  view: RoomView | null
  /** How many times the room welcomed us: a new welcome re-reports what we publish */
  welcomes?: number
  /** HD (e6-t04): the camera sends its 720p layer, uplink allowing; on without it */
  hd?: boolean
  /** 純音訊模式 to start with (the pre-join screen's choice); setAudioOnly changes it */
  initialAudioOnly?: boolean
  /** 省電模式 (e6-t05): lowest layers received, no HD, the camera at a lower frame rate */
  powerSaving?: boolean
}

export interface RoomMediaHandle extends RoomMediaState {
  /** After `failed`: build a new session */
  retry: () => void
  /**
   * Where the tiles draw each received video (e2-t12): the room page provides it to the stage
   * (VideoDemandContext), RoomMedia picks layers from it
   */
  demand: VideoDemandStore
  /** The latest connection statistics, for the stats panel (e2-t14) */
  stats: StatsStore
  /**
   * The cameras to keep, by trackKey, most important first, should the downlink have to stop
   * receiving cameras (e2-t15): the ones chosen (a pin, a spotlight), then the speakers (the big
   * tile, whoever speaks)
   */
  setVideoPriority: (chosen: readonly string[], speakers: readonly string[]) => void
  /**
   * 純音訊模式 on or off (e6-t04): no video received, our camera not sent. Kept across sessions;
   * `audioOnly` follows it at once. For the settings panel and anything else that decides it
   * (H2's bandwidth adaptation).
   */
  setAudioOnly: (on: boolean) => void
}

const NO_KEYS: readonly string[] = []
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
  const {
    enabled,
    local,
    you,
    view,
    welcomes = 0,
    screen = null,
    screenAudio = null,
    screenMode = 'text',
  } = options
  const hd = options.hd ?? true
  const powerSaving = options.powerSaving ?? false
  const [media, setMedia] = useState<RoomMedia | null>(null)
  // 純音訊模式 outlives a session (rebuilds, a new member id): kept here, handed to each run
  const [audioOnly, setAudioOnly] = useState(options.initialAudioOnly ?? false)
  const mode = useRef({ audioOnly, hd, powerSaving })
  useEffect(() => {
    mode.current = { audioOnly, hd, powerSaving }
  })
  // One store for the page's lifetime: tiles keep reporting into it across sessions
  const [demand] = useState(() => new VideoDemandStore())
  const [stats] = useState(() => new StatsStore())
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
      stats,
      audioOnly: mode.current.audioOnly,
      hd: mode.current.hd,
      powerSaving: mode.current.powerSaving,
    })
    setMedia(run)
    void run.start(startLocal ?? { mic: null, cam: null }, startView?.usage ?? 'normal')
    const unwatch = watchNetwork({ online: () => run.nudge(), visible: () => run.nudge() })
    return () => {
      unwatch()
      void run.close()
      setMedia((current) => (current === run ? null : current))
      stats.set(null)
    }
  }, [enabled, ready, you, demand, stats])

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

  useEffect(() => {
    void media?.setScreenMode(screenMode)
  }, [media, screenMode])

  useEffect(() => {
    void media?.setAudioOnly(audioOnly)
  }, [media, audioOnly])

  useEffect(() => {
    void media?.setHd(hd)
  }, [media, hd])

  useEffect(() => {
    void media?.setPowerSaving(powerSaving)
  }, [media, powerSaving])

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

  // The cameras to keep through a cut (e2-t15): the page knows them only after the tiles are
  // placed, so it hands them over, and a new run gets the latest
  const priority = useRef<{ chosen: readonly string[]; speakers: readonly string[] }>({
    chosen: NO_KEYS,
    speakers: NO_KEYS,
  })
  const setVideoPriority = useCallback(
    (chosen: readonly string[], speakers: readonly string[]) => {
      priority.current = { chosen, speakers }
      media?.setVideoPriority(chosen, speakers)
    },
    [media],
  )
  useEffect(() => {
    media?.setVideoPriority(priority.current.chosen, priority.current.speakers)
  }, [media])

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
  // The wish shows at once, before (or without) a running session
  return useMemo(
    () => ({
      ...state,
      audioOnly,
      hd,
      powerSaving,
      retry,
      demand,
      stats,
      setAudioOnly,
      setVideoPriority,
    }),
    [state, audioOnly, hd, powerSaving, retry, demand, stats, setVideoPriority],
  )
}

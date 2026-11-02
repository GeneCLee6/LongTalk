import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientMessage, MemberTrack, RoomView } from '../../shared/protocol.ts'
import type { MediaTransport } from '../media/MediaTransport.ts'
import { idleRoomMedia, RoomMedia, type LocalTracks, type RoomMediaState } from './RoomMedia.ts'

export interface UseRoomMediaOptions {
  /** True once the room welcomed us (the SFU proxy needs the session token by then) */
  enabled: boolean
  /** A new transport for each run; called inside an effect */
  createTransport: () => MediaTransport
  /** The opened microphone and camera; null while they are still opening */
  local: LocalTracks | null
  send: (message: ClientMessage) => void
  /** This member's id, so its own tracks are never subscribed */
  you: string | null
  view: RoomView | null
}

const noSubscribe = () => () => {}
const idle = () => idleRoomMedia

/**
 * The room's media (e2-t03, e2-t04): while enabled, one RoomMedia publishes `local` and receives
 * every other member's tracks from the room view. A new RoomMedia (and transport) per run, closed
 * on cleanup, so StrictMode's mount / unmount / mount leaves exactly one session publishing.
 */
export function useRoomMedia(options: UseRoomMediaOptions): RoomMediaState {
  const { enabled, local, you, view } = options
  const [media, setMedia] = useState<RoomMedia | null>(null)
  // Read when a run starts, without restarting it when they change
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  useEffect(() => {
    if (!enabled || !local) return
    const { createTransport, send, view: startView } = latest.current
    const run = new RoomMedia({ transport: createTransport(), send })
    setMedia(run)
    void run.start(local, startView?.usage ?? 'normal')
    return () => {
      void run.close()
      setMedia((current) => (current === run ? null : current))
    }
  }, [enabled, local])

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

  return useSyncExternalStore(media?.subscribe ?? noSubscribe, media?.getState ?? idle)
}

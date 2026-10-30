import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { RoomConnection, type RoomConnectionState } from './RoomConnection.ts'
import { clearSession, loadSession, saveSession } from './session.ts'

export interface RoomConnectionHandle {
  state: RoomConnectionState
  /** Leaves the room on purpose: the member is removed at once and the session forgotten */
  leave: () => void
}

/**
 * Joins the room as `name` while the component is mounted, with the session token this tab was
 * given before (a reload comes back as the same member); the state re-renders on every change.
 */
export function useRoomConnection(roomId: string, name: string): RoomConnectionHandle {
  const connection = useMemo(
    () =>
      new RoomConnection(
        roomId,
        { name, token: loadSession(roomId) },
        { onToken: (token) => saveSession(roomId, token) },
      ),
    [roomId, name],
  )
  useEffect(() => {
    connection.start()
    return () => connection.stop()
  }, [connection])
  const state = useSyncExternalStore(connection.subscribe, connection.getState)
  const leave = useCallback(() => {
    connection.stop({ leave: true })
    clearSession(roomId)
  }, [connection, roomId])
  return { state, leave }
}

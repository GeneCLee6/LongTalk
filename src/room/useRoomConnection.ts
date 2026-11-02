import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ClientMessage, ErrorCode } from '../../shared/protocol.ts'
import { watchNetwork } from './network.ts'
import { RoomConnection, type RoomConnectionState } from './RoomConnection.ts'
import { clearSession, loadSession, saveSession } from './session.ts'

export interface RoomConnectionHandle {
  state: RoomConnectionState
  /** Leaves the room on purpose: the member is removed at once and the session forgotten */
  leave: () => void
  /** Sends a message to the room (dropped while the socket is not open) */
  send: (message: ClientMessage) => void
  /** After `lost`: try to reconnect again */
  retry: () => void
  /** Changes this member's own name (normalized), also for every later rejoin (e1-t05) */
  rename: (name: string) => void
  /** Listens for the room's refusals (`error` codes); returns a function that stops listening */
  onError: (listener: (code: ErrorCode) => void) => () => void
}

/**
 * Joins the room as `name` while the component is mounted, with the session token this tab was
 * given before (a reload comes back as the same member); the state re-renders on every change.
 * Reconnects on its own (RoomConnection), sooner when the browser comes online or to the
 * foreground.
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
    const unwatch = watchNetwork({
      online: () => connection.online(),
      offline: () => connection.offline(),
      visible: () => connection.visible(),
    })
    return () => {
      unwatch()
      connection.stop()
    }
  }, [connection])
  const state = useSyncExternalStore(connection.subscribe, connection.getState)
  const leave = useCallback(() => {
    connection.stop({ leave: true })
    clearSession(roomId)
  }, [connection, roomId])
  return {
    state,
    leave,
    send: connection.send,
    retry: connection.retry,
    rename: connection.rename,
    onError: connection.onError,
  }
}

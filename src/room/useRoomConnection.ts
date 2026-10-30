import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { RoomConnection, type RoomConnectionState } from './RoomConnection.ts'

/** Connects to the room while the component is mounted; the state re-renders on every change */
export function useRoomConnection(roomId: string): RoomConnectionState {
  const connection = useMemo(() => new RoomConnection(roomId), [roomId])
  useEffect(() => {
    connection.start()
    return () => connection.stop()
  }, [connection])
  return useSyncExternalStore(connection.subscribe, connection.getState)
}

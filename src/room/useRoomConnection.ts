import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type {
  RoomView,
  AnnotationMessage,
  AnnotationsMessage,
  ClientMessage,
  ErrorCode,
  NoticeMessage,
  ReactionMessage,
} from '../../shared/protocol.ts'
import { scopeView } from '../../shared/breakout.ts'
import type { Reaction } from '../../shared/reactions.ts'
import { dictionary, useLocale } from '../strings.ts'
import { nameAgents } from './agentNames.ts'
import { watchNetwork } from './network.ts'
import { RoomConnection, type ChatSendResult, type RoomConnectionState } from './RoomConnection.ts'
import { clearSession, loadClientId, loadSession, saveSession } from './session.ts'

export interface RoomConnectionHandle {
  /**
   * The connection's state. While breakout rooms are open (L3) `state.view` is scoped to this
   * member's own room (shared/breakout.ts scopeView): media, tiles, shares and hands see only it.
   * A desktop agent's `name` is already what to show (N2, agentNames.ts nameAgents)
   */
  state: RoomConnectionState
  /** The whole room's view, every breakout room included: only the host's panels read it (L3) */
  fullView: RoomView | null
  /**
   * Leaves the room on purpose: the member is removed at once and the session forgotten. A host
   * may name who takes over (F3, e1-t17)
   */
  leave: (host?: string) => void
  /** Sends a message to the room (dropped while the socket is not open) */
  send: (message: ClientMessage) => void
  /** After `lost`: try to reconnect again */
  retry: () => void
  /** Changes this member's own name (normalized), also for every later rejoin (e1-t05) */
  rename: (name: string) => void
  /** Listens for the room's refusals (`error` codes); returns a function that stops listening */
  onError: (listener: (code: ErrorCode) => void) => () => void
  /** Listens for what a host did to this member (F1); returns a function that stops listening */
  onNotice: (listener: (notice: NoticeMessage) => void) => () => void
  /** Sends a chat message (D3); anything but `sent` means the text should stay in the box */
  sendChat: (text: string) => ChatSendResult
  /** Listens for everyone's reactions (G3); returns a function that stops listening */
  onReaction: (listener: (reaction: ReactionMessage) => void) => () => void
  /** Sends a reaction (G3); `rateLimited` when it would be too many too fast */
  sendReaction: (emoji: Reaction) => 'sent' | 'rateLimited' | 'offline'
  /** Listens for what happens to the strokes on the shares (J2); returns how to stop listening */
  onAnnotation: (listener: (message: AnnotationMessage | AnnotationsMessage) => void) => () => void
  /** Welcomed, right now */
  isOpen: () => boolean
}

/**
 * Joins the room as `name` while the component is mounted, with the session token this tab was
 * given before (a reload comes back as the same member); the state re-renders on every change.
 * Reconnects on its own (RoomConnection), sooner when the browser comes online or to the
 * foreground.
 */
export function useRoomConnection(
  roomId: string,
  name: string,
  /** The room's password (F3), for joining a room that has one as someone new */
  password: string | null = null,
): RoomConnectionHandle {
  const connection = useMemo(
    () =>
      new RoomConnection(
        roomId,
        { name, token: loadSession(roomId), client: loadClientId(), password },
        { onToken: (token) => saveSession(roomId, token) },
      ),
    [roomId, name, password],
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
  const raw = useSyncExternalStore(connection.subscribe, connection.getState)
  // Desktop agents named 「<owner> 的電腦」 (N2) in the language chosen now
  const locale = useLocale()
  const named = useMemo(
    () => (raw.view ? nameAgents(raw.view, dictionary(locale).agent) : null),
    [raw.view, locale],
  )
  const state = useMemo(() => {
    const view = named && raw.you ? scopeView(named, raw.you) : named
    return view === raw.view ? raw : { ...raw, view }
  }, [raw, named])
  const leave = useCallback(
    (host?: string) => {
      connection.stop({ leave: true, host })
      clearSession(roomId)
    },
    [connection, roomId],
  )
  return {
    state,
    fullView: named,
    leave,
    send: connection.send,
    retry: connection.retry,
    rename: connection.rename,
    onError: connection.onError,
    onNotice: connection.onNotice,
    sendChat: connection.sendChat,
    onReaction: connection.onReaction,
    sendReaction: connection.sendReaction,
    onAnnotation: connection.onAnnotation,
    isOpen: connection.isOpen,
  }
}

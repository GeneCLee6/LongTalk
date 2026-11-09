import { useCallback, useEffect, useState } from 'react'
import type { ChatMessage } from '../../shared/chat.ts'
import { countUnread, latestId } from './chatText.ts'

/** How long the preview bubble of a new message stays (DESIGN.md: a short preview) */
export const CHAT_PREVIEW_MS = 6_000

export interface ChatNotifications {
  /** Messages from others since the panel was last open (the toolbar's badge) */
  unread: number
  /** The newest message from someone else that arrived while the panel was closed, briefly */
  preview: ChatMessage | null
  dismissPreview: () => void
}

/**
 * The chat's unread count and preview bubble (e5-t02). What was already there when we joined
 * (the history) is not new: counting starts from the first history the room sends. Opening the
 * panel reads everything; our own messages are never unread. While the panel is closed each new
 * message from someone else replaces the preview, which goes away after CHAT_PREVIEW_MS.
 *
 * `historyUntil` (RoomConnectionState.chatHistoryUntil): what the room replayed as history, every
 * frame of it, is not new either; a breakout move (L3) replays the new room's chat mid-meeting,
 * which must neither blip nor count.
 */
export function useChatNotifications({
  messages,
  loaded,
  you,
  open,
  historyUntil = 0,
}: {
  messages: readonly ChatMessage[]
  loaded: boolean
  you: string | null
  open: boolean
  historyUntil?: number
}): ChatNotifications {
  const latest = latestId(messages)
  // The newest id read (null until the history arrived) and the newest one previewed
  const [seen, setSeen] = useState<number | null>(null)
  const [notified, setNotified] = useState<number | null>(null)
  const [preview, setPreview] = useState<ChatMessage | null>(null)

  // Adjusted while rendering (React's pattern for state that follows a value), not in an effect
  if (loaded && seen === null) setSeen(latest)
  if (loaded && notified === null) setNotified(latest)
  // A replayed history is never previewed (and never unread: countUnread below starts after it).
  // `notified` only grows, so this settles; `seen` follows `latest`, which a move may lower
  const replayed = notified !== null && historyUntil > notified
  if (replayed) setNotified(historyUntil)
  if (open && seen !== null && seen !== latest) setSeen(latest)
  if (open && preview !== null) setPreview(null)
  if (!replayed && notified !== null && latest > notified) {
    setNotified(latest)
    const newest = [...messages].reverse().find((m) => m.id > notified && m.from !== you)
    if (!open && newest) setPreview(newest)
  }

  useEffect(() => {
    if (!preview) return
    const timer = setTimeout(() => setPreview(null), CHAT_PREVIEW_MS)
    return () => clearTimeout(timer)
  }, [preview])

  const dismissPreview = useCallback(() => setPreview(null), [])
  return {
    unread: seen === null ? 0 : countUnread(messages, Math.max(seen, historyUntil), you),
    preview,
    dismissPreview,
  }
}

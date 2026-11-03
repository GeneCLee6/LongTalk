import { useCallback, useEffect, useState } from 'react'
import {
  currentPassword,
  loadKnownPassword,
  reconcileKnown,
  saveKnownPassword,
  type KnownPassword,
} from './roomPassword.ts'

/**
 * What this tab knows of the room's password (F3, e1-t15): the room's current password, when it
 * was set, typed or brought by a link here, for 「複製含密碼的連結」 and the host's password
 * dialog. `passwordSetAt` is the room's (undefined until the view arrives).
 */
export function useKnownPassword(roomId: string, passwordSetAt: number | null | undefined) {
  const [known, setKnown] = useState<KnownPassword | null>(() => loadKnownPassword(roomId))
  // Follows the room's password time while rendering (React's pattern for state that follows a
  // value), not in an effect
  const next = passwordSetAt === undefined ? known : reconcileKnown(known, passwordSetAt)
  if (next !== known) setKnown(next)
  useEffect(() => saveKnownPassword(roomId, known), [roomId, known])
  /** The host set (or cleared, null) the password here: tied to the room's next report */
  const remember = useCallback(
    (password: string | null) =>
      setKnown(password === null ? null : { password, setAt: null, after: passwordSetAt ?? null }),
    [passwordSetAt],
  )
  return { current: currentPassword(next, passwordSetAt ?? null), remember }
}

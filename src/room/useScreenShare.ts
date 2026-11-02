import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientMessage, ErrorCode, ShareInfo } from '../../shared/protocol.ts'
import { captureScreen } from '../media/share.ts'
import { idleShare, ScreenShare, type ScreenShareState, type ShareNotice } from './ScreenShare.ts'

export interface UseScreenShareOptions {
  /** Who shares now (the room view's `room.share`) */
  share: ShareInfo | null
  you: string | null
  send: (message: ClientMessage) => void
  /** The room's refusals (useRoomConnection's onError) */
  onError: (listener: (code: ErrorCode) => void) => () => void
  /** How many times the room welcomed us: a new welcome re-sends a pending claim */
  welcomes: number
  notify: (notice: ShareNotice) => void
}

export interface ScreenShareHandle extends ScreenShareState {
  /** Share pressed (asks first when someone else shares) */
  request: () => void
  /** Take over: yes / no */
  confirm: () => void
  cancel: () => void
  /** Stop sharing */
  stop: () => void
}

const noSubscribe = () => () => {}
const idle = () => idleShare

/**
 * This member's screen share (e3-t01 – e3-t03): one ScreenShare per mounted room, closed (the
 * capture stopped) on unmount, so StrictMode's mount / unmount / mount leaves one
 */
export function useScreenShare(options: UseScreenShareOptions): ScreenShareHandle {
  const { share, you, onError, welcomes } = options
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  const [controller, setController] = useState<ScreenShare | null>(null)
  useEffect(() => {
    const run = new ScreenShare({
      capture: () => captureScreen(),
      send: (message) => latest.current.send(message),
      notify: (notice) => latest.current.notify(notice),
    })
    setController(run)
    return () => {
      run.close()
      setController((current) => (current === run ? null : current))
    }
  }, [])
  useEffect(() => {
    controller?.setRoom(share, you)
  }, [controller, share, you])
  useEffect(
    () => (controller ? onError((code) => controller.refused(code)) : undefined),
    [controller, onError],
  )
  useEffect(() => {
    if (welcomes > 1) controller?.rejoined()
  }, [controller, welcomes])
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getState ?? idle,
  )
  return useMemo(
    () => ({
      ...state,
      request: () => void controller?.request(),
      confirm: () => void controller?.confirm(),
      cancel: () => controller?.cancel(),
      stop: () => controller?.stop(),
    }),
    [state, controller],
  )
}

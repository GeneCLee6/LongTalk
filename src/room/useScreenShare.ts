import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientMessage, ErrorCode, ShareInfo } from '../../shared/protocol.ts'
import { canShareAudio } from '../media/capabilities.ts'
import { captureScreen } from '../media/share.ts'
import type { ShareMode } from '../media/shareMode.ts'
import { idleShare, ScreenShare, type ScreenShareState, type ShareNotice } from './ScreenShare.ts'
import type { ShareCameraGuard } from './ShareCameraGuard.ts'

export interface UseScreenShareOptions {
  /** Who shares now (the room view's `room.shares`) */
  shares: Readonly<Record<string, ShareInfo>> | undefined
  you: string | null
  send: (message: ClientMessage) => void
  /** The room's refusals (useRoomConnection's onError) */
  onError: (listener: (code: ErrorCode) => void) => () => void
  /** How many times the room welcomed us: a new welcome re-sends a pending claim */
  welcomes: number
  notify: (notice: ShareNotice) => void
  /** The camera goes off first in this browser (ShareCameraGuard.ts); null elsewhere */
  guard?: Pick<ShareCameraGuard, 'prepare' | 'release'> | null
}

export interface ScreenShareHandle extends ScreenShareState {
  /** Share pressed */
  request: () => void
  /** Stop sharing */
  stop: () => void
  /** Send the share's sound, or not (the sharing bar's switch, e3-t04) */
  toggleAudio: () => void
  /** 文字 or 動態 (e3-t06) */
  setMode: (mode: ShareMode) => void
  /** The page's sampler: the screen keeps moving, or not (e3-t06) */
  noticeMotion: (moving: boolean) => void
  dismissMotionHint: () => void
  /** 換一個畫面 (e3-t09): the picker again, the share goes on */
  repick: () => void
}

const noSubscribe = () => () => {}
const idle = () => idleShare

/**
 * This member's screen share (e3-t01 – e3-t04, e3-t06 – e3-t09): one ScreenShare per mounted
 * room, closed (the capture stopped) on unmount, so StrictMode's mount / unmount / mount leaves
 * one
 */
export function useScreenShare(options: UseScreenShareOptions): ScreenShareHandle {
  const { shares, you, onError, welcomes, guard } = options
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  const [controller, setController] = useState<ScreenShare | null>(null)
  useEffect(() => {
    // The picker offers the tab's or system's sound only where the browser can capture it
    const audio = canShareAudio()
    const run = new ScreenShare({
      capture: () => captureScreen(undefined, audio),
      send: (message) => latest.current.send(message),
      notify: (notice) => latest.current.notify(notice),
      prepare: guard?.prepare,
      released: guard?.release,
    })
    setController(run)
    return () => {
      run.close()
      setController((current) => (current === run ? null : current))
    }
  }, [guard])
  useEffect(() => {
    controller?.setRoom(shares, you)
  }, [controller, shares, you])
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
      stop: () => controller?.stop(),
      toggleAudio: () => controller?.toggleAudio(),
      setMode: (mode: ShareMode) => controller?.setMode(mode),
      noticeMotion: (moving: boolean) => controller?.noticeMotion(moving),
      dismissMotionHint: () => controller?.dismissMotionHint(),
      repick: () => void controller?.repick(),
    }),
    [state, controller],
  )
}

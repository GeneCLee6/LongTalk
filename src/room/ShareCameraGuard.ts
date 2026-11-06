// The camera goes off while sharing where capabilities.ts says so (`shareStopsCamera`, in practice
// Mac Safari). A precaution from what Playwright's Linux WebKit did with a camera and a screen at
// once; real Safari is unverified (ADR-001 「WebKit 同時送鏡頭與分享」, BROWSER-SUPPORT.md §3).
//
// - A screen is picked (ScreenShare's `prepare`): a camera that is on goes off, the person is told,
//   and the share goes ahead once the camera is no longer sent, or after a few seconds regardless:
//   its device is stopped by then, and RoomMedia applies the camera before the screen anyway.
// - During the share the page keeps the camera button disabled; a camera that comes on by itself
//   (a device plugged in, 純音訊模式 ending) goes off again or stays off, and comes back later.
// - The share is over (ScreenShare's `released`): a camera this turned off is restored; one that
//   was off already is not. The page decides what restoring means in 純音訊模式.
//
// No React here, no interface text: the room page passes what to do.

export interface ShareCameraGuardOptions {
  /** The camera is on, or opening */
  cameraOn: () => boolean
  turnOff: () => void
  restore: () => void
  /** The camera was just turned off for a share: say so */
  notify: () => void
  /** How long to wait for the camera to stop being sent */
  waitMs?: number
}

export const CAMERA_OFF_WAIT_MS = 3_000

const NOTHING: ShareCameraGuardOptions = {
  cameraOn: () => false,
  turnOff() {},
  restore() {},
  notify() {},
}

export class ShareCameraGuard {
  private options: ShareCameraGuardOptions
  /** A share is past the picker */
  private engaged = false
  /** The camera comes back when the share is over */
  private holding = false
  private waiter: (() => void) | null = null

  constructor(options: ShareCameraGuardOptions = NOTHING) {
    this.options = options
  }

  /** What to do, with the page's latest state */
  configure(options: ShareCameraGuardOptions): void {
    this.options = options
  }

  /** A share is under way: the camera must stay off until it is over */
  get active(): boolean {
    return this.engaged
  }

  /** A screen was picked: resolves once the share can go ahead */
  prepare = (): Promise<void> => {
    this.engaged = true
    if (!this.options.cameraOn()) return Promise.resolve()
    this.holding = true
    this.options.turnOff()
    this.options.notify()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(), this.options.waitMs ?? CAMERA_OFF_WAIT_MS)
      this.waiter = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /** From what RoomMedia reports: the camera has stopped being sent */
  cameraGone(): void {
    this.settle()
  }

  /** The camera came on during a share (a device plugged in, a retry): off again */
  cameraCameOn(): void {
    if (!this.engaged || !this.options.cameraOn()) return
    this.holding = true
    this.options.turnOff()
  }

  /** The camera would have come back now (純音訊模式 ended): it waits for the share to end */
  hold(): void {
    if (this.engaged) this.holding = true
  }

  /** Someone decided the camera stays off (the host turned it off): it does not come back */
  forget(): void {
    this.holding = false
  }

  /** The share is over */
  release = (): void => {
    this.engaged = false
    this.settle()
    if (!this.holding) return
    this.holding = false
    this.options.restore()
  }

  private settle(): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }
}

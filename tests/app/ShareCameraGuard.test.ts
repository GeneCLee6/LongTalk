import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShareCameraGuard } from '../../src/room/ShareCameraGuard.ts'

// The rules of the camera guard on their own (shareStopsCamera, ADR-001): what goes off, what comes
// back, and when the share may go ahead. tests/app/shareCameraGuardPage.test.tsx runs it in the page.

function setup(camera = true, waitMs?: number) {
  const state = { camera, restored: 0, notified: 0, offs: 0 }
  const guard = new ShareCameraGuard({
    cameraOn: () => state.camera,
    turnOff: () => {
      state.camera = false
      state.offs += 1
    },
    restore: () => {
      state.restored += 1
      state.camera = true
    },
    notify: () => {
      state.notified += 1
    },
    waitMs,
  })
  return { guard, state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ShareCameraGuard', () => {
  it('turns a camera that is on off and says so, and waits until it is no longer sent', async () => {
    const { guard, state } = setup()
    let ready = false
    void guard.prepare().then(() => (ready = true))
    expect(state).toMatchObject({ camera: false, offs: 1, notified: 1 })
    expect(guard.active).toBe(true)
    await Promise.resolve()
    expect(ready).toBe(false)
    guard.cameraGone()
    await vi.waitFor(() => expect(ready).toBe(true))
  })

  it('goes ahead after a while when the camera never reports gone', async () => {
    vi.useFakeTimers()
    const { guard } = setup(true, 1000)
    let ready = false
    void guard.prepare().then(() => (ready = true))
    await vi.advanceTimersByTimeAsync(999)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(ready).toBe(true)
  })

  it('leaves a camera that was off alone: no waiting, no notice, nothing to restore', async () => {
    const { guard, state } = setup(false)
    await guard.prepare()
    expect(state).toMatchObject({ offs: 0, notified: 0 })
    guard.release()
    expect(state.restored).toBe(0)
    expect(state.camera).toBe(false)
  })

  it('restores the camera it turned off, once', async () => {
    const { guard, state } = setup()
    const prepared = guard.prepare()
    guard.cameraGone()
    await prepared
    guard.release()
    expect(state.restored).toBe(1)
    expect(guard.active).toBe(false)
    guard.release()
    expect(state.restored).toBe(1)
  })

  it('ends the wait when the share stops first, and restores', async () => {
    const { guard, state } = setup()
    let ready = false
    void guard.prepare().then(() => (ready = true))
    guard.release()
    await vi.waitFor(() => expect(ready).toBe(true))
    expect(state.restored).toBe(1)
  })

  it('turns off a camera that comes on by itself during a share, and restores it after', async () => {
    const { guard, state } = setup(false)
    await guard.prepare()
    state.camera = true // A device was plugged in, or a retry opened it
    guard.cameraCameOn()
    expect(state.camera).toBe(false)
    expect(state.notified).toBe(0)
    guard.release()
    expect(state.restored).toBe(1)
  })

  it('does nothing about the camera before a share or after it', async () => {
    const { guard, state } = setup()
    guard.cameraCameOn()
    expect(state.offs).toBe(0)
    const prepared = guard.prepare()
    guard.cameraGone()
    await prepared
    guard.release()
    guard.cameraCameOn()
    expect(state.offs).toBe(1)
    expect(state.camera).toBe(true)
  })

  it('keeps a camera that would have come back for the end of the share (純音訊模式 ended)', async () => {
    const { guard, state } = setup(false)
    guard.hold()
    await guard.prepare()
    guard.release()
    expect(state.restored).toBe(0) // No share yet when it was asked: nothing was held
    await guard.prepare()
    guard.hold()
    guard.release()
    expect(state.restored).toBe(1)
  })

  it('does not bring back a camera the host turned off', async () => {
    const { guard, state } = setup()
    const prepared = guard.prepare()
    guard.cameraGone()
    await prepared
    guard.forget()
    guard.release()
    expect(state.restored).toBe(0)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { LocalDevices, type DeviceNotice } from '../../src/room/LocalDevices.ts'
import { defaultDevices, type DeviceChoices } from '../../src/room/session.ts'
import { createFakeStream, fakeMediaDevices, type FakeTrack } from './media/fakeMedia.ts'

// The room's microphone and camera (e2-t05, e2-t06, e2-t09) on a fake navigator.mediaDevices

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(
  options: Parameters<typeof fakeMediaDevices>[0] = {},
  chosen: DeviceChoices = defaultDevices(),
) {
  const fake = fakeMediaDevices(options)
  const notices: DeviceNotice[] = []
  const saved: [string, string][] = []
  const devices = new LocalDevices({
    mediaDevices: fake.devices,
    chosen,
    saveChoice: (kind, id) => saved.push([kind, id]),
    onNotice: (notice) => notices.push(notice),
    createStream: createFakeStream,
    startRetryMs: 0,
  })
  const state = () => devices.getState()
  const track = (kind: 'mic' | 'cam') => state()[kind].track as unknown as FakeTrack | null
  return { fake, devices, notices, saved, state, track }
}

describe('LocalDevices', () => {
  it('opens what the pre-join screen had on, preferring the remembered devices', async () => {
    const t = setup({}, { mic: 'mic-2', cam: null, speaker: 'spk-1' })
    await t.devices.start({ mic: true, cam: true })
    expect(t.fake.getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: { deviceId: { ideal: 'mic-2' } },
      video: true,
    })
    expect(t.state()).toMatchObject({ ready: true, mic: { on: true }, cam: { on: true } })
    expect(t.track('mic')?.deviceId).toBe('mic-2')
    expect(t.state().devices.audioinput).toHaveLength(2)
    expect(LocalDevices.sending(t.state())).toEqual({ mic: t.track('mic'), cam: t.track('cam') })
  })

  it('keeps the microphone open but silent while muted, and stops the camera when off', async () => {
    const t = setup()
    await t.devices.start({ mic: true, cam: true })
    const mic = t.track('mic')!
    const cam = t.track('cam')!
    await t.devices.setOn('mic', false)
    expect(mic).toMatchObject({ stopped: false, enabled: false })
    expect(LocalDevices.sending(t.state()).mic).toBeNull()
    await t.devices.setOn('mic', true)
    expect(t.track('mic')).toBe(mic)
    expect(mic.enabled).toBe(true)
    await t.devices.setOn('cam', false)
    expect(cam.stopped).toBe(true)
    expect(t.state().cam).toMatchObject({ on: false, track: null })
    await t.devices.setOn('cam', true)
    expect(t.track('cam')).not.toBe(cam)
    expect(t.state().cam.on).toBe(true)
  })

  it('opens a device turned on for the first time in the room', async () => {
    const t = setup()
    await t.devices.start({ mic: false, cam: false })
    expect(t.fake.getUserMedia).not.toHaveBeenCalled()
    await t.devices.setOn('mic', true)
    expect(t.state().mic).toMatchObject({ on: true, problem: null })
  })

  it('switches to a picked device, remembers it and stops the old one (e2-t06)', async () => {
    const t = setup()
    await t.devices.start({ mic: true, cam: true })
    const before = t.track('mic')!
    await t.devices.select('mic', 'mic-2')
    expect(t.track('mic')?.deviceId).toBe('mic-2')
    expect(before.stopped).toBe(true)
    expect(t.saved).toEqual([['mic', 'mic-2']])
    expect(t.state().chosen.mic).toBe('mic-2')
    expect(t.fake.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: 'mic-2' } },
      video: false,
    })
    // A muted microphone stays muted on the new device
    await t.devices.setOn('mic', false)
    await t.devices.select('mic', 'mic-1')
    expect(t.state().mic.on).toBe(false)
    expect(t.track('mic')).toMatchObject({ deviceId: 'mic-1', enabled: false })
    // The speaker is only remembered
    await t.devices.select('speaker', 'spk-1')
    expect(t.state().chosen.speaker).toBe('spk-1')
  })

  it('keeps the current device when the picked one will not open', async () => {
    const t = setup()
    await t.devices.start({ mic: true, cam: true })
    const cam = t.track('cam')!
    t.fake.unplug('cam-2')
    await t.devices.select('cam', 'cam-2')
    expect(t.track('cam')).toBe(cam)
    expect(t.state().cam).toMatchObject({ on: true, problem: null })
    expect(t.notices).toEqual([{ type: 'switchFailed', kind: 'cam', problem: 'notFound' }])
  })

  it('moves to another device when one is unplugged mid-call (e2-t06)', async () => {
    const t = setup({}, { mic: 'mic-2', cam: null, speaker: null })
    await t.devices.start({ mic: true, cam: false })
    t.fake.unplug('mic-2')
    await settle()
    await settle()
    expect(t.track('mic')?.deviceId).toBe('mic-1')
    expect(t.state().mic).toMatchObject({ on: true, problem: null })
    expect(t.notices).toContainEqual({
      type: 'switched',
      kind: 'mic',
      label: 'Built-in Microphone',
    })
    expect(t.state().devices.audioinput.map((d) => d.deviceId)).toEqual(['mic-1'])
  })

  it('turns off with `lost` when the last device is unplugged, and comes back when plugged in', async () => {
    const t = setup()
    await t.devices.start({ mic: false, cam: true })
    t.fake.unplug('cam-2')
    t.fake.unplug('cam-1')
    await settle()
    await settle()
    expect(t.state().cam).toMatchObject({ on: false, track: null, problem: 'lost' })
    t.fake.plug('cam-2')
    await vi.waitFor(() => expect(t.state().cam).toMatchObject({ on: true, problem: null }))
    expect(t.track('cam')?.deviceId).toBe('cam-2')
  })

  it('reports why a device would not open, and retries (e2-t09)', async () => {
    const t = setup({ fail: { video: 'NotReadableError' } })
    await t.devices.start({ mic: true, cam: true })
    expect(t.state().mic).toMatchObject({ on: true, problem: null })
    expect(t.state().cam).toMatchObject({ on: false, problem: 'inUse' })
    await t.devices.retry('cam')
    expect(t.state().cam.problem).toBe('inUse')
    await t.devices.setOn('cam', false)
    expect(t.state().cam.problem).toBeNull()
  })

  it('reports a refusal and no device support', async () => {
    const denied = setup({ denyAll: true })
    await denied.devices.start({ mic: true, cam: true })
    expect(denied.state().mic.problem).toBe('denied')
    expect(denied.state().cam.problem).toBe('denied')
    const none = new LocalDevices({ mediaDevices: null, chosen: defaultDevices() })
    await none.start({ mic: true, cam: false })
    expect(none.getState().mic.problem).toBe('unsupported')
  })

  it('lets the button win over a slower first opening, and stops everything on close', async () => {
    const t = setup()
    const started = t.devices.start({ mic: true, cam: true })
    await t.devices.setOn('cam', false)
    await started
    expect(t.state().cam.on).toBe(false)
    expect(
      t.fake
        .tracks()
        .filter((x) => x.kind === 'video')
        .every((x) => x.stopped),
    ).toBe(true)
    t.devices.close()
    expect(t.fake.tracks().every((x) => x.stopped)).toBe(true)
    expect(t.fake.listeners.size).toBe(0)
  })
})

describe('LocalDevices: opening right after the pre-join preview', () => {
  it('tries a camera that was briefly not found once more, quietly', async () => {
    const t = setup()
    const real = t.fake.getUserMedia.getMockImplementation()!
    const notFound = Object.assign(new Error('gone'), { name: 'NotFoundError' })
    // The combined request and the camera on its own fail; the retry finds it
    t.fake.getUserMedia
      .mockImplementationOnce(async () => Promise.reject(notFound))
      .mockImplementationOnce(real)
      .mockImplementationOnce(async () => Promise.reject(notFound))
    await t.devices.start({ mic: true, cam: true })
    expect(t.state().cam).toMatchObject({ on: true, problem: null })
    expect(t.state().mic.on).toBe(true)
  })

  it('does not retry a refusal', async () => {
    const t = setup({ denyAll: true })
    await t.devices.start({ mic: true, cam: true })
    expect(t.fake.getUserMedia).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  activeDeviceId,
  listDevices,
  MediaOpenError,
  mediaProblem,
  openDevice,
  openLocalMedia,
  setSpeaker,
  stopStream,
} from '../../../src/media/devices.ts'
import {
  createLevelMeter,
  levelFromSamples,
  type AudioContextLike,
} from '../../../src/media/levelMeter.ts'
import {
  FakeStream,
  FakeTrack,
  asStream,
  createFakeStream,
  fakeMediaDevices,
  mediaError,
} from './fakeMedia.ts'

const both = { mic: true, cam: true, micId: null, camId: null }

describe('listDevices', () => {
  it('groups devices by kind in the browser order', async () => {
    const { devices } = fakeMediaDevices()
    const lists = await listDevices(devices)
    expect(lists.audioinput.map((d) => d.deviceId)).toEqual(['mic-1', 'mic-2'])
    expect(lists.videoinput).toEqual([
      { deviceId: 'cam-1', label: 'FaceTime HD Camera' },
      { deviceId: 'cam-2', label: '' },
    ])
    expect(lists.audiooutput).toEqual([{ deviceId: 'spk-1', label: 'Speakers' }])
  })

  it('leaves out entries without an id (no permission yet)', async () => {
    const { devices } = fakeMediaDevices({ hidden: true })
    expect(await listDevices(devices)).toEqual({ audioinput: [], videoinput: [], audiooutput: [] })
  })
})

describe('mediaProblem', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'notFound'],
    ['OverconstrainedError', 'notFound'],
    ['NotReadableError', 'inUse'],
    ['AbortError', 'inUse'],
    ['TypeError', 'unknown'],
  ] as const)('maps %s to %s', (name, problem) => {
    expect(mediaProblem(mediaError(name))).toBe(problem)
  })

  it('copes with things that are not errors', () => {
    expect(mediaProblem('nope')).toBe('unknown')
    expect(mediaProblem(null)).toBe('unknown')
  })
})

describe('openLocalMedia', () => {
  it('opens the microphone and camera in one request', async () => {
    const fake = fakeMediaDevices()
    const media = await openLocalMedia(fake.devices, both)
    expect(fake.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: true })
    expect(media.micProblem).toBeNull()
    expect(media.camProblem).toBeNull()
    expect(activeDeviceId(media.stream, 'audio')).toBe('mic-1')
    expect(activeDeviceId(media.stream, 'video')).toBe('cam-1')
  })

  it('prefers the chosen devices, and asks only for the ones switched on', async () => {
    const fake = fakeMediaDevices()
    await openLocalMedia(fake.devices, { mic: true, cam: false, micId: 'mic-2', camId: 'cam-2' })
    expect(fake.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { ideal: 'mic-2' } },
      video: false,
    })
  })

  it('falls back to another device when the remembered one is gone (e2-t06)', async () => {
    const fake = fakeMediaDevices()
    fake.unplug('mic-2')
    const media = await openLocalMedia(fake.devices, { ...both, cam: false, micId: 'mic-2' })
    expect(activeDeviceId(media.stream, 'audio')).toBe('mic-1')
  })

  it('asks for nothing when both are off', async () => {
    const fake = fakeMediaDevices()
    const media = await openLocalMedia(fake.devices, { ...both, mic: false, cam: false })
    expect(media).toEqual({ stream: null, micProblem: null, camProblem: null })
    expect(fake.getUserMedia).not.toHaveBeenCalled()
  })

  it('reports a refusal for both without asking again', async () => {
    const fake = fakeMediaDevices({ denyAll: true })
    const media = await openLocalMedia(fake.devices, both)
    expect(media).toEqual({ stream: null, micProblem: 'denied', camProblem: 'denied' })
    expect(fake.getUserMedia).toHaveBeenCalledOnce()
  })

  it('still opens the microphone on a computer without a camera', async () => {
    const fake = fakeMediaDevices({ fail: { video: 'NotFoundError' } })
    const media = await openLocalMedia(fake.devices, both, createFakeStream)
    expect(fake.getUserMedia).toHaveBeenCalledTimes(3)
    expect(media.micProblem).toBeNull()
    expect(media.camProblem).toBe('notFound')
    expect(media.stream?.getAudioTracks()).toHaveLength(1)
    expect(media.stream?.getVideoTracks()).toHaveLength(0)
  })

  it('reports a camera held by another program', async () => {
    const fake = fakeMediaDevices({ fail: { video: 'NotReadableError' } })
    const media = await openLocalMedia(fake.devices, { ...both, mic: false })
    expect(media).toEqual({ stream: null, micProblem: null, camProblem: 'inUse' })
  })

  it('reports no device support (an http: page)', async () => {
    expect(await openLocalMedia(null, both)).toEqual({
      stream: null,
      micProblem: 'unsupported',
      camProblem: 'unsupported',
    })
  })

  it('stops every track of a stream', () => {
    const tracks = [new FakeTrack('audio', 'a'), new FakeTrack('video', 'v')]
    stopStream(asStream(new FakeStream(tracks)))
    stopStream(null)
    expect(tracks.every((track) => track.stopped)).toBe(true)
  })
})

describe('openDevice (e2-t06)', () => {
  it('requires the device the person picked, or only prefers a remembered one', async () => {
    const fake = fakeMediaDevices()
    const track = await openDevice(fake.devices, 'video', 'cam-2', true)
    expect(track.getSettings().deviceId).toBe('cam-2')
    expect(fake.getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { deviceId: { exact: 'cam-2' } },
    })
    fake.unplug('cam-2')
    await expect(openDevice(fake.devices, 'video', 'cam-2', true)).rejects.toMatchObject({
      problem: 'notFound',
    })
    expect((await openDevice(fake.devices, 'video', 'cam-2')).getSettings().deviceId).toBe('cam-1')
  })

  it('says why a device did not open', async () => {
    await expect(openDevice(null, 'audio', null)).rejects.toMatchObject({ problem: 'unsupported' })
    const denied = fakeMediaDevices({ denyAll: true })
    await expect(openDevice(denied.devices, 'audio', null)).rejects.toMatchObject({
      problem: 'denied',
    })
    const busy = fakeMediaDevices({ fail: { video: 'NotReadableError' } })
    await expect(openDevice(busy.devices, 'video', null)).rejects.toBeInstanceOf(MediaOpenError)
  })

  it('plays through the chosen speaker where the browser can', () => {
    const setSinkId = vi.fn(async () => {})
    const element = { setSinkId } as unknown as HTMLMediaElement
    setSpeaker(element, 'spk-1')
    setSpeaker(element, null)
    setSpeaker({} as HTMLMediaElement, 'spk-1')
    setSpeaker(null, 'spk-1')
    expect(setSinkId).toHaveBeenCalledExactlyOnceWith('spk-1')
  })
})

describe('level meter', () => {
  it('maps silence to 0, full scale to 1 and −30 dB to the middle', () => {
    expect(levelFromSamples(new Float32Array(128))).toBe(0)
    expect(levelFromSamples(new Float32Array(0))).toBe(0)
    expect(levelFromSamples(new Float32Array(128).fill(1))).toBe(1)
    const rms = 10 ** (-30 / 20)
    expect(levelFromSamples(new Float32Array(128).fill(rms))).toBeCloseTo(0.5, 5)
    expect(levelFromSamples(new Float32Array(128).fill(1e-5))).toBe(0)
  })

  function fakeContext(value: number) {
    const close = vi.fn(async () => {})
    const disconnect = vi.fn()
    const context: AudioContextLike = {
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect }),
      createAnalyser: () => ({
        fftSize: 2048,
        getFloatTimeDomainData: (array) => array.fill(value),
      }),
      close,
    }
    return { context, close, disconnect }
  }

  it('reads the level of the stream and closes its audio context', () => {
    const fake = fakeContext(1)
    const stream = asStream(new FakeStream([new FakeTrack('audio', 'mic-1')]))
    const meter = createLevelMeter(stream, () => fake.context)!
    expect(meter.read()).toBe(1)
    meter.close()
    expect(fake.disconnect).toHaveBeenCalled()
    expect(fake.close).toHaveBeenCalled()
  })

  it('has nothing to measure without audio or Web Audio', () => {
    const video = asStream(new FakeStream([new FakeTrack('video', 'cam-1')]))
    const audio = asStream(new FakeStream([new FakeTrack('audio', 'mic-1')]))
    expect(createLevelMeter(video, () => fakeContext(1).context)).toBeNull()
    expect(createLevelMeter(audio, () => null)).toBeNull()
  })
})

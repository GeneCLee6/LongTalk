import { describe, expect, it, vi } from 'vitest'
import {
  applyProcessing,
  DEFAULT_PROCESSING,
  processingConstraints,
} from '../../../src/media/audioProcessing.ts'
import { audioProcessingSupport } from '../../../src/media/capabilities.ts'
import { openDevice, openLocalMedia } from '../../../src/media/devices.ts'
import { SIMULCAST, simulcastEncodings, withTopLayer } from '../../../src/media/encoding.ts'
import {
  MUTED_HINT_COOLDOWN_MS,
  MUTED_SPEECH_GAP_MS,
  MUTED_SPEECH_MS,
  nextMutedSpeech,
  NO_MUTED_SPEECH,
  PUSH_TO_TALK_GRACE_MS,
  type MutedSpeechState,
} from '../../../src/media/mutedSpeech.ts'
import {
  HD_MIN_UPLINK_BPS,
  nextUplinkCheck,
  readUplink,
  startUplinkCheck,
  UPLINK_LOW_SAMPLES,
  UPLINK_RETRY_MAX_MS,
  UPLINK_RETRY_MS,
  UPLINK_WARMUP_MS,
  uplinkRetryWait,
} from '../../../src/media/uplink.ts'
import { createFakeStream, fakeMediaDevices } from './fakeMedia.ts'

// H3's media pieces as pure functions: the microphone's processing switches (e6-t01), the
// speaking-while-muted detector (e6-t03), HD's top layer and the uplink check (e6-t04).

describe('microphone processing (e6-t01)', () => {
  it('asks getUserMedia only for the switches turned off', () => {
    expect(processingConstraints(DEFAULT_PROCESSING)).toEqual({})
    expect(processingConstraints({ ...DEFAULT_PROCESSING, noiseSuppression: false })).toEqual({
      noiseSuppression: false,
    })
  })

  it('opens the microphone with them, on top of the device', async () => {
    const fake = fakeMediaDevices()
    const processing = { ...DEFAULT_PROCESSING, echoCancellation: false }
    await openLocalMedia(
      fake.devices,
      { mic: true, cam: false, micId: 'mic-2', camId: null, processing },
      createFakeStream,
    )
    expect(fake.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { ideal: 'mic-2' }, echoCancellation: false },
      video: false,
    })
    await openDevice(fake.devices, 'audio', null, false, processing)
    expect(fake.getUserMedia).toHaveBeenLastCalledWith({
      audio: { echoCancellation: false },
      video: false,
    })
  })

  it('applies them live and keeps the track’s device constraint', async () => {
    const settings: Record<string, unknown> = { deviceId: 'mic-1', noiseSuppression: true }
    const track = {
      applyConstraints: vi.fn(async (c: MediaTrackConstraints) => {
        settings.noiseSuppression = c.noiseSuppression
      }),
      getConstraints: () => ({ deviceId: { exact: 'mic-1' } }),
      getSettings: () => settings as MediaTrackSettings,
    }
    const off = { ...DEFAULT_PROCESSING, noiseSuppression: false }
    expect(await applyProcessing(track, off)).toBe(true)
    expect(track.applyConstraints).toHaveBeenCalledWith({
      deviceId: { exact: 'mic-1' },
      ...off,
    })
  })

  it('says so when the browser keeps the old values or refuses', async () => {
    const ignoring = {
      applyConstraints: vi.fn(async () => {}),
      getSettings: () => ({ noiseSuppression: true }) as MediaTrackSettings,
    }
    const off = { ...DEFAULT_PROCESSING, noiseSuppression: false }
    expect(await applyProcessing(ignoring, off)).toBe(false)
    const refusing = { applyConstraints: vi.fn(async () => Promise.reject(new Error('no'))) }
    expect(await applyProcessing(refusing, off)).toBe(false)
    expect(await applyProcessing({}, off)).toBe(false)
  })

  it('finds the switches this browser knows', () => {
    const env = (supported: Record<string, boolean>) => ({
      navigator: { mediaDevices: { getSupportedConstraints: () => supported } },
    })
    expect(audioProcessingSupport(env({ echoCancellation: true, deviceId: true }))).toEqual([
      'echoCancellation',
    ])
    expect(
      audioProcessingSupport(
        env({ noiseSuppression: true, echoCancellation: true, autoGainControl: true }),
      ),
    ).toEqual(['noiseSuppression', 'echoCancellation', 'autoGainControl'])
    expect(audioProcessingSupport({ navigator: { mediaDevices: {} } })).toEqual([])
    expect(audioProcessingSupport({})).toEqual([])
  })
})

describe('speaking while muted (e6-t03)', () => {
  const LOUD = 0.8
  const QUIET = 0.05
  /** Feeds readings every 100 ms; returns the times a hint showed */
  function run(
    readings: { level: number; muted?: boolean; pushToTalk?: boolean }[],
    start: MutedSpeechState = NO_MUTED_SPEECH,
  ) {
    let state = start
    const hints: number[] = []
    readings.forEach((reading, i) => {
      const now = 1000 + i * 100
      const next = nextMutedSpeech(state, {
        level: reading.level,
        now,
        muted: reading.muted ?? true,
        pushToTalk: reading.pushToTalk ?? false,
      })
      state = next.state
      if (next.hint) hints.push(now - 1000)
    })
    return { hints, state }
  }
  const loud = (ms: number, extra = {}) =>
    Array.from({ length: ms / 100 }, () => ({ level: LOUD, ...extra }))
  const quiet = (ms: number, extra = {}) =>
    Array.from({ length: ms / 100 }, () => ({ level: QUIET, ...extra }))

  it('shows the hint after 2 s of speech while muted', () => {
    const { hints } = run(loud(3000))
    expect(hints).toEqual([MUTED_SPEECH_MS])
  })

  it('counts through short pauses between words, starts over after a longer silence', () => {
    expect(
      run([...loud(1000), ...quiet(MUTED_SPEECH_GAP_MS - 100), ...loud(1500)]).hints,
    ).toHaveLength(1)
    expect(run([...loud(1500), ...quiet(1000), ...loud(1500)]).hints).toEqual([])
  })

  it('never while unmuted', () => {
    expect(run(loud(5000, { muted: false })).hints).toEqual([])
  })

  it('waits out the cooldown before the next hint', () => {
    const first = run(loud(2500))
    expect(first.hints).toHaveLength(1)
    // Still speaking: no second hint until the cooldown has passed
    const again = run(loud(MUTED_HINT_COOLDOWN_MS - 3000), first.state)
    expect(again.hints).toEqual([])
    expect(first.state.quietUntil).toBe(1000 + MUTED_SPEECH_MS + MUTED_HINT_COOLDOWN_MS)
  })

  it('never while push-to-talk is held, nor just after it is let go', () => {
    expect(run(loud(5000, { pushToTalk: true })).hints).toEqual([])
    const held = run(loud(1000, { pushToTalk: true }))
    expect(held.state.quietUntil).toBeGreaterThanOrEqual(1000 + 900 + PUSH_TO_TALK_GRACE_MS)
    // Let go and still talking (the end of a sentence): the grace swallows it...
    const after = run(loud(MUTED_SPEECH_MS), held.state)
    expect(after.hints).toEqual([])
  })
})

describe('HD: the camera’s top layer (e6-t04)', () => {
  it('turns the 720p layer off for medium, keeping the lower two', () => {
    const encodings = simulcastEncodings('cam')
    expect(withTopLayer(encodings, 'cam', 'medium').map((e) => [e.rid, e.active])).toEqual([
      ['f', false],
      ['h', true],
      ['q', true],
    ])
    expect(withTopLayer(encodings, 'cam', 'high').every((e) => e.active)).toBe(true)
    // The lowest layer always stays on
    expect(withTopLayer(encodings, 'cam', 'low').map((e) => e.active)).toEqual([false, false, true])
  })

  it('scales a single-layer sender down instead', () => {
    const [single] = withTopLayer([{ maxBitrate: 800_000 }], 'cam', 'medium')
    expect(single).toMatchObject({
      scaleResolutionDownBy: 2,
      maxBitrate: SIMULCAST.cam[1].maxBitrate,
    })
    const [back] = withTopLayer([single], 'cam', 'high')
    expect(back).toMatchObject({ scaleResolutionDownBy: 1, maxBitrate: 800_000 })
  })
})

describe('the uplink check (e6-t04)', () => {
  const short = { availableOutgoingBitrate: HD_MIN_UPLINK_BPS - 1, limitation: 'none' as const }
  const good = { availableOutgoingBitrate: HD_MIN_UPLINK_BPS * 2, limitation: 'none' as const }
  const limited = { availableOutgoingBitrate: null, limitation: 'bandwidth' as const }

  it('is not judged during the warm-up', () => {
    const check = startUplinkCheck(0)
    expect(nextUplinkCheck(check, short, UPLINK_WARMUP_MS - 1)).toEqual({ check, holdBack: false })
  })

  it('holds HD back after several short samples in a row, by estimate or by limitation', () => {
    for (const sample of [short, limited]) {
      let check = startUplinkCheck(0)
      let holdBack = false
      for (let i = 1; i <= UPLINK_LOW_SAMPLES; i++) {
        ;({ check, holdBack } = nextUplinkCheck(check, sample, UPLINK_WARMUP_MS + i))
      }
      expect(holdBack).toBe(true)
    }
  })

  it('starts counting again after a good sample', () => {
    let check = startUplinkCheck(0)
    const at = UPLINK_WARMUP_MS
    ;({ check } = nextUplinkCheck(check, short, at))
    ;({ check } = nextUplinkCheck(check, good, at + 1))
    expect(check.low).toBe(0)
    const unknown = { availableOutgoingBitrate: null, limitation: null }
    expect(nextUplinkCheck(check, unknown, at + 2).holdBack).toBe(false)
  })

  it('waits longer each time HD is held back again', () => {
    expect(uplinkRetryWait(1)).toBe(UPLINK_RETRY_MS)
    expect(uplinkRetryWait(2)).toBe(UPLINK_RETRY_MS * 2)
    expect(uplinkRetryWait(20)).toBe(UPLINK_RETRY_MAX_MS)
  })

  it('reads the worst limitation and the selected pair’s estimate from a stats report', () => {
    const sender = [
      {
        type: 'outbound-rtp',
        kind: 'video',
        rid: 'f',
        active: false,
        qualityLimitationReason: 'bandwidth',
      },
      { type: 'outbound-rtp', kind: 'video', rid: 'h', qualityLimitationReason: 'cpu' },
      { type: 'outbound-rtp', kind: 'video', rid: 'q', qualityLimitationReason: 'none' },
    ]
    const pc = [
      { type: 'candidate-pair', nominated: false, state: 'succeeded', availableOutgoingBitrate: 1 },
      {
        type: 'candidate-pair',
        nominated: true,
        state: 'succeeded',
        availableOutgoingBitrate: 2_400_000,
      },
    ]
    // The inactive layer's limitation does not count
    expect(readUplink(sender, pc)).toEqual({
      availableOutgoingBitrate: 2_400_000,
      limitation: 'cpu',
    })
    expect(readUplink([])).toEqual({ availableOutgoingBitrate: null, limitation: null })
  })
})

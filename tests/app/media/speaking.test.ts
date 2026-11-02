import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioContextLike } from '../../../src/media/levelMeter.ts'
import {
  nextSpeaking,
  QUIET,
  SPEAKING_INTERVAL_MS,
  SPEAKING_RELEASE_MS,
  SpeakingMonitor,
  type SpeakingState,
} from '../../../src/media/speaking.ts'
import { useSpeaking } from '../../../src/room/useSpeaking.ts'
import { FakeStream, FakeTrack } from './fakeMedia.ts'

const LOUD = 0.8
const SILENT = 0

/** Feeds readings every 100 ms from t = 0 and gives the speaking flag after each */
function run(levels: number[], from: SpeakingState = QUIET): boolean[] {
  let state = from
  return levels.map((level, i) => {
    state = nextSpeaking(state, level, i * SPEAKING_INTERVAL_MS)
    return state.speaking
  })
}

describe('nextSpeaking (e4-t05: threshold and 300 ms debounce)', () => {
  it('starts at the first loud reading', () => {
    expect(run([SILENT, LOUD, LOUD])).toEqual([false, true, true])
  })

  it('holds through pauses shorter than 300 ms and stops after', () => {
    const speaking = run([LOUD, SILENT, SILENT, LOUD, SILENT, SILENT, SILENT, SILENT])
    expect(speaking).toEqual([true, true, true, true, true, true, true, false])
    // The release is the debounce
    expect(SPEAKING_RELEASE_MS).toBe(300)
  })

  it('treats a quiet room as not speaking', () => {
    expect(run([0.1, 0.2, 0.3, 0.2]).some(Boolean)).toBe(false)
  })
})

describe('SpeakingMonitor', () => {
  let level = 0
  let now = 0
  let tick: (() => void) | null = null
  const created: Array<{ close: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> =
    []

  function fakeContext(): AudioContextLike {
    const close = vi.fn(async () => {})
    const disconnect = vi.fn()
    created.push({ close, disconnect })
    return {
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect }),
      createAnalyser: () => ({
        fftSize: 1024,
        getFloatTimeDomainData: (array) => array.fill(level),
      }),
      close,
    }
  }

  const monitor = () =>
    new SpeakingMonitor({
      createContext: fakeContext,
      now: () => now,
      setInterval: (callback) => {
        tick = callback
        return 1
      },
      clearInterval: () => {
        tick = null
      },
      hidden: () => false,
    })

  /** One reading of everything, 100 ms later */
  const advance = () => {
    now += SPEAKING_INTERVAL_MS
    tick?.()
  }

  beforeEach(() => {
    level = 0
    now = 0
    tick = null
    created.length = 0
    vi.stubGlobal('MediaStream', FakeStream)
  })
  afterEach(() => vi.unstubAllGlobals())

  const track = () => new FakeTrack('audio', 'mic') as unknown as MediaStreamTrack

  it('shares one context and one timer, tells listeners only of changes, and cleans up', () => {
    const speaking = monitor()
    const a = track()
    const b = track()
    const heardA: boolean[] = []
    const heardB: boolean[] = []
    const stopA = speaking.watch(a, (on) => heardA.push(on))
    const stopB = speaking.watch(b, (on) => heardB.push(on))
    expect(created).toHaveLength(1)
    expect(tick).not.toBeNull()

    level = 1
    advance()
    advance()
    expect(heardA).toEqual([true])
    expect(heardB).toEqual([true])
    level = 0
    for (let i = 0; i < 5; i++) advance()
    expect(heardA).toEqual([true, false])

    stopA()
    expect(created[0].disconnect).toHaveBeenCalledOnce()
    expect(created[0].close).not.toHaveBeenCalled()
    stopB()
    expect(created[0].close).toHaveBeenCalledOnce()
    expect(tick).toBeNull()
  })

  it('backs the useSpeaking hook, which starts quiet for a new track', () => {
    const speaking = monitor()
    const mic = track()
    const { result, rerender } = renderHook(({ t }) => useSpeaking(t, speaking), {
      initialProps: { t: mic as MediaStreamTrack | null },
    })
    expect(result.current).toBe(false)
    level = 1
    act(() => advance())
    expect(result.current).toBe(true)
    rerender({ t: null })
    expect(result.current).toBe(false)
    expect(tick).toBeNull()
  })
})

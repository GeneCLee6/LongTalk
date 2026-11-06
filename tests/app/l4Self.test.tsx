import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemberAudio } from '../../src/components/MemberAudio.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { SelfView } from '../../src/components/SelfView.tsx'
import { SettingsDialog, type SettingsDialogProps } from '../../src/components/SettingsDialog.tsx'
import { Tile } from '../../src/components/Tile.tsx'
import { DEFAULT_PROCESSING } from '../../src/media/audioProcessing.ts'
import {
  canBlurBackground,
  blurPath,
  canSetMemberVolume,
  type CapabilityEnv,
} from '../../src/media/capabilities.ts'
import type { AudioContextLike } from '../../src/media/levelMeter.ts'
import {
  VolumeBooster,
  clampVolume,
  volumeRouting,
  type BoostContext,
  type BoostEnv,
} from '../../src/media/memberVolume.ts'
import { SpeakingMonitor } from '../../src/media/speaking.ts'
import {
  loadMemberVolumes,
  saveMemberVolumes,
  shareVolumeKey,
} from '../../src/room/memberVolumes.ts'
import {
  SELF_VIEW_KEY_BIG_PX,
  SELF_VIEW_KEY_PX,
  SELF_VIEW_START,
  clampSelfView,
  floatsSelf,
  moveSelfView,
  selfViewKey,
} from '../../src/room/selfView.ts'
import { loadMediaPrefs, saveMediaPrefs, DEFAULT_MEDIA } from '../../src/room/session.ts'
import { strings } from '../../src/strings.ts'
import type { Member } from '../../shared/protocol.ts'

// L4: mirroring and the floating self view (e6-t07), each person's meter and volume (e6-t08), and
// the capabilities they (and the blur) ask for.

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('capabilities', () => {
  const simd = { validate: () => true }
  const base = (changes: Partial<CapabilityEnv> = {}): CapabilityEnv => ({
    Worker: class {},
    OffscreenCanvas: class {},
    WebAssembly: simd,
    MediaStreamTrackProcessor: class {},
    MediaStreamTrackGenerator: class {},
    VideoFrame: class {},
    HTMLCanvasElement: class {
      captureStream() {}
    },
    ...changes,
  })

  it('the blur takes Insertable Streams where it has them, else a captured canvas', () => {
    expect(blurPath(base())).toBe('insertable')
    expect(blurPath(base({ MediaStreamTrackGenerator: undefined }))).toBe('canvas')
    expect(blurPath(base({ VideoFrame: undefined }))).toBe('canvas')
  })

  it('no blur without a worker, OffscreenCanvas, SIMD, or a way to send frames', () => {
    expect(canBlurBackground(base())).toBe(true)
    expect(canBlurBackground(base({ Worker: undefined }))).toBe(false)
    expect(canBlurBackground(base({ OffscreenCanvas: undefined }))).toBe(false)
    expect(canBlurBackground(base({ WebAssembly: { validate: () => false } }))).toBe(false)
    expect(canBlurBackground(base({ WebAssembly: undefined }))).toBe(false)
    expect(
      canBlurBackground(
        base({ MediaStreamTrackProcessor: undefined, HTMLCanvasElement: { prototype: {} } }),
      ),
    ).toBe(false)
  })

  it('the volume needs an <audio>.volume that takes a value (iOS keeps it at 1)', () => {
    const writable = { document: { createElement: () => ({ volume: 1 }) } }
    expect(canSetMemberVolume(writable)).toBe(true)
    const ios = {
      document: {
        createElement: () => ({
          get volume() {
            return 1
          },
          set volume(_value: number) {},
        }),
      },
    }
    expect(canSetMemberVolume(ios)).toBe(false)
    expect(canSetMemberVolume({})).toBe(false)
  })
})

describe('the settings panel', () => {
  const props = (changes: Partial<SettingsDialogProps> = {}): SettingsDialogProps => ({
    phone: false,
    onClose: () => {},
    initialTab: 'video',
    devices: { audioinput: [], videoinput: [], audiooutput: [] },
    selected: { mic: null, cam: null, speaker: null },
    onSelect: () => {},
    speakerSupported: false,
    processing: DEFAULT_PROCESSING,
    processingSupported: [],
    onProcessing: () => {},
    hd: true,
    onHd: () => {},
    audioOnly: false,
    onAudioOnly: () => {},
    ...changes,
  })

  it('hides the blur where it cannot run', () => {
    render(<SettingsDialog {...props({ blurSupported: false, onBlur: () => {} })} />)
    expect(screen.queryByRole('switch', { name: strings.settings.blur })).toBeNull()
  })

  it('offers the blur, and says when 省電模式 holds it off (the choice stays)', () => {
    const onBlur = vi.fn()
    render(
      <SettingsDialog
        {...props({ blurSupported: true, blur: true, onBlur, powerSaving: true })}
      />,
    )
    const toggle = screen.getByRole('switch', { name: strings.settings.blur })
    expect(toggle).toBeChecked()
    expect(screen.getByText(strings.settings.blurPowerSaving)).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(onBlur).toHaveBeenCalledWith(false)
  })

  it('mirror and self view', () => {
    const onMirror = vi.fn()
    const onSelfView = vi.fn()
    render(
      <SettingsDialog {...props({ mirror: true, onMirror, selfView: false, onSelfView })} />,
    )
    fireEvent.click(screen.getByRole('switch', { name: strings.settings.mirror }))
    expect(onMirror).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('switch', { name: strings.settings.selfView }))
    expect(onSelfView).toHaveBeenCalledWith(true)
  })
})

describe('remembered', () => {
  it('defaults: blur off, mirror on, self view off in the bottom right', () => {
    expect(loadMediaPrefs()).toEqual(DEFAULT_MEDIA)
    expect(DEFAULT_MEDIA).toMatchObject({
      blur: false,
      mirror: true,
      selfView: false,
      selfViewAt: SELF_VIEW_START,
    })
  })

  it('keeps them, and a place out of range comes back inside', () => {
    saveMediaPrefs({
      ...DEFAULT_MEDIA,
      blur: true,
      mirror: false,
      selfView: true,
      selfViewAt: { x: 3, y: -1 },
    })
    expect(loadMediaPrefs()).toMatchObject({
      blur: true,
      mirror: false,
      selfView: true,
      selfViewAt: { x: 1, y: 0 },
    })
  })
})

describe('mirroring', () => {
  const video = { id: 'cam' } as unknown as MediaStreamTrack
  const transformOf = () => getComputedStyle(screen.getByLabelText(/畫面|鏡頭|視訊/, { selector: 'video' })).transform

  it('our own tile follows the setting; nobody else’s is ever mirrored', () => {
    const { rerender } = render(<Tile name="Ada" you video={video} />)
    expect(transformOf()).toBe('scaleX(-1)')
    rerender(<Tile name="Ada" you mirrored={false} video={video} />)
    expect(transformOf()).toBe('none')
    rerender(<Tile name="Bob" video={video} />)
    expect(transformOf()).toBe('none')
  })
})

describe('where the self view sits', () => {
  it('stays inside the stage whatever the move', () => {
    expect(moveSelfView({ x: 0.5, y: 0.5 }, 100, -50, 1000, 500)).toEqual({ x: 0.6, y: 0.4 })
    expect(moveSelfView({ x: 1, y: 1 }, 5000, 5000, 1000, 500)).toEqual({ x: 1, y: 1 })
    expect(moveSelfView({ x: 0, y: 0 }, -5000, -5000, 1000, 500)).toEqual({ x: 0, y: 0 })
    // No free space on an axis: it stays
    expect(moveSelfView({ x: 0.5, y: 0.5 }, 100, 100, 0, -10)).toEqual({ x: 0.5, y: 0.5 })
    expect(clampSelfView({ x: Number.NaN, y: 2 })).toEqual({ x: 1, y: 1 })
  })

  it('the arrow keys, Shift for bigger steps', () => {
    expect(selfViewKey('ArrowLeft', false)).toEqual({ dx: -SELF_VIEW_KEY_PX, dy: 0 })
    expect(selfViewKey('ArrowDown', true)).toEqual({ dx: 0, dy: SELF_VIEW_KEY_BIG_PX })
    expect(selfViewKey('Enter', false)).toBeNull()
  })

  it('floats only with someone else to look at, and not while we are the big tile', () => {
    const base = { wanted: true, you: 'me', shown: ['me', 'bob'], focus: 'bob' }
    expect(floatsSelf(base)).toBe(true)
    expect(floatsSelf({ ...base, wanted: false })).toBe(false)
    expect(floatsSelf({ ...base, shown: ['me'] })).toBe(false)
    expect(floatsSelf({ ...base, focus: 'me' })).toBe(false)
    // Hidden from the stage (隱藏自己): nothing to float
    expect(floatsSelf({ ...base, shown: ['bob'] })).toBe(false)
    expect(floatsSelf({ ...base, you: null })).toBe(false)
  })

  function renderSelfView(onMove = vi.fn()) {
    render(
      <div data-testid="stage">
        <SelfView at={{ x: 0.5, y: 0.5 }} onMove={onMove}>
          <button type="button">inside</button>
        </SelfView>
      </div>,
    )
    const box = screen.getByRole('group', { name: strings.selfView.label })
    // jsdom lays nothing out: a 1000 × 500 stage with a 200 × 100 tile
    const stage = box.parentElement!
    Object.defineProperty(stage, 'clientWidth', { value: 1000 })
    Object.defineProperty(stage, 'clientHeight', { value: 500 })
    Object.defineProperty(box, 'offsetWidth', { value: 200 })
    Object.defineProperty(box, 'offsetHeight', { value: 100 })
    return { onMove, box }
  }

  it('moves with the keyboard, remembering each step', () => {
    const { onMove } = renderSelfView()
    fireEvent.keyDown(screen.getByRole('button', { name: strings.selfView.move }), {
      key: 'ArrowRight',
    })
    expect(onMove).toHaveBeenCalledWith({ x: 0.5 + SELF_VIEW_KEY_PX / 800, y: 0.5 })
  })

  it('drags, and tells the page only at the end', () => {
    const { onMove, box } = renderSelfView()
    fireEvent.pointerDown(box, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 180, clientY: 140 })
    expect(onMove).not.toHaveBeenCalled()
    fireEvent.pointerUp(box, { pointerId: 1 })
    expect(onMove).toHaveBeenCalledWith({ x: 0.6, y: 0.6 })
  })

  it('a press on a button inside is not a drag', () => {
    const { onMove, box } = renderSelfView()
    fireEvent.pointerDown(within(box).getByRole('button', { name: 'inside' }), {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    })
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 180, clientY: 140 })
    fireEvent.pointerUp(box, { pointerId: 1 })
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('each person’s volume', () => {
  it('0–100% is the element alone; above it a gain; out of range comes back', () => {
    expect(volumeRouting(50)).toEqual({ element: 0.5, gain: null })
    expect(volumeRouting(100)).toEqual({ element: 1, gain: null })
    expect(volumeRouting(0)).toEqual({ element: 0, gain: null })
    expect(volumeRouting(150)).toEqual({ element: 1, gain: 1.5 })
    expect(clampVolume(300)).toBe(200)
    expect(clampVolume(-5)).toBe(0)
    expect(clampVolume(Number.NaN)).toBe(100)
  })

  it('is remembered per room, for the session', () => {
    saveMemberVolumes('room', { bob: 150, [shareVolumeKey('bob')]: 40 })
    expect(loadMemberVolumes('room')).toEqual({ bob: 150, 'share:bob': 40 })
    expect(loadMemberVolumes('other')).toEqual({})
    sessionStorage.setItem('longtalk:volumes:bad', 'not json')
    expect(loadMemberVolumes('bad')).toEqual({})
    sessionStorage.setItem('longtalk:volumes:odd', '{"bob":900,"carol":"loud"}')
    expect(loadMemberVolumes('odd')).toEqual({ bob: 200 })
    expect(localStorage.length).toBe(0)
  })

  it('the element takes the volume, without a new source', () => {
    class FakeStream {
      tracks: unknown[]
      constructor(tracks: unknown[]) {
        this.tracks = tracks
      }
    }
    vi.stubGlobal('MediaStream', FakeStream)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const track = { id: 'mic' } as unknown as MediaStreamTrack
    const { container, rerender } = render(
      <MemberAudio name="Bob" track={track} speaker={null} volume={40} />,
    )
    const audio = container.querySelector('audio')!
    expect(audio.volume).toBeCloseTo(0.4)
    const source = audio.srcObject
    rerender(<MemberAudio name="Bob" track={track} speaker={null} volume={80} />)
    expect(audio.volume).toBeCloseTo(0.8)
    expect(audio.srcObject).toBe(source)
  })
})

describe('the boost above 100%', () => {
  class FakeStream {
    tracks: unknown[]
    constructor(tracks: unknown[] = []) {
      this.tracks = tracks
    }
  }

  function fakeBooster(state: 'running' | 'suspended') {
    vi.stubGlobal('MediaStream', FakeStream)
    const gain = { value: 0 }
    const destination = { stream: new FakeStream() as unknown as MediaStream }
    const disconnect = vi.fn()
    const context = {
      state,
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect }),
      createAnalyser: () => {
        throw new Error('not here')
      },
      createGain: () => ({ gain, connect: () => undefined, disconnect }),
      createMediaStreamDestination: () => destination,
      close: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
    }
    const released = vi.fn()
    let gesture: (() => void) | null = null
    const env: BoostEnv = {
      createContext: () => context as unknown as BoostContext,
      keepAlive: () => released,
      onGesture: (callback) => {
        gesture = callback
        return () => {
          gesture = null
        }
      },
    }
    return {
      booster: new VolumeBooster(env),
      context,
      gain,
      destination,
      released,
      disconnect,
      gesture: () => gesture,
    }
  }
  const track = { id: 'mic' } as unknown as MediaStreamTrack

  it('routes at once while the context runs; undo disconnects and closes the last', () => {
    const { booster, context, gain, destination, released, disconnect } = fakeBooster('running')
    const ready = vi.fn()
    const undo = booster.route(track, 1.5, ready)
    expect(gain.value).toBe(1.5)
    expect(ready.mock.calls[0][0].stream).toBe(destination.stream)
    ready.mock.calls[0][0].setGain(2)
    expect(gain.value).toBe(2)
    undo()
    expect(disconnect).toHaveBeenCalled()
    expect(released).toHaveBeenCalled()
    expect(context.close).toHaveBeenCalled()
  })

  it('a suspended context (no gesture yet) routes nothing until it runs: never silence', async () => {
    const { booster, context, gesture } = fakeBooster('suspended')
    const ready = vi.fn()
    const undo = booster.route(track, 2, ready)
    await act(async () => {})
    expect(ready).not.toHaveBeenCalled()
    context.state = 'running'
    gesture()?.()
    await act(async () => {})
    expect(ready).toHaveBeenCalledTimes(1)
    expect(gesture()).toBeNull()
    undo()
  })
})

describe('the level meters', () => {
  it('one analyser per microphone, however many listeners, none without them', () => {
    vi.stubGlobal(
      'MediaStream',
      class {},
    )
    let analysers = 0
    const context: AudioContextLike = {
      state: 'running',
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
      createAnalyser: () => {
        analysers += 1
        return { fftSize: 0, getFloatTimeDomainData: (array) => array.fill(0.5) }
      },
      close: async () => undefined,
    }
    const close = vi.spyOn(context, 'close')
    const intervals = { set: 0, cleared: 0 }
    const monitor = new SpeakingMonitor({
      createContext: () => context,
      now: () => 0,
      hidden: () => false,
      setInterval: () => {
        intervals.set += 1
        return 1
      },
      clearInterval: () => {
        intervals.cleared += 1
      },
    })
    const mic = { id: 'mic' } as unknown as MediaStreamTrack
    const speaking = vi.fn()
    const level = vi.fn()
    const offSpeaking = monitor.watch(mic, speaking)
    const offLevel = monitor.watchLevel(mic, level)
    expect(analysers).toBe(1)
    monitor.tick()
    expect(level).toHaveBeenCalledTimes(1)
    expect(level.mock.calls[0][0]).toBeGreaterThan(0.5)
    expect(speaking).toHaveBeenCalledWith(true)
    offSpeaking()
    monitor.tick()
    expect(level).toHaveBeenCalledTimes(2)
    expect(close).not.toHaveBeenCalled()
    offLevel()
    expect(close).toHaveBeenCalled()
    expect(intervals).toEqual({ set: 1, cleared: 1 })
  })
})

describe('the participants panel', () => {
  const member = (id: string, name: string): Member =>
    ({
      id,
      name,
      role: 'participant',
      tracks: [],
      joinedAt: 1,
      reconnecting: false,
    }) as unknown as Member

  const renderPanel = (volumeSupported = true) => {
    const onVolume = vi.fn()
    const { container } = render(
      <ParticipantsPanel
        members={[member('me', 'Ada'), member('bob', 'Bob')]}
        you="me"
        sharerIds={[]}
        onAction={() => {}}
        onMuteAll={() => {}}
        onEndMeeting={() => {}}
        audio={{
          levelOf: () => null,
          volumeSupported,
          volumeOf: (id) => (id === shareVolumeKey('bob') ? 60 : 120),
          onVolume,
          sharesSound: (id) => id === 'bob',
        }}
      />,
    )
    return { onVolume, container }
  }

  it('a meter for everyone, a slider for everyone else, 0–200%', () => {
    const { onVolume, container } = renderPanel()
    expect(container.querySelectorAll('[data-level-meter]')).toHaveLength(2)
    expect(screen.queryByRole('slider', { name: strings.participants.volumeOf('Ada') })).toBeNull()
    const slider = screen.getByRole('slider', { name: strings.participants.volumeOf('Bob') })
    expect(slider).toHaveAttribute('min', '0')
    expect(slider).toHaveAttribute('max', '200')
    expect(slider).toHaveAttribute('aria-valuetext', '120%')
    fireEvent.change(slider, { target: { value: '150' } })
    expect(onVolume).toHaveBeenCalledWith('bob', 150)
  })

  it('their share’s sound has its own slider', () => {
    const { onVolume } = renderPanel()
    const slider = screen.getByRole('slider', { name: strings.participants.shareVolumeOf('Bob') })
    expect(slider).toHaveAttribute('aria-valuetext', '60%')
    fireEvent.change(slider, { target: { value: '30' } })
    expect(onVolume).toHaveBeenCalledWith('share:bob', 30)
  })

  it('where the volume cannot change (iPhone): no slider, and it says why', () => {
    renderPanel(false)
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByText(strings.participants.volumeUnsupported)).toBeInTheDocument()
  })
})

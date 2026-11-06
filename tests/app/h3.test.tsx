import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog, type SettingsDialogProps } from '../../src/components/SettingsDialog.tsx'
import { DEFAULT_PROCESSING } from '../../src/media/audioProcessing.ts'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import type { LevelMeter } from '../../src/media/levelMeter.ts'
import { MUTED_HINT_COOLDOWN_MS, MUTED_SPEECH_MS } from '../../src/media/mutedSpeech.ts'
import { LocalDevices } from '../../src/room/LocalDevices.ts'
import { RoomMedia } from '../../src/room/RoomMedia.ts'
import {
  defaultDevices,
  defaultHd,
  loadMediaPrefs,
  saveMediaPrefs,
} from '../../src/room/session.ts'
import { useMutedSpeechHint } from '../../src/room/useMutedSpeechHint.ts'
import { createFakeStream, fakeMediaDevices, type FakeTrack } from './media/fakeMedia.ts'

// H3: the microphone's processing switches in the room (e6-t01), the settings panel, and the
// speaking-while-muted hint (e6-t03), including that nothing is sent while muted.

function devicesSetup(processing = DEFAULT_PROCESSING) {
  const fake = fakeMediaDevices()
  const devices = new LocalDevices({
    mediaDevices: fake.devices,
    chosen: defaultDevices(),
    processing,
    createStream: createFakeStream,
    startRetryMs: 0,
  })
  const mic = () => devices.getState().mic.track as unknown as FakeTrack | null
  return { fake, devices, mic }
}

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('LocalDevices: processing switches (e6-t01)', () => {
  it('opens the microphone with the remembered switches', async () => {
    const t = devicesSetup({ ...DEFAULT_PROCESSING, autoGainControl: false })
    await t.devices.start({ mic: true, cam: false })
    expect(t.fake.getUserMedia).toHaveBeenCalledWith({
      audio: { autoGainControl: false },
      video: false,
    })
  })

  it('applies a change to the open microphone when the browser can', async () => {
    const t = devicesSetup()
    await t.devices.start({ mic: true, cam: false })
    const mic = t.mic()!
    const off = { ...DEFAULT_PROCESSING, noiseSuppression: false }
    expect(await t.devices.setProcessing(off)).toBe('applied')
    expect(mic.applyConstraints).toHaveBeenCalledWith(expect.objectContaining(off))
    expect(t.mic()).toBe(mic)
    expect(t.devices.getState().processing).toEqual(off)
  })

  it('opens the same microphone again when the browser keeps the old values, staying muted', async () => {
    const t = devicesSetup()
    await t.devices.start({ mic: true, cam: false })
    const mic = t.mic()!
    // The browser accepts the call and changes nothing (Chrome)
    mic.getSettings = () => ({ deviceId: 'mic-1', noiseSuppression: true }) as never
    await t.devices.setOn('mic', false)
    const off = { ...DEFAULT_PROCESSING, noiseSuppression: false }
    expect(await t.devices.setProcessing(off)).toBe('reopened')
    expect(t.fake.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { ideal: 'mic-1' }, noiseSuppression: false },
      video: false,
    })
    expect(mic.stopped).toBe(true)
    const reopened = t.mic()!
    expect(reopened).not.toBe(mic)
    expect(reopened.enabled).toBe(false)
    expect(t.devices.getState().mic.on).toBe(false)
    expect(LocalDevices.sending(t.devices.getState()).mic).toBeNull()
  })

  it('keeps the current microphone quietly when opening it again fails', async () => {
    const t = devicesSetup()
    await t.devices.start({ mic: true, cam: false })
    const mic = t.mic()!
    mic.applyConstraints.mockRejectedValueOnce(new Error('OverconstrainedError'))
    t.fake.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error(), { name: 'NotReadableError' }),
    )
    expect(await t.devices.setProcessing({ ...DEFAULT_PROCESSING, echoCancellation: false })).toBe(
      'failed',
    )
    expect(t.mic()).toBe(mic)
    expect(t.devices.getState().mic).toMatchObject({ on: true, problem: null })
  })

  it('with no microphone open, only remembers them for the next opening', async () => {
    const t = devicesSetup()
    await t.devices.start({ mic: false, cam: false })
    const off = { ...DEFAULT_PROCESSING, echoCancellation: false }
    expect(await t.devices.setProcessing(off)).toBe('later')
    await t.devices.setOn('mic', true)
    expect(t.fake.getUserMedia).toHaveBeenLastCalledWith({
      audio: { echoCancellation: false },
      video: false,
    })
  })
})

describe('remembered media settings (H3)', () => {
  it('keeps the switches and HD, and defaults HD by device', () => {
    const fresh = {
      advancedNoise: false,
      powerSaving: false,
      blur: false,
      mirror: true,
      selfView: false,
      selfViewAt: { x: 1, y: 1 },
    }
    expect(loadMediaPrefs()).toEqual({ processing: DEFAULT_PROCESSING, hd: null, ...fresh })
    saveMediaPrefs({
      processing: { ...DEFAULT_PROCESSING, noiseSuppression: false },
      hd: false,
      ...fresh,
    })
    expect(loadMediaPrefs()).toEqual({
      processing: { ...DEFAULT_PROCESSING, noiseSuppression: false },
      hd: false,
      ...fresh,
    })
    localStorage.setItem('longtalk.media', '{"processing":{"echoCancellation":"x"},"hd":3}')
    expect(loadMediaPrefs()).toEqual({ processing: DEFAULT_PROCESSING, hd: null, ...fresh })
    expect(defaultHd(false)).toBe(true)
    expect(defaultHd(true)).toBe(false)
  })
})

describe('the speaking-while-muted hint (e6-t03)', () => {
  /** A meter whose level the test sets */
  function meters() {
    const made: { track: MediaStreamTrack; closed: boolean }[] = []
    let level = 0
    return {
      made,
      setLevel: (value: number) => (level = value),
      create: (track: MediaStreamTrack): LevelMeter => {
        const entry = { track, closed: false }
        made.push(entry)
        return { read: () => level, close: () => (entry.closed = true) }
      },
    }
  }

  async function mutedRoom() {
    const t = devicesSetup()
    await t.devices.start({ mic: true, cam: false })
    const sfu = new FakeSfu()
    const transport = sfu.createTransport()
    const media = new RoomMedia({ transport, send: () => {} })
    await media.start(LocalDevices.sending(t.devices.getState()))
    await t.devices.setOn('mic', false)
    await media.setLocal(LocalDevices.sending(t.devices.getState()))
    return { ...t, sfu, transport, media }
  }

  it('reads a clone of the muted microphone; nothing is sent meanwhile', async () => {
    const room = await mutedRoom()
    const mic = room.mic()!
    const m = meters()
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() =>
      useMutedSpeechHint(
        { track: mic as unknown as MediaStreamTrack, muted: true, pushToTalk: false },
        { createMeter: m.create, now: () => Date.now(), hidden: () => false },
      ),
    )
    // The analyser is on a clone, enabled, never the sent track
    expect(m.made).toHaveLength(1)
    const clone = m.made[0].track as unknown as FakeTrack
    expect(clone).not.toBe(mic)
    expect(mic.clones).toEqual([clone])
    expect(clone.enabled).toBe(true)
    expect(mic.enabled).toBe(false)
    m.setLevel(0.9)
    await act(() => vi.advanceTimersByTimeAsync(MUTED_SPEECH_MS + 200))
    expect(result.current.hint).toBe(true)
    // The microphone's sender sends nothing, and the clone went nowhere
    const micName = room.media.getState().published.find((t) => t.kind === 'mic')!.trackName
    expect(room.transport.sending.get(micName)).toBeNull()
    expect([...room.transport.sending.values()]).not.toContain(clone)
    expect([...room.sfu.published.values()].map((p) => p.track)).not.toContain(clone)
    unmount()
    expect(clone.stopped).toBe(true)
    expect(m.made[0].closed).toBe(true)
    await room.media.close()
  })

  it('goes when unmuted, does not nag, and never runs while push-to-talk is held', async () => {
    const t = devicesSetup()
    await t.devices.start({ mic: true, cam: false })
    const mic = t.mic()! as unknown as MediaStreamTrack
    const m = meters()
    vi.useFakeTimers()
    const deps = { createMeter: m.create, now: () => Date.now(), hidden: () => false }
    const { result, rerender } = renderHook(
      (props: { muted: boolean; pushToTalk: boolean }) =>
        useMutedSpeechHint({ track: mic, ...props }, deps),
      { initialProps: { muted: true, pushToTalk: false } },
    )
    m.setLevel(0.9)
    await act(() => vi.advanceTimersByTimeAsync(MUTED_SPEECH_MS + 200))
    expect(result.current.hint).toBe(true)
    // Unmuted: the hint goes and the clone stops
    rerender({ muted: false, pushToTalk: false })
    expect(result.current.hint).toBe(false)
    expect(m.made[0].closed).toBe(true)
    // Muted again and still talking: the cooldown holds
    rerender({ muted: true, pushToTalk: false })
    await act(() => vi.advanceTimersByTimeAsync(MUTED_SPEECH_MS * 3))
    expect(result.current.hint).toBe(false)
    await act(() => vi.advanceTimersByTimeAsync(MUTED_HINT_COOLDOWN_MS))
    expect(result.current.hint).toBe(true)
    act(() => result.current.dismiss())
    expect(result.current.hint).toBe(false)
    // Push-to-talk held: the microphone is on, nothing listens
    rerender({ muted: false, pushToTalk: true })
    const before = m.made.length
    await act(() => vi.advanceTimersByTimeAsync(MUTED_HINT_COOLDOWN_MS + MUTED_SPEECH_MS * 2))
    expect(m.made).toHaveLength(before)
    expect(result.current.hint).toBe(false)
  })
})

describe('the settings panel (H3)', () => {
  function props(overrides: Partial<SettingsDialogProps> = {}): SettingsDialogProps {
    return {
      phone: false,
      onClose: vi.fn(),
      devices: {
        audioinput: [{ deviceId: 'mic-1', label: 'Built-in Microphone' }],
        videoinput: [{ deviceId: 'cam-1', label: 'FaceTime HD Camera' }],
        audiooutput: [{ deviceId: 'spk-1', label: 'Speakers' }],
      },
      selected: { mic: 'mic-1', cam: 'cam-1', speaker: 'spk-1' },
      onSelect: vi.fn(),
      speakerSupported: true,
      processing: DEFAULT_PROCESSING,
      processingSupported: ['noiseSuppression', 'echoCancellation', 'autoGainControl'],
      onProcessing: vi.fn(),
      hd: true,
      onHd: vi.fn(),
      audioOnly: false,
      onAudioOnly: vi.fn(),
      ...overrides,
    }
  }

  it('has three tabs; 音訊 has the devices and the processing switches, all on', async () => {
    const p = props()
    render(<SettingsDialog {...p} />)
    const dialog = screen.getByRole('dialog', { name: '設定' })
    const tabs = within(dialog)
      .getAllByRole('tab')
      .map((tab) => tab.textContent)
    expect(tabs).toEqual(['音訊', '視訊', '效能'])
    expect(within(dialog).getByRole('tab', { name: '音訊' })).toHaveFocus()
    expect(within(dialog).getByLabelText('麥克風')).toHaveValue('mic-1')
    expect(within(dialog).getByLabelText('喇叭')).toHaveValue('spk-1')
    for (const name of ['噪音抑制', '回音消除', '自動調整音量']) {
      expect(within(dialog).getByRole('switch', { name })).toBeChecked()
    }
    fireEvent.click(within(dialog).getByRole('switch', { name: '回音消除' }))
    expect(p.onProcessing).toHaveBeenCalledWith({ ...DEFAULT_PROCESSING, echoCancellation: false })
  })

  it('hides the switches the browser does not know', () => {
    render(<SettingsDialog {...props({ processingSupported: ['echoCancellation'] })} />)
    expect(screen.queryByRole('switch', { name: '噪音抑制' })).toBeNull()
    expect(screen.getByRole('switch', { name: '回音消除' })).toBeInTheDocument()
  })

  it('says so when it knows none', () => {
    render(<SettingsDialog {...props({ processingSupported: [] })} />)
    expect(screen.queryAllByRole('switch')).toEqual([])
    expect(screen.getByText('這個瀏覽器不能調整聲音處理。')).toBeInTheDocument()
  })

  it('視訊 has the camera and HD (with the uplink note), 效能 has 純音訊模式', () => {
    const p = props({ hdLimited: true })
    render(<SettingsDialog {...p} />)
    const tablist = screen.getByRole('tablist', { name: '設定分頁' })
    fireEvent.keyDown(tablist, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: '視訊' })).toHaveFocus()
    const video = screen.getByRole('tabpanel', { name: '視訊' })
    expect(within(video).getByLabelText('鏡頭')).toHaveValue('cam-1')
    const hd = within(video).getByRole('switch', { name: 'HD 視訊' })
    expect(hd).toBeChecked()
    expect(within(video).getByRole('status')).toHaveTextContent('上傳網路不夠快')
    fireEvent.click(hd)
    expect(p.onHd).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('tab', { name: '效能' }))
    fireEvent.click(screen.getByRole('switch', { name: '純音訊模式' }))
    expect(p.onAudioOnly).toHaveBeenCalledWith(true)
  })

  it('closes with Escape and the close button; a phone gets the drawer', () => {
    const p = props()
    const { unmount } = render(<SettingsDialog {...p} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '關閉' }))
    expect(p.onClose).toHaveBeenCalledTimes(2)
    unmount()
    render(<SettingsDialog {...props({ phone: true })} />)
    expect(screen.getByRole('dialog', { name: '設定' })).toBeInTheDocument()
  })
})

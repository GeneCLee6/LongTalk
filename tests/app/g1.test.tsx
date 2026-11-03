import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/App.tsx'
import { en } from '../../src/i18n/en.ts'
import type { Strings } from '../../src/i18n/types.ts'
import { zhTW } from '../../src/i18n/zh-TW.ts'
import { playTestTone, toneWav, TONE_SECONDS, type ToneElement } from '../../src/media/testTone.ts'
import { detectGuide, detectSystem, GUIDE_IDS, GUIDES } from '../../src/room/permissionGuide.ts'
import { loadDeviceLabels, loadDevices, resolveDevice, saveDevice } from '../../src/room/session.ts'
import { SILENCE_MS, useMicSilence } from '../../src/room/useMicSilence.ts'
import {
  dictionary,
  formatClock,
  formatDateTime,
  formatDay,
  getLocale,
  intlLocale,
  pickLocale,
  setLocale,
  strings,
} from '../../src/strings.ts'
import { fakeMediaDevices } from './media/fakeMedia.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

// G1 (e4-t09, e4-t15): the two dictionaries, choosing and switching the language, dates and
// times through Intl, the permission tutorial per browser, the speaker test, device memory by
// label, and the silent-microphone hint.

const ROOM_ID = 'abcdefghij'

class QuietSocket {
  readyState = 0
  onopen = null
  onmessage = null
  onclose = null
  send() {}
  close() {}
}

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true })
}

function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true })
}

const JSDOM_UA = navigator.userAgent

const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement

async function openPreJoin(
  options: Parameters<typeof fakeMediaDevices>[0] = {},
  heading = '準備加入',
) {
  const fake = fakeMediaDevices(options)
  setMediaDevices(fake.devices)
  window.history.pushState({}, '', `/r/${ROOM_ID}`)
  render(<App />)
  await screen.findByRole('heading', { name: heading }, { timeout: 5000 })
  return fake
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('WebSocket', QuietSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 0 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  setMediaDevices(undefined)
  setUserAgent(JSDOM_UA)
  delete (navigator as { permissions?: unknown }).permissions
})

/** Every key path of a dictionary (functions and texts are leaves) */
function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    paths(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('dictionaries (e4-t15)', () => {
  it('have exactly the same keys, and the same kind of value under each', () => {
    expect(paths(en).sort()).toEqual(paths(zhTW).sort())
    for (const path of paths(zhTW)) {
      const pick = (dict: unknown) =>
        path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], dict)
      expect(typeof pick(en), path).toBe(typeof pick(zhTW))
    }
  })

  it('make a missing English key a type error', () => {
    // @ts-expect-error: `common` is missing `you`
    const broken: Strings['common'] = {
      close: '',
      cancel: '',
      retry: '',
      copy: '',
      copied: '',
      more: '',
    }
    expect(broken).toBeDefined()
  })

  it('keep the product name English in both', () => {
    expect(zhTW.appName).toBe('LongTalk')
    expect(en.appName).toBe('LongTalk')
  })

  it('has no Chinese left in the English dictionary (except the language menu’s 繁體中文)', () => {
    const texts: string[] = []
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') texts.push(`${path}=${node}`)
      else if (typeof node === 'function') {
        const args = Array.from({ length: node.length }, () => 'x')
        const out = (node as (...a: unknown[]) => unknown)(...args)
        if (typeof out === 'string') texts.push(`${path}()=${out}`)
      } else if (typeof node === 'object' && node !== null)
        for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`)
    }
    walk(en, 'en')
    const chinese = texts.filter((t) => /[一-鿿]/.test(t) && !t.startsWith('en.language.names'))
    expect(chinese).toEqual([])
  })
})

describe('choosing the language (e4-t15)', () => {
  it('keeps a remembered choice', () => {
    expect(pickLocale('en', ['zh-TW'])).toBe('en')
    expect(pickLocale('zh-TW', ['en-AU'])).toBe('zh-TW')
  })

  it('starts in Chinese when any browser language is Chinese, or none is given', () => {
    expect(pickLocale(null, ['zh-TW'])).toBe('zh-TW')
    expect(pickLocale(null, ['en-AU', 'zh-Hant-TW'])).toBe('zh-TW')
    expect(pickLocale(null, ['zh-CN'])).toBe('zh-TW')
    expect(pickLocale(null, ['zh'])).toBe('zh-TW')
    expect(pickLocale(null, [])).toBe('zh-TW')
    expect(pickLocale('fr', [''])).toBe('zh-TW')
  })

  it('starts in English only when the browser clearly does not read Chinese', () => {
    expect(pickLocale(null, ['en-AU', 'en'])).toBe('en')
    expect(pickLocale(null, ['ja-JP'])).toBe('en')
    // "zhuang" is not Chinese
    expect(pickLocale(null, ['za'])).toBe('en')
  })

  it('switches the dictionary and <html lang>, and remembers it', () => {
    expect(strings.prejoin.title).toBe('準備加入')
    setLocale('en')
    expect(getLocale()).toBe('en')
    expect(strings.prejoin.title).toBe('Ready to join?')
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem('longtalk.locale')).toBe('en')
    setLocale('zh-TW')
    expect(document.documentElement.lang).toBe('zh-Hant-TW')
    expect(dictionary('en').room.title('x')).toBe('Room x')
  })
})

describe('dates and times through Intl (e4-t15)', () => {
  const at = new Date(2026, 10, 3, 21, 4, 5).getTime()

  it('chat times: 24-hour in Chinese, the English locale’s own clock in English', () => {
    expect(formatClock(new Date(2026, 0, 1, 9, 5))).toBe('09:05')
    expect(formatClock(at)).toBe('21:04')
    setLocale('en', false)
    expect(formatClock(at)).toMatch(/^9:04\s?pm$/i)
  })

  it('/admin dates in each language', () => {
    expect(formatDateTime(at)).toMatch(/^2026\/11\/3\s21:04:05$/u)
    expect(formatDay('2026-11-03')).toContain('11/3')
    setLocale('en', false)
    expect(formatDateTime(at)).toMatch(/3 Nov 2026/)
    expect(formatDay('2026-11-03')).toMatch(/Tue.*3 Nov 2026/)
    expect(formatDay('not a day')).toBe('not a day')
  })

  it('formats English with the browser’s own English region', () => {
    expect(intlLocale('en', ['en-US'])).toBe('en-US')
    expect(intlLocale('en', ['zh-TW', 'en-au'])).toBe('en-AU')
    expect(intlLocale('en', ['en'])).toBe('en-GB')
    expect(intlLocale('en', ['fr-FR'])).toBe('en-GB')
    expect(intlLocale('zh-TW', ['en-US'])).toBe('zh-TW')
  })
})

describe('the language switch on screen (e4-t15)', () => {
  it('pre-join: switching to English re-renders the screen in English, and back', async () => {
    await openPreJoin()
    fireEvent.change(select('語言'), { target: { value: 'en' } })
    expect(await screen.findByRole('heading', { name: 'Ready to join?' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Your name' })).toBeInTheDocument()
    expect(localStorage.getItem('longtalk.locale')).toBe('en')
    fireEvent.change(select('Language'), { target: { value: 'zh-TW' } })
    expect(await screen.findByRole('heading', { name: '準備加入' })).toBeInTheDocument()
  })

  it('a page opened in English renders English throughout', async () => {
    setLocale('en', false)
    await openPreJoin({}, 'Ready to join?')
    expect(screen.getByText('Nobody’s here yet', { exact: false })).toBeInTheDocument()
    expect(await screen.findByLabelText('Camera preview')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled()
  })

  it('the home page has the switch too', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)
    fireEvent.change(select('語言'), { target: { value: 'en' } })
    expect(await screen.findByRole('button', { name: 'Start a room' })).toBeInTheDocument()
  })
})

describe('the permission tutorial (e4-t09)', () => {
  const UA = {
    chromeWin:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    firefoxMac:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:144.0) Gecko/20100101 Firefox/144.0',
    safariMac:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    iphone:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    iphoneChrome:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
    android:
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  }

  it('picks the browser’s steps from the user agent', () => {
    expect(detectGuide({ userAgent: UA.chromeWin })).toBe('chrome')
    expect(detectGuide({ userAgent: UA.edge })).toBe('edge')
    expect(detectGuide({ userAgent: UA.firefoxMac })).toBe('firefox')
    expect(detectGuide({ userAgent: UA.safariMac })).toBe('safariMac')
    expect(detectGuide({ userAgent: UA.iphone })).toBe('iosSafari')
    expect(detectGuide({ userAgent: UA.iphoneChrome })).toBe('iosOther')
    // iPadOS says Macintosh; its touch screen gives it away
    expect(detectGuide({ userAgent: UA.safariMac, maxTouchPoints: 5 })).toBe('iosSafari')
    expect(detectGuide({ userAgent: UA.android })).toBe('android')
    expect(detectGuide({ userAgent: 'Something else' })).toBe('other')
  })

  it('names the operating system whose switch may block the browser', () => {
    expect(detectSystem({ userAgent: UA.chromeWin })).toBe('windows')
    expect(detectSystem({ userAgent: UA.firefoxMac })).toBe('mac')
    expect(detectSystem({ userAgent: UA.iphone })).toBe('ios')
    expect(detectSystem({ userAgent: UA.safariMac, maxTouchPoints: 5 })).toBe('ios')
    expect(detectSystem({ userAgent: UA.android })).toBe('android')
    expect(detectSystem({ userAgent: 'X11; Linux' })).toBeNull()
  })

  it('every guide ends with trying again and has text for every step in both languages', () => {
    for (const id of GUIDE_IDS) {
      expect(GUIDES[id].at(-1)!.icon).toBe('retry')
      for (const step of GUIDES[id]) {
        expect(zhTW.permissionGuide.steps[step.text]).toBeTruthy()
        expect(en.permissionGuide.steps[step.text]).toBeTruthy()
      }
    }
  })

  it('on a refusal shows this browser’s steps, another browser’s on request, and retries', async () => {
    setUserAgent(UA.chromeWin)
    const fake = await openPreJoin({ denyAll: true })
    const guide = await screen.findByRole('alert')
    expect(
      within(guide).getByRole('heading', { name: '瀏覽器擋住了麥克風和鏡頭' }),
    ).toBeInTheDocument()
    expect(guide).toHaveTextContent(zhTW.permissionGuide.steps.chromeSite)
    expect(guide).toHaveTextContent(zhTW.permissionGuide.system.windows)
    fireEvent.change(within(guide).getByRole('combobox', { name: '你的瀏覽器' }), {
      target: { value: 'firefox' },
    })
    expect(guide).toHaveTextContent(zhTW.permissionGuide.steps.firefoxClear)
    const calls = fake.getUserMedia.mock.calls.length
    fireEvent.click(within(guide).getByRole('button', { name: '再試一次' }))
    await waitFor(() => expect(fake.getUserMedia.mock.calls.length).toBeGreaterThan(calls))
  })

  it('retries by itself once the site settings allow it (Permissions API)', async () => {
    const statuses: Record<string, { state: string; onchange: (() => void) | null }> = {
      microphone: { state: 'denied', onchange: null },
      camera: { state: 'denied', onchange: null },
    }
    Object.defineProperty(navigator, 'permissions', {
      value: { query: async ({ name }: { name: string }) => statuses[name] },
      configurable: true,
    })
    const fake = await openPreJoin({ denyAll: true })
    expect(await screen.findByText(zhTW.permissionGuide.watching)).toBeInTheDocument()
    const calls = fake.getUserMedia.mock.calls.length
    act(() => {
      statuses.camera.state = 'granted'
      statuses.camera.onchange?.()
    })
    await waitFor(() => expect(fake.getUserMedia.mock.calls.length).toBeGreaterThan(calls))
  })

  it('says the system blocks it when the browser already allows it', async () => {
    Object.defineProperty(navigator, 'permissions', {
      value: { query: async () => ({ state: 'granted', onchange: null }) },
      configurable: true,
    })
    setUserAgent(UA.safariMac)
    await openPreJoin({ denyAll: true })
    expect(
      await screen.findByRole('heading', { name: zhTW.permissionGuide.titleSystem }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(zhTW.permissionGuide.system.mac)
  })
})

describe('the speaker test (e4-t09)', () => {
  it('makes a valid WAV of the chime', () => {
    const wav = toneWav(8000)
    const text = (from: number, to: number) => String.fromCharCode(...wav.slice(from, to))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 12)).toBe('WAVE')
    expect(wav.length).toBe(44 + Math.round(TONE_SECONDS * 8000) * 2)
    expect(wav.slice(44).some((byte) => byte !== 0)).toBe(true)
  })

  it('plays through the chosen speaker, and stops', async () => {
    const element: ToneElement & { played: number; paused: number; sink: string | null } = {
      src: '',
      onended: null,
      played: 0,
      paused: 0,
      sink: null,
      play() {
        this.played++
      },
      pause() {
        this.paused++
      },
      async setSinkId(id: string) {
        this.sink = id
      },
    }
    const revokeUrl = vi.fn()
    const playback = playTestTone('spk-1', {
      createElement: () => element,
      createUrl: () => 'blob:tone',
      revokeUrl,
    })
    await waitFor(() => expect(element.played).toBe(1))
    expect(element.sink).toBe('spk-1')
    expect(element.src).toBe('blob:tone')
    element.onended?.()
    await playback.done
    expect(revokeUrl).toHaveBeenCalledWith('blob:tone')
  })

  it('is offered only where the browser can choose the speaker', async () => {
    await openPreJoin()
    await screen.findByLabelText('鏡頭預覽')
    expect(screen.queryByRole('button', { name: '測試喇叭' })).toBeNull()
  })

  it('plays through the speaker in the menu where it can', async () => {
    const sinks: string[] = []
    const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>
    const saved = { play: proto.play, pause: proto.pause }
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      value: async (id: string) => void sinks.push(id),
      configurable: true,
    })
    proto.play = async () => {}
    proto.pause = () => {}
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    )
    try {
      await openPreJoin()
      await waitFor(() => expect(select('喇叭').options).toHaveLength(1))
      fireEvent.change(select('喇叭'), { target: { value: 'spk-1' } })
      fireEvent.click(screen.getByRole('button', { name: '測試喇叭' }))
      await waitFor(() => expect(sinks).toContain('spk-1'))
      expect(screen.getByRole('button', { name: '停止測試' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(screen.getByText(zhTW.prejoin.speakerTestHint)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '停止測試' }))
      expect(screen.getByRole('button', { name: '測試喇叭' })).toBeInTheDocument()
    } finally {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId
      proto.play = saved.play
      proto.pause = saved.pause
    }
  })
})

describe('device memory (e4-t09)', () => {
  const options = [
    { deviceId: 'cam-1', label: 'FaceTime HD Camera' },
    { deviceId: 'cam-2', label: '' },
  ]

  it('finds a remembered device by id, then by label; null when gone', () => {
    expect(resolveDevice('cam-1', 'FaceTime HD Camera', options)).toBe('cam-1')
    expect(resolveDevice('old-id', 'FaceTime HD Camera', options)).toBe('cam-1')
    expect(resolveDevice('old-id', 'Unplugged Camera', options)).toBeNull()
    expect(resolveDevice('old-id', null, options)).toBeNull()
    expect(resolveDevice(null, 'FaceTime HD Camera', options)).toBeNull()
    // No permission yet: nothing to compare, keep the id
    expect(resolveDevice('old-id', 'x', [])).toBe('old-id')
  })

  it('remembers the label with the id', () => {
    saveDevice('mic', 'mic-2', 'USB Headset')
    saveDevice('cam', 'cam-2')
    expect(loadDevices()).toMatchObject({ mic: 'mic-2', cam: 'cam-2' })
    expect(loadDeviceLabels()).toEqual({ mic: 'USB Headset', cam: null, speaker: null })
  })

  it('pre-join: a camera with a new id is found by its label and remembered by it on joining', async () => {
    localStorage.setItem('longtalk.devices', JSON.stringify({ cam: 'old-cam' }))
    localStorage.setItem('longtalk.deviceLabels', JSON.stringify({ cam: 'FaceTime HD Camera' }))
    const fake = await openPreJoin()
    await waitFor(() =>
      expect(fake.getUserMedia).toHaveBeenLastCalledWith({
        audio: true,
        video: { deviceId: { ideal: 'cam-1' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      }),
    )
    expect(select('鏡頭').value).toBe('cam-1')
    fireEvent.change(screen.getByRole('textbox', { name: '你的名字' }), {
      target: { value: 'Gene' },
    })
    fireEvent.click(screen.getByRole('button', { name: '加入' }))
    expect(loadDevices().cam).toBe('cam-1')
  })

  it('pre-join: an unplugged camera falls back to another and stays remembered', async () => {
    saveDevice('cam', 'cam-2', '')
    const fake = await openPreJoin()
    await waitFor(() => expect(select('鏡頭').value).toBe('cam-2'))
    const calls = fake.getUserMedia.mock.calls.length
    await act(async () => fake.unplug('cam-2'))
    // The ended track is opened again: the browser picks another camera
    await waitFor(() => expect(fake.getUserMedia.mock.calls.length).toBeGreaterThan(calls))
    await waitFor(() => expect(select('鏡頭').value).toBe('cam-1'))
    expect(loadDevices().cam).toBe('cam-2')
  })
})

describe('the silent microphone hint (e4-t09)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says so after a while without sound; any sound resets it', () => {
    const { result, rerender } = renderHook(
      ({ level, on }: { level: number; on: boolean }) => useMicSilence(level, on),
      { initialProps: { level: 0, on: true } },
    )
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(SILENCE_MS))
    expect(result.current).toBe(true)
    rerender({ level: 0.3, on: true })
    expect(result.current).toBe(false)
    rerender({ level: 0, on: true })
    act(() => vi.advanceTimersByTime(SILENCE_MS - 1))
    expect(result.current).toBe(false)
    rerender({ level: 0, on: false })
    act(() => vi.advanceTimersByTime(SILENCE_MS * 2))
    expect(result.current).toBe(false)
  })
})

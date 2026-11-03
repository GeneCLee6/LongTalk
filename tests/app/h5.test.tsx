import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharePicker } from '../../src/components/SharePicker.tsx'
import { SharingBar } from '../../src/components/SharingBar.tsx'
import { ShareTile } from '../../src/components/ShareTile.tsx'
import type { CapturedSurface } from '../../src/media/share.ts'
import { loadMainShare, saveMainShare } from '../../src/room/mainShare.ts'
import { canSampleShare } from '../../src/room/shareSampler.ts'
import { IN_FRONT_MS, useSelfCapture } from '../../src/room/useSharePreview.ts'

// H5 (e3-t06 – e3-t09): the sharing bar's mode switch, hints and preview; the main area's
// picker and the strip's shares; the self-capture hook

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const bar = () => screen.getByRole('region', { name: '你正在分享畫面' })

describe('the sharing bar (e3-t06, e3-t08, e3-t09)', () => {
  it('switches 文字／動態, the chosen one pressed', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SharingBar onStop={() => {}} mode={{ value: 'text', onChange }} />)
    const modes = within(bar()).getByRole('group', { name: '分享模式' })
    const text = within(modes).getByRole('button', { name: '文字' })
    const motion = within(modes).getByRole('button', { name: '動態' })
    expect(text).toHaveAttribute('aria-pressed', 'true')
    expect(motion).toHaveAttribute('aria-pressed', 'false')
    expect(text).toHaveAttribute('title', '清楚優先，適合文件、程式碼、投影片')
    fireEvent.click(motion)
    expect(onChange).toHaveBeenCalledWith('motion')
    rerender(<SharingBar onStop={() => {}} mode={{ value: 'motion', onChange }} />)
    expect(within(bar()).getByRole('button', { name: '動態' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('suggests 動態 for moving content, with 切到動態 and 不用', () => {
    const onSwitch = vi.fn()
    const onDismiss = vi.fn()
    render(<SharingBar onStop={() => {}} motionHint={{ onSwitch, onDismiss }} />)
    const hint = within(bar()).getByRole('status')
    expect(hint).toHaveTextContent('分享的畫面一直在動，切到「動態」會比較流暢。')
    fireEvent.click(within(hint).getByRole('button', { name: '切到動態' }))
    fireEvent.click(within(hint).getByRole('button', { name: '不用' }))
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('warns that the meeting itself is shared, with 換一個畫面', () => {
    const onRepick = vi.fn()
    const onDismiss = vi.fn()
    render(
      <SharingBar
        onStop={() => {}}
        selfCapture={{ kind: 'screenWithMeeting', onRepick, onDismiss }}
      />,
    )
    const warning = within(bar()).getByRole('alert')
    expect(warning).toHaveTextContent('會議室就在你分享的螢幕上')
    fireEvent.click(within(warning).getByRole('button', { name: '換一個畫面' }))
    fireEvent.click(within(warning).getByRole('button', { name: '知道了' }))
    expect(onRepick).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('says why there is no preview for a whole screen, and shows none before a frame', () => {
    const { rerender } = render(
      <SharingBar onStop={() => {}} preview={{ sample: { canvas: null, frame: 0 }, off: true }} />,
    )
    expect(bar()).toHaveTextContent('分享整個螢幕時不顯示預覽，以免畫面一直重複')
    expect(within(bar()).queryByRole('img', { name: '你分享的畫面（預覽）' })).toBeNull()
    rerender(
      <SharingBar onStop={() => {}} preview={{ sample: { canvas: null, frame: 0 }, off: false }} />,
    )
    expect(bar()).not.toHaveTextContent('不顯示預覽')
    expect(within(bar()).queryByRole('img', { name: '你分享的畫面（預覽）' })).toBeNull()
  })

  it('shows the presenter thumbnail from the latest sample, drawn again on every frame', () => {
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    const { rerender } = render(
      <SharingBar onStop={() => {}} preview={{ sample: { canvas, frame: 1 }, off: false }} />,
    )
    const thumb = within(bar()).getByRole('img', { name: '你分享的畫面（預覽）' })
    expect(thumb).toHaveAttribute('width', '160')
    expect(drawImage).toHaveBeenCalledTimes(1)
    rerender(
      <SharingBar onStop={() => {}} preview={{ sample: { canvas, frame: 2 }, off: false }} />,
    )
    expect(drawImage).toHaveBeenCalledTimes(2)
  })

  it('samples nowhere jsdom cannot (no ImageCapture, no video frame callbacks)', () => {
    expect(canSampleShare()).toBe(false)
  })
})

describe('several shares (e3-t07)', () => {
  it('the picker presses the share in the main area and picks another', () => {
    const onPick = vi.fn()
    render(
      <SharePicker
        shares={[
          { id: 'b', name: 'Bob' },
          { id: 'c', name: 'Carol' },
        ]}
        main="c"
        onPick={onPick}
      />,
    )
    const group = screen.getByRole('group', { name: '選擇主畫面要看誰的分享' })
    expect(within(group).getByRole('button', { name: 'Carol 的畫面' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(within(group).getByRole('button', { name: 'Bob 的畫面' }))
    expect(onPick).toHaveBeenCalledWith('b')
  })

  it('a strip share is one button that brings it to the main area', () => {
    const onShowMain = vi.fn()
    render(<ShareTile name="Bob" video={null} onShowMain={onShowMain} />)
    const tile = screen.getByRole('figure', { name: 'Bob 分享的畫面' })
    fireEvent.click(within(tile).getByRole('button', { name: '在主畫面看 Bob 的畫面' }))
    expect(onShowMain).toHaveBeenCalledTimes(1)
    // The main one has no such button
    render(<ShareTile name="Carol" video={null} />)
    expect(screen.queryByRole('button', { name: '在主畫面看 Carol 的畫面' })).toBeNull()
  })

  it('remembers the choice for the session, per room', () => {
    expect(loadMainShare('room1')).toBeNull()
    saveMainShare('room1', 'b')
    expect(loadMainShare('room1')).toBe('b')
    expect(loadMainShare('room2')).toBeNull()
    sessionStorage.clear()
  })
})

describe('useSelfCapture (e3-t09)', () => {
  const surface = (s: CapturedSurface['surface'], handle: string | null = null) => ({
    surface: s,
    handle,
    label: '',
  })

  it('a meeting tab is told at once; nothing while not sharing', () => {
    const { result, rerender } = renderHook(({ captured }) => useSelfCapture(captured), {
      initialProps: { captured: null as CapturedSurface | null },
    })
    expect(result.current).toBeNull()
    rerender({ captured: surface('browser', 'longtalk:abc') })
    expect(result.current).toBe('meetingTab')
  })

  it('a whole screen: once the meeting stays in front for a moment, gone when it leaves', () => {
    vi.useFakeTimers()
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { result } = renderHook(() => useSelfCapture(surface('monitor')))
    expect(result.current).toBeNull()
    act(() => vi.advanceTimersByTime(IN_FRONT_MS))
    expect(result.current).toBe('screenWithMeeting')
    // The sharer went to the window they present: the meeting is not in front any more
    focus.mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('blur')))
    expect(result.current).toBeNull()
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAnnouncer } from '../../src/components/LiveAnnouncer.tsx'
import { ThemeSelect } from '../../src/components/ThemeSelect.tsx'
import { Tile } from '../../src/components/Tile.tsx'
import { ToastViewport } from '../../src/components/Toast.tsx'
import { dictionary } from '../../src/strings.ts'
import { applyTheme, getTheme, setTheme } from '../../src/styles/theme.ts'

// G5 (e4-t14, AC-4.8, AC-4.9): the tile's state for screen readers, toasts that are not colour
// alone, the always-present announcer, and the light / dark switch.

describe('Tile state for screen readers (e4-t14)', () => {
  it('keeps the name as the name and says the state as the description, never speaking', () => {
    render(<Tile name="Wei" video={null} micMuted speaking hand={2} pinned role="cohost" />)
    const tile = screen.getByRole('figure', { name: 'Wei' })
    expect(tile).toHaveAccessibleDescription(
      '共同主持人，麥克風已關，鏡頭沒開，舉手，第 2 位，已釘選',
    )
    expect(tile).not.toHaveAccessibleDescription(/說話/)
  })

  it('says the host, an open microphone and camera, and our own tile', () => {
    const video = { kind: 'video', id: 'v' } as unknown as MediaStreamTrack
    render(<Tile name="Gene" you video={video} role="host" />)
    expect(screen.getByRole('figure', { name: 'Gene（你）' })).toHaveAccessibleDescription(
      '主持人，麥克風開著，鏡頭開著',
    )
  })

  it('has the same state sentence in English', () => {
    expect(
      dictionary('en').room.tileState({
        host: false,
        cohost: false,
        micMuted: true,
        camOff: false,
        hand: 1,
        pinned: false,
        spotlighted: true,
        reconnecting: true,
      }),
    ).toBe('microphone off, camera on, hand raised, number 1, spotlight, reconnecting')
  })
})

describe('Toasts are not colour alone (e4-t14)', () => {
  it('draws an icon for every tone', () => {
    render(
      <ToastViewport
        toasts={[
          { id: 1, text: 'a', tone: 'neutral' },
          { id: 2, text: 'b', tone: 'warn' },
        ]}
        onDismiss={vi.fn()}
      />,
    )
    const status = screen.getByRole('status')
    // Each card: its tone icon and the close button's cross
    expect(status.querySelectorAll('svg')).toHaveLength(4)
  })
})

describe('useAnnouncer (e4-t14)', () => {
  function Harness({ text }: { text: string }) {
    const { region, announce } = useAnnouncer()
    return (
      <>
        <button type="button" onClick={() => announce(text)}>
          go
        </button>
        {region}
      </>
    )
  }

  it('is in the page before anything is said, and says the same sentence twice', () => {
    vi.useFakeTimers()
    try {
      render(<Harness text="麥克風已關閉" />)
      const region = screen.getByRole('status')
      expect(region).toHaveTextContent('')
      fireEvent.click(screen.getByRole('button'))
      act(() => vi.advanceTimersByTime(60))
      expect(region).toHaveTextContent('麥克風已關閉')
      fireEvent.click(screen.getByRole('button'))
      expect(region).toHaveTextContent('')
      act(() => vi.advanceTimersByTime(60))
      expect(region).toHaveTextContent('麥克風已關閉')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Light / dark switch (AC-4.8)', () => {
  afterEach(() => {
    setTheme('system')
    localStorage.clear()
  })

  it('forces a scheme on <html>, remembers it, and goes back to the system', () => {
    render(<ThemeSelect />)
    const select = screen.getByRole('combobox', { name: '外觀' })
    expect(select).toHaveValue('system')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    fireEvent.change(select, { target: { value: 'dark' } })
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem('longtalk.theme')).toBe('dark')
    expect(getTheme()).toBe('dark')
    fireEvent.change(select, { target: { value: 'system' } })
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(localStorage.getItem('longtalk.theme')).toBeNull()
  })

  it('applies a remembered choice', () => {
    setTheme('light', false)
    document.documentElement.removeAttribute('data-theme')
    applyTheme()
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })
})

import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PHONE_PAGE_SIZE } from '../../shared/layout.ts'
import { Drawer } from '../../src/components/Drawer.tsx'
import {
  PhoneLayoutContext,
  usePhoneLayoutQuery,
  type PhoneLayout,
} from '../../src/components/layoutContext.ts'
import { Menu } from '../../src/components/Menu.tsx'
import { Toolbar, type ToolbarProps } from '../../src/components/Toolbar.tsx'
import { TopBar } from '../../src/components/TopBar.tsx'
import { strings } from '../../src/strings.ts'
import { breakpoint, media } from '../../src/styles/tokens.ts'

// e4-t07: the phone layout (AC-4.6): the toolbar, the top bar, bottom sheets and drawers

const onPhone = (layout: PhoneLayout, ui: ReactNode) => (
  <PhoneLayoutContext.Provider value={layout}>{ui}</PhoneLayoutContext.Provider>
)

/** A matchMedia whose answers the test sets; `set` tells the listeners */
function fakeMatchMedia() {
  const matching = new Set<string>()
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matching.has(query),
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }))
  return {
    set(queries: string[]) {
      matching.clear()
      queries.forEach((query) => matching.add(query))
      act(() => listeners.forEach((listener) => listener()))
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the phone layout query', () => {
  it('follows the same media queries as the CSS, upright and sideways', () => {
    const screenQueries = fakeMatchMedia()
    const { result } = renderHook(() => usePhoneLayoutQuery())
    expect(result.current).toBeNull()
    screenQueries.set([media.phonePortrait])
    expect(result.current).toBe('portrait')
    screenQueries.set([media.phoneLandscape])
    expect(result.current).toBe('landscape')
    screenQueries.set([])
    expect(result.current).toBeNull()
  })

  it('is no phone where there is no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => usePhoneLayoutQuery())
    expect(result.current).toBeNull()
  })

  it('keeps the CSS and the JS on the same breakpoints', () => {
    expect(media.phone).toContain(`(max-width: ${breakpoint.phone})`)
    expect(media.phone).toContain(media.phoneLandscape)
    expect(media.phonePortrait).toContain(`(max-width: ${breakpoint.phone})`)
    expect(PHONE_PAGE_SIZE).toBe(4)
  })
})

describe('Drawer', () => {
  it('is a labelled modal dialog that closes with Escape, the close button or the backdrop', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Drawer title="聊天" onClose={onClose}>
        <button type="button">送出</button>
      </Drawer>,
    )
    const dialog = screen.getByRole('dialog', { name: '聊天' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // Focus goes inside, to the first thing in the body
    expect(screen.getByRole('button', { name: '送出' })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: strings.common.close }))
    // A tap on the panel does not close it; one on the backdrop does
    fireEvent.pointerDown(dialog)
    fireEvent.pointerDown(container.firstElementChild!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('keeps Tab inside and gives focus back when it closes', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    const { unmount } = render(
      <Drawer title="參與者" variant="full" onClose={() => {}}>
        <button type="button">第一個</button>
        <button type="button">最後一個</button>
      </Drawer>,
    )
    const dialog = screen.getByRole('dialog', { name: '參與者' })
    screen.getByRole('button', { name: '最後一個' }).focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(screen.getByRole('button', { name: strings.common.close })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: '最後一個' })).toHaveFocus()
    unmount()
    expect(outside).toHaveFocus()
    outside.remove()
  })
})

describe('Menu on a phone', () => {
  const items = [
    { id: 'a', label: '修改我的名字', onSelect: vi.fn() },
    { id: 'b', label: '分享連結…', onSelect: vi.fn() },
  ]

  it('opens as a bottom sheet with the same keys, and closes back to its button', () => {
    render(onPhone('portrait', <Menu label="更多" icon={<span />} items={items} />))
    const trigger = screen.getByRole('button', { name: '更多' })
    fireEvent.click(trigger)
    const sheet = screen.getByRole('dialog', { name: '更多' })
    const menu = within(sheet).getByRole('menu', { name: '更多' })
    expect(within(menu).getByRole('menuitem', { name: '修改我的名字' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(within(menu).getByRole('menuitem', { name: '分享連結…' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '分享連結…' }))
    expect(items[1].onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()

    // The sheet's own close button
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: strings.common.close }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('is a popover on a desktop', () => {
    render(<Menu label="更多" icon={<span />} items={items} />)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menu', { name: '更多' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the phone toolbar and top bar', () => {
  const props = (overrides: Partial<ToolbarProps> = {}): ToolbarProps => ({
    micOn: true,
    camOn: true,
    onToggleMic: vi.fn(),
    onToggleCam: vi.fn(),
    devices: {
      audioinput: [{ deviceId: 'm1', label: '內建麥克風' }],
      videoinput: [{ deviceId: 'c1', label: '前鏡頭' }],
      audiooutput: [],
    },
    selected: { mic: null, cam: null, speaker: null },
    onSelect: vi.fn(),
    speakerSupported: false,
    memberCount: 6,
    canShareScreen: true,
    onToggleShare: vi.fn(),
    onToggleChat: vi.fn(),
    onComingSoon: vi.fn(),
    moreItems: [{ id: 'rename-self', label: strings.rename.self, onSelect: vi.fn() }],
    onLeave: vi.fn(),
    ...overrides,
  })

  it('has the five keys in one row, no sharing, and no 離開 (it is in the top bar)', () => {
    for (const layout of ['portrait', 'landscape'] as const) {
      const { unmount } = render(onPhone(layout, <Toolbar {...props()} />))
      const toolbar = screen.getByRole('toolbar', { name: strings.devices.controls })
      const names = [...toolbar.querySelectorAll('button:not([aria-haspopup])')].map((b) =>
        b.getAttribute('aria-label'),
      )
      expect(names).toEqual(['靜音', '關閉視訊', '聊天', '參與者（6 人）'])
      expect(within(toolbar).getByRole('button', { name: '更多' })).toBeInTheDocument()
      expect(within(toolbar).queryByRole('button', { name: '離開' })).toBeNull()
      unmount()
    }
  })

  it('opens the device menus as bottom sheets', () => {
    const p = props()
    render(onPhone('portrait', <Toolbar {...p} />))
    fireEvent.click(screen.getByRole('button', { name: strings.devices.camMenu }))
    const sheet = screen.getByRole('dialog', { name: strings.devices.camMenu })
    fireEvent.click(within(sheet).getByRole('menuitemradio', { name: /前鏡頭/ }))
    expect(p.onSelect).toHaveBeenCalledWith('cam', 'c1')
  })

  it('puts 離開 at the end of the top bar and shows the status only as a warning', () => {
    const onLeave = vi.fn()
    const bar = (warn: boolean) =>
      onPhone(
        'portrait',
        <TopBar
          title="週五聊天"
          startedAt={null}
          status={warn ? '連線中斷，正在重新連線…' : '目前 6 人在線'}
          warn={warn}
          onCopyLink={() => {}}
          onLeave={onLeave}
        />,
      )
    const { rerender } = render(bar(false))
    fireEvent.click(screen.getByRole('button', { name: '離開' }))
    expect(onLeave).toHaveBeenCalledOnce()
    // Still announced, just not shown
    expect(screen.getByRole('status')).toHaveTextContent('目前 6 人在線')
    expect(screen.getByRole('status')).toHaveStyle({ position: 'absolute' })
    rerender(bar(true))
    expect(screen.getByRole('status')).not.toHaveStyle({ position: 'absolute' })
  })

  it('keeps 離開 in the toolbar on a desktop', () => {
    render(
      <TopBar
        title="週五聊天"
        startedAt={null}
        status=""
        warn={false}
        onCopyLink={() => {}}
        onLeave={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: '離開' })).toBeNull()
  })
})

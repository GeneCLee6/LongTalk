import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PhoneLayoutContext, type PhoneLayout } from '../../src/components/layoutContext.ts'
import { MemberAudio } from '../../src/components/MemberAudio.tsx'
import { SharingBar } from '../../src/components/SharingBar.tsx'
import { Toolbar, type ToolbarProps } from '../../src/components/Toolbar.tsx'
import { strings } from '../../src/strings.ts'

// D2: the switch for the share's sound (e3-t04, AC-3.2), its playback apart from the layout, and
// what a browser that cannot share shows instead of the share button (e3-t10, AC-3.6)

const onPhone = (layout: PhoneLayout | null, ui: ReactNode) => (
  <PhoneLayoutContext.Provider value={layout}>{ui}</PhoneLayoutContext.Provider>
)

describe("the sharing bar's sound switch (e3-t04)", () => {
  it('has no switch when the share has no sound', () => {
    render(<SharingBar onStop={vi.fn()} />)
    const bar = screen.getByRole('region', { name: '你正在分享畫面' })
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['停止分享'])
    expect(bar).toHaveTextContent('其他人看得到你分享的畫面')
  })

  it('turns the sound off and on, saying what is shared and suggesting headphones', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<SharingBar onStop={vi.fn()} audio={{ on: true, onToggle }} />)
    const bar = screen.getByRole('region', { name: '你正在分享畫面' })
    expect(bar).toHaveTextContent('聽得到聲音；戴耳機可以避免回音')
    fireEvent.click(within(bar).getByRole('button', { name: '關閉分享音訊' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<SharingBar onStop={vi.fn()} audio={{ on: false, onToggle }} />)
    expect(bar).toHaveTextContent('分享音訊已關閉')
    fireEvent.click(within(bar).getByRole('button', { name: '開啟分享音訊' }))
    expect(onToggle).toHaveBeenCalledTimes(2)
    // Stopping stays where it was
    expect(within(bar).getByRole('button', { name: '停止分享' })).toBeInTheDocument()
  })
})

describe("the share's sound plays apart from the stage (e3-t04)", () => {
  it('is its own element, marked as the share, beside the microphones', () => {
    const track = {} as MediaStreamTrack
    const { container } = render(
      <div>
        <MemberAudio name="子安" track={track} speaker={null} />
        <MemberAudio name="子安" track={track} speaker={null} source="share" />
      </div>,
    )
    expect(container.querySelectorAll('audio[data-member="子安"]')).toHaveLength(1)
    expect(container.querySelectorAll('audio[data-share-audio="子安"]')).toHaveLength(1)
  })

  it('plays nothing until the sound arrives', () => {
    const { container } = render(
      <MemberAudio name="子安" track={null} speaker={null} source="share" />,
    )
    expect(container.querySelector('audio')).toBeNull()
  })
})

describe('where the browser cannot share (e3-t10)', () => {
  const props = (overrides: Partial<ToolbarProps> = {}): ToolbarProps => ({
    micOn: true,
    camOn: false,
    onToggleMic: vi.fn(),
    onToggleCam: vi.fn(),
    devices: { audioinput: [], videoinput: [], audiooutput: [] },
    selected: { mic: null, cam: null, speaker: null },
    onSelect: vi.fn(),
    speakerSupported: false,
    memberCount: 3,
    canShareScreen: false,
    onToggleShare: vi.fn(),
    onToggleChat: vi.fn(),
    onToggleParticipants: vi.fn(),
    moreItems: [{ id: 'rename-self', label: strings.rename.self, onSelect: vi.fn() }],
    onLeave: vi.fn(),
    ...overrides,
  })

  const openMore = () => {
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    return screen.getByRole('menu', { name: '更多' })
  }

  it('a phone: no share button; 更多 says phones cannot share and to join from a computer', () => {
    const p = props()
    render(onPhone('portrait', <Toolbar {...p} />))
    expect(screen.queryByRole('button', { name: '分享螢幕' })).toBeNull()
    const menu = openMore()
    const item = within(menu).getByRole('menuitem', { name: '分享螢幕' })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAccessibleDescription(
      '手機瀏覽器不能分享螢幕。要分享，請用電腦加入這間會議室。',
    )
    // It comes first, and the arrow keys reach it so the reason is read out
    expect(within(menu).getAllByRole('menuitem')[0]).toBe(item)
    expect(item).toHaveFocus()
    fireEvent.click(item)
    expect(p.onToggleShare).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: '更多' })).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(within(menu).getByRole('menuitem', { name: '修改我的名字' })).toHaveFocus()
  })

  it('a desktop browser without getDisplayMedia: 更多 suggests another browser', () => {
    render(onPhone(null, <Toolbar {...props()} />))
    expect(screen.queryByRole('button', { name: '分享螢幕' })).toBeNull()
    const item = within(openMore()).getByRole('menuitem', { name: '分享螢幕' })
    expect(item).toHaveAccessibleDescription(
      '這個瀏覽器不能分享螢幕。請改用電腦上的 Chrome、Edge 或 Firefox。',
    )
  })

  it('a desktop window as narrow as a phone can share: from 更多', () => {
    const p = props({ canShareScreen: true })
    const { rerender } = render(onPhone('portrait', <Toolbar {...p} />))
    expect(screen.queryByRole('button', { name: '分享螢幕' })).toBeNull()
    const item = within(openMore()).getByRole('menuitem', { name: '分享螢幕' })
    expect(item).not.toHaveAttribute('aria-disabled')
    fireEvent.click(item)
    expect(p.onToggleShare).toHaveBeenCalledTimes(1)
    rerender(onPhone('portrait', <Toolbar {...p} sharing />))
    fireEvent.click(within(openMore()).getByRole('menuitem', { name: '停止分享' }))
    expect(p.onToggleShare).toHaveBeenCalledTimes(2)
  })

  it('a desktop browser that can share: the button, and nothing about sharing in 更多', () => {
    render(onPhone(null, <Toolbar {...props({ canShareScreen: true })} />))
    expect(screen.getByRole('button', { name: '分享螢幕' })).toBeInTheDocument()
    expect(within(openMore()).queryByRole('menuitem', { name: '分享螢幕' })).toBeNull()
  })
})

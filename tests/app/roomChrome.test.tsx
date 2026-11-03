import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_ROOM_NAME_CHARS } from '../../shared/protocol.ts'
import { NameDialog } from '../../src/components/NameDialog.tsx'
import { Toolbar, type ToolbarProps } from '../../src/components/Toolbar.tsx'
import { TopBar } from '../../src/components/TopBar.tsx'
import { formatElapsed } from '../../src/room/elapsed.ts'
import { copyRoomLink, roomUrl, shareRoomLink } from '../../src/room/shareLink.ts'
import { strings } from '../../src/strings.ts'

// e4-t06 (the toolbar and the top bar) and e1-t05 (renaming, copying and sharing the link)

afterEach(() => {
  vi.useRealTimers()
})

describe('TopBar', () => {
  it('shows the room name, the running time and the status, and copies the link', () => {
    vi.useFakeTimers()
    let clock = 1_000_000 + (2 * 3600 + 47 * 60 + 13) * 1000
    const onCopyLink = vi.fn()
    render(
      <TopBar
        title="週五聊天"
        startedAt={1_000_000}
        status="目前 3 人在線"
        warn={false}
        onCopyLink={onCopyLink}
        now={() => clock}
      />,
    )
    expect(screen.getByRole('heading', { name: '週五聊天' })).toBeInTheDocument()
    const timer = screen.getByRole('timer', { name: '會議時間' })
    expect(timer).toHaveTextContent('02:47:13')
    clock += 1000
    act(() => vi.advanceTimersByTime(1000))
    expect(timer).toHaveTextContent('02:47:14')
    expect(screen.getByRole('status')).toHaveTextContent('目前 3 人在線')
    fireEvent.click(screen.getByRole('button', { name: '複製連結' }))
    expect(onCopyLink).toHaveBeenCalledOnce()
  })

  it('has no clock before anyone joined', () => {
    render(<TopBar title="會議室" startedAt={null} status="連線中…" warn onCopyLink={() => {}} />)
    expect(screen.queryByRole('timer')).toBeNull()
  })

  it('formats the elapsed time with hours always shown', () => {
    expect(formatElapsed(0)).toBe('00:00:00')
    expect(formatElapsed(-5000)).toBe('00:00:00')
    expect(formatElapsed((38 * 60 + 52) * 1000 + 999)).toBe('00:38:52')
    expect(formatElapsed(101 * 3600 * 1000)).toBe('101:00:00')
  })
})

describe('Toolbar', () => {
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
    canShareScreen: true,
    onToggleShare: vi.fn(),
    onToggleChat: vi.fn(),
    onToggleParticipants: vi.fn(),
    moreItems: [{ id: 'rename-self', label: strings.rename.self, onSelect: vi.fn() }],
    onLeave: vi.fn(),
    ...overrides,
  })

  it('has every button of DESIGN.md §4.3 in one toolbar', () => {
    render(<Toolbar {...props()} />)
    const toolbar = screen.getByRole('toolbar', { name: '會議控制' })
    const names = [...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual([
      '靜音',
      '開啟視訊',
      '分享螢幕',
      '聊天',
      '參與者（3 人）',
      '更多',
      '離開',
    ])
  })

  it('opens the participants, with the member count as the badge (F1, e1-t08)', () => {
    const p = props()
    const { rerender } = render(<Toolbar {...p} />)
    const button = screen.getByRole('button', { name: '參與者（3 人）' })
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button.querySelector('[data-count]')).toHaveAttribute('data-count', '3')
    fireEvent.click(button)
    expect(p.onToggleParticipants).toHaveBeenCalledTimes(1)
    rerender(<Toolbar {...p} participantsOpen />)
    expect(screen.getByRole('button', { name: '參與者（3 人）' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('opens the chat, with the unread count as the badge and in its name (D3, e5-t02)', () => {
    const p = props()
    const { rerender } = render(<Toolbar {...p} />)
    const chat = screen.getByRole('button', { name: '聊天' })
    expect(chat).not.toHaveAttribute('aria-disabled')
    expect(chat).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chat)
    expect(p.onToggleChat).toHaveBeenCalledTimes(1)
    rerender(<Toolbar {...p} chatUnread={3} />)
    const unread = screen.getByRole('button', { name: '聊天（3 則未讀）' })
    expect(unread.querySelector('[data-count]')).toHaveAttribute('data-count', '3')
    rerender(<Toolbar {...p} chatOpen />)
    expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('shares the screen, and stops sharing from the same button (D1, e3-t03)', () => {
    const p = props()
    const { rerender } = render(<Toolbar {...p} />)
    const share = screen.getByRole('button', { name: '分享螢幕' })
    expect(share).not.toHaveAttribute('aria-disabled')
    fireEvent.click(share)
    expect(p.onToggleShare).toHaveBeenCalledTimes(1)
    rerender(<Toolbar {...p} sharing />)
    fireEvent.click(screen.getByRole('button', { name: '停止分享' }))
    expect(p.onToggleShare).toHaveBeenCalledTimes(2)
  })

  it('hides screen sharing where the browser cannot (phones)', () => {
    render(<Toolbar {...props({ canShareScreen: false })} />)
    expect(screen.queryByRole('button', { name: '分享螢幕' })).toBeNull()
  })

  it('opens 更多 upwards with its items, and leaves', () => {
    const p = props()
    render(<Toolbar {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '修改我的名字' }))
    expect(p.moreItems[0].onSelect).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '離開' }))
    expect(p.onLeave).toHaveBeenCalledOnce()
  })
})

describe('NameDialog', () => {
  const open = () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(
      <NameDialog
        title={strings.rename.room}
        label={strings.rename.roomLabel}
        initial="Gene 的房間"
        maxChars={MAX_ROOM_NAME_CHARS}
        onSave={onSave}
        onCancel={onCancel}
      />,
    )
    return { onSave, onCancel, box: screen.getByRole('textbox', { name: '會議室名稱' }) }
  }

  it('saves the normalized name', () => {
    const { onSave, box } = open()
    expect(screen.getByRole('dialog', { name: '重新命名會議室' })).toBeInTheDocument()
    expect(box).toHaveValue('Gene 的房間')
    expect(box).toHaveFocus()
    fireEvent.change(box, { target: { value: '  週五   聊天 ' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(onSave).toHaveBeenCalledExactlyOnceWith('週五 聊天')
  })

  it('refuses an empty or too long name and says why', () => {
    const { onSave, box } = open()
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.submit(box)
    expect(screen.getByRole('alert')).toHaveTextContent('名字不能空白')
    fireEvent.change(box, { target: { value: 'x'.repeat(MAX_ROOM_NAME_CHARS + 1) } })
    fireEvent.submit(box)
    expect(screen.getByRole('alert')).toHaveTextContent(`最多 ${MAX_ROOM_NAME_CHARS} 個字`)
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('cancels with Escape or the cancel button', () => {
    const { onCancel, box } = open()
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('the room link (e1-t05)', () => {
  const URL_ = roomUrl('abcdefghij', 'https://longtalk.example')
  const clipboard = (fails = false) => ({
    writeText: vi.fn(async () => {
      if (fails) throw new Error('NotAllowedError')
    }),
  })
  const share = (error?: string) =>
    vi.fn(async () => {
      if (error) throw Object.assign(new Error(error), { name: error })
    })

  it('is the room page on this site', () => {
    expect(URL_).toBe('https://longtalk.example/r/abcdefghij')
  })

  it('copies with the clipboard, else the share sheet, else asks to copy by hand', async () => {
    const nav = { clipboard: clipboard(), share: share() }
    expect(await copyRoomLink(URL_, 'T', 'X', nav)).toBe('copied')
    expect(nav.clipboard.writeText).toHaveBeenCalledWith(URL_)
    expect(nav.share).not.toHaveBeenCalled()
    const refused = { clipboard: clipboard(true), share: share() }
    expect(await copyRoomLink(URL_, 'T', 'X', refused)).toBe('shared')
    expect(refused.share).toHaveBeenCalledWith({ title: 'T', text: 'X', url: URL_ })
    expect(await copyRoomLink(URL_, 'T', 'X', {})).toBe('failed')
  })

  it('shares with the share sheet, else copies; closing the sheet is not a failure', async () => {
    const nav = { clipboard: clipboard(), share: share() }
    expect(await shareRoomLink(URL_, 'T', 'X', nav)).toBe('shared')
    expect(nav.clipboard.writeText).not.toHaveBeenCalled()
    expect(await shareRoomLink(URL_, 'T', 'X', { ...nav, share: share('AbortError') })).toBe(
      'cancelled',
    )
    expect(await shareRoomLink(URL_, 'T', 'X', { ...nav, share: share('TypeError') })).toBe(
      'copied',
    )
    expect(await shareRoomLink(URL_, 'T', 'X', { clipboard: clipboard() })).toBe('copied')
    expect(await shareRoomLink(URL_, 'T', 'X', {})).toBe('failed')
  })
})

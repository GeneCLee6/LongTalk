import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Member, WaitingEntry } from '../../shared/protocol.ts'
import type { Role } from '../../shared/roles.ts'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { Toolbar } from '../../src/components/Toolbar.tsx'
import { TopBar } from '../../src/components/TopBar.tsx'
import { TurnedAwayScreen } from '../../src/components/TurnedAwayScreen.tsx'
import { WaitingScreen, type WaitingScreenProps } from '../../src/components/WaitingScreen.tsx'

const person = (id: string, name: string, role: Role): Member => ({
  id,
  name,
  role,
  joinedAt: 1,
  reconnecting: false,
  tracks: [],
  hand: null,
  signal: null,
})

const entry = (id: string, name: string, since: number, reconnecting = false): WaitingEntry => ({
  id,
  name,
  since,
  reconnecting,
})

function panel(you: string, overrides: Partial<Parameters<typeof ParticipantsPanel>[0]> = {}) {
  const props = {
    members: [
      person('g', 'Gene', 'host'),
      person('c', '小潔', 'cohost'),
      person('p', 'Wei', 'participant'),
    ],
    you,
    sharerIds: [],
    onAction: vi.fn(),
    onMuteAll: vi.fn(),
    onEndMeeting: vi.fn(),
    waiting: [entry('x', '阿明', 1), entry('y', '阿華', 2, true)],
    locked: false,
    waitingRoom: true,
    onLock: vi.fn(),
    onWaitingRoom: vi.fn(),
    onAdmit: vi.fn(),
    onDeny: vi.fn(),
    onAdmitAll: vi.fn(),
    ...overrides,
  }
  render(<ParticipantsPanel {...props} />)
  return props
}

describe('ParticipantsPanel: lock and waiting room (F2, e1-t11)', () => {
  it('gives the host the switches and who waits, with admit, deny and admit all', () => {
    const p = panel('g')
    const queue = screen.getByRole('list', { name: '等候室名單' })
    const rows = within(queue).getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['阿明', '阿華'])
    expect(within(rows[1]).getByText('重新連線中')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '放行 阿明 進入會議室' }))
    expect(p.onAdmit).toHaveBeenCalledWith('x')
    fireEvent.click(screen.getByRole('button', { name: '拒絕 阿華 進入' }))
    expect(p.onDeny).toHaveBeenCalledWith('y')
    fireEvent.click(screen.getByRole('button', { name: '全部放行' }))
    expect(p.onAdmitAll).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: '鎖定會議室' }))
    expect(p.onLock).toHaveBeenCalledWith(true)
  })

  it('gives a co-host the same (shared/roles.ts), a participant none of it', () => {
    panel('c')
    expect(screen.getByRole('switch', { name: '等候室' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '等候中 2' })).toBeInTheDocument()
  })

  it('shows a participant neither the switches nor the queue', () => {
    panel('p')
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('list', { name: '等候室名單' })).toBeNull()
  })

  it('has no 全部放行 for one person, and no section when nobody waits', () => {
    panel('g', { waiting: [entry('x', '阿明', 1)] })
    expect(screen.queryByRole('button', { name: '全部放行' })).toBeNull()
  })

  it('turns the waiting room on and off without asking when nobody waits', () => {
    const p = panel('g', { waiting: [], waitingRoom: false })
    expect(screen.queryByRole('list', { name: '等候室名單' })).toBeNull()
    const toggle = screen.getByRole('switch', { name: '等候室' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(p.onWaitingRoom).toHaveBeenCalledWith(true)
  })

  it('asks before turning it off with people waiting, and does nothing on cancel', () => {
    const p = panel('g')
    fireEvent.click(screen.getByRole('switch', { name: '等候室' }))
    const ask = screen.getByRole('alertdialog', { name: '關閉等候室？' })
    fireEvent.click(within(ask).getByRole('button', { name: '取消' }))
    expect(p.onWaitingRoom).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: '等候室' }))
    fireEvent.click(screen.getByRole('button', { name: '放行 2 人並關閉' }))
    expect(p.onWaitingRoom).toHaveBeenCalledWith(false)
  })
})

describe('Toolbar and TopBar (F2)', () => {
  const toolbar = (waitingCount: number) =>
    render(
      <Toolbar
        memberCount={3}
        waitingCount={waitingCount}
        canShareScreen={false}
        onToggleShare={() => {}}
        onToggleChat={() => {}}
        onToggleParticipants={() => {}}
        moreItems={[]}
        onLeave={() => {}}
        micOn
        camOn
        onToggleMic={() => {}}
        onToggleCam={() => {}}
        devices={{ audioinput: [], videoinput: [], audiooutput: [] }}
        selected={{ mic: null, cam: null, speaker: null }}
        onSelect={() => {}}
        speakerSupported={false}
      />,
    )

  it('counts who waits on the participants button, in its name too', () => {
    toolbar(2)
    const button = screen.getByRole('button', { name: '參與者（3 人，2 人在等候室）' })
    expect(button.querySelector('[data-count]')).toHaveAttribute('data-count', '2')
  })

  it('counts the members when nobody waits', () => {
    toolbar(0)
    expect(
      screen.getByRole('button', { name: '參與者（3 人）' }).querySelector('[data-count]'),
    ).toHaveAttribute('data-count', '3')
  })

  it('shows the padlock to everyone while the room is locked', () => {
    const { rerender } = render(
      <TopBar title="週五聊天" startedAt={null} status="" warn={false} onCopyLink={() => {}} />,
    )
    expect(screen.queryByRole('img', { name: '會議室已鎖定，新的人不能加入' })).toBeNull()
    rerender(
      <TopBar
        title="週五聊天"
        startedAt={null}
        status=""
        warn={false}
        locked
        onCopyLink={() => {}}
      />,
    )
    expect(screen.getByRole('img', { name: '會議室已鎖定，新的人不能加入' })).toHaveTextContent(
      '已鎖定',
    )
  })
})

describe('WaitingScreen (F2, e1-t11)', () => {
  function waitingScreen(overrides: Partial<WaitingScreenProps> = {}) {
    const props: WaitingScreenProps = {
      roomName: '週五聊天',
      lobby: {
        position: 1,
        count: 1,
        room: { name: '週五聊天', createdBy: 'Wei' },
        hostPresent: true,
      },
      connection: 'ok',
      camera: null,
      micOn: true,
      camOn: false,
      onToggleMic: vi.fn(),
      onToggleCam: vi.fn(),
      onLeave: vi.fn(),
      onRetry: vi.fn(),
      ...overrides,
    }
    render(<WaitingScreen {...props} />)
    return props
  }

  it('says where we are in the queue and that the host will let us in', () => {
    const p = waitingScreen()
    expect(screen.getByRole('heading', { name: '你在等候室' })).toBeInTheDocument()
    expect(screen.getByText('週五聊天')).toBeInTheDocument()
    expect(screen.getByText('你是下一位')).toBeInTheDocument()
    expect(screen.getByText('主持人會讓你進來，進去時不用再輸入名字。')).toBeInTheDocument()
    expect(screen.getByText('鏡頭已關閉')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '關閉麥克風' }))
    expect(p.onToggleMic).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '開啟鏡頭' }))
    expect(p.onToggleCam).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '離開等候室' }))
    expect(p.onLeave).toHaveBeenCalled()
  })

  it('counts the queue, and says when nobody who can admit is there', () => {
    waitingScreen({
      lobby: { position: 3, count: 4, room: { name: null, createdBy: 'Wei' }, hostPresent: false },
    })
    expect(screen.getByText('你排在第 3 位，共 4 人在等')).toBeInTheDocument()
    expect(screen.getByText(/主持人目前不在線上/)).toBeInTheDocument()
  })

  it('says it is reconnecting, and offers a retry once it gave up', () => {
    const p = waitingScreen({ connection: 'lost' })
    expect(screen.getByText(/連不上會議室/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重試' }))
    expect(p.onRetry).toHaveBeenCalled()
  })
})

describe('TurnedAwayScreen (F2)', () => {
  it.each([
    ['locked', '這間會議室已鎖定'],
    ['denied', '主持人沒有讓你進入'],
    ['waitExpired', '等候太久了'],
    ['leftWaiting', '你已離開等候室'],
  ] as const)('%s: says so, with 再試一次 and 回首頁, and no rating', (reason, title) => {
    const onRetry = vi.fn()
    const onHome = vi.fn()
    render(
      <TurnedAwayScreen reason={reason} roomName="週五聊天" onRetry={onRetry} onHome={onHome} />,
    )
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /分：/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '再試一次' }))
    fireEvent.click(screen.getByRole('button', { name: '回首頁' }))
    expect(onRetry).toHaveBeenCalled()
    expect(onHome).toHaveBeenCalled()
  })
})

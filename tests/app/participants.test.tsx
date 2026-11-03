import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Member, MemberTrack } from '../../shared/protocol.ts'
import type { Role } from '../../shared/roles.ts'
import { Drawer } from '../../src/components/Drawer.tsx'
import { LeftScreen } from '../../src/components/LeftScreen.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { PanelTabs } from '../../src/components/SidePanel.tsx'
import { PhoneLayoutContext } from '../../src/components/layoutContext.ts'

const track = (kind: MemberTrack['kind'], muted = false): MemberTrack => ({
  sessionId: 's',
  trackName: `${kind}-1`,
  kind,
  muted,
})

const person = (
  id: string,
  name: string,
  role: Role,
  joinedAt: number,
  tracks: MemberTrack[] = [track('mic'), track('cam')],
  reconnecting = false,
): Member => ({ id, name, role, joinedAt, reconnecting, tracks, hand: null })

const MEMBERS = [
  person('w', 'Wei', 'participant', 3, [track('mic', true)], true),
  person('x', '小潔', 'participant', 2, [track('mic'), track('cam'), track('screen')]),
  person('g', 'Gene', 'host', 1),
]

function panel(you: string, overrides: Partial<Parameters<typeof ParticipantsPanel>[0]> = {}) {
  const props = {
    members: MEMBERS,
    you,
    sharerId: 'x',
    onAction: vi.fn(),
    onMuteAll: vi.fn(),
    onEndMeeting: vi.fn(),
    ...overrides,
  }
  render(<ParticipantsPanel {...props} />)
  return props
}

const row = (name: string) => screen.getByRole('listitem', { name })

describe('ParticipantsPanel (e1-t08)', () => {
  it('lists us first, then the host, then by arrival, with role, mic, camera and sharing', () => {
    panel('x')
    const names = screen.getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))
    expect(names).toEqual(['小潔', 'Gene', 'Wei'])
    expect(within(row('Gene')).getByText('主持人')).toBeInTheDocument()
    expect(within(row('小潔')).getByText('你')).toBeInTheDocument()
    expect(within(row('小潔')).getByRole('img', { name: '正在分享畫面' })).toBeInTheDocument()
    expect(within(row('小潔')).getByRole('img', { name: '麥克風開著' })).toBeInTheDocument()
    expect(within(row('Wei')).getByRole('img', { name: '麥克風已關' })).toBeInTheDocument()
    expect(within(row('Wei')).getByRole('img', { name: '鏡頭沒開' })).toBeInTheDocument()
    expect(within(row('Wei')).getByText('重新連線中')).toBeInTheDocument()
  })

  it('offers a participant no controls at all', () => {
    panel('x')
    expect(screen.queryByRole('button', { name: /的動作$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '全員靜音' })).toBeNull()
    expect(screen.queryByRole('button', { name: '結束會議' })).toBeNull()
  })

  it('offers the host only what applies to each person, never to the host itself', () => {
    const p = panel('g')
    expect(screen.queryByRole('button', { name: '對 Gene 的動作' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '對 小潔 的動作' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '靜音',
      '關閉鏡頭',
      '停止分享',
      // F3 (e1-t16): the host names co-hosts and hands over
      '設為共同主持人',
      '設為主持人',
      '移出會議室',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: '停止分享' }))
    expect(p.onAction).toHaveBeenCalledWith('stopShare', 'x')
    // Wei is muted with no camera and reconnecting: only the co-host role and removing apply
    fireEvent.click(screen.getByRole('button', { name: '對 Wei 的動作' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '設為共同主持人',
      '移出會議室',
    ])
  })

  it('asks before removing, and before ending the meeting', () => {
    const p = panel('g')
    fireEvent.click(screen.getByRole('button', { name: '對 Wei 的動作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移出會議室' }))
    const ask = screen.getByRole('alertdialog', { name: '把 Wei 移出會議室？' })
    expect(ask).toHaveTextContent('10 分鐘內不能用同一個瀏覽器再加入')
    fireEvent.click(within(ask).getByRole('button', { name: '取消' }))
    expect(p.onAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '對 Wei 的動作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移出會議室' }))
    fireEvent.click(screen.getByRole('button', { name: '移出' }))
    expect(p.onAction).toHaveBeenCalledWith('remove', 'w')

    fireEvent.click(screen.getByRole('button', { name: '結束會議' }))
    expect(p.onEndMeeting).not.toHaveBeenCalled()
    const end = screen.getByRole('alertdialog', { name: '結束會議？' })
    fireEvent.click(within(end).getByRole('button', { name: '結束會議' }))
    expect(p.onEndMeeting).toHaveBeenCalledTimes(1)
  })

  it('mutes everyone in one press', () => {
    const p = panel('g')
    fireEvent.click(screen.getByRole('button', { name: '全員靜音' }))
    expect(p.onMuteAll).toHaveBeenCalledTimes(1)
  })

  it('gives a co-host the controls but not over the host, nor ending the meeting', () => {
    panel('x', {
      members: [person('g', 'Gene', 'host', 1), person('x', '小潔', 'cohost', 2), MEMBERS[0]],
    })
    expect(screen.queryByRole('button', { name: '對 Gene 的動作' })).toBeNull()
    expect(screen.getByRole('button', { name: '對 Wei 的動作' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全員靜音' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '結束會議' })).toBeNull()
    expect(within(row('小潔')).getByText('共同主持人')).toBeInTheDocument()
  })

  it('works in the phone drawer, the per-person menu as a bottom sheet', () => {
    render(
      <PhoneLayoutContext.Provider value="portrait">
        <Drawer variant="full" title="參與者" onClose={() => {}}>
          <ParticipantsPanel
            members={MEMBERS}
            you="g"
            sharerId={null}
            onAction={() => {}}
            onMuteAll={() => {}}
            onEndMeeting={() => {}}
          />
        </Drawer>
      </PhoneLayoutContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '對 小潔 的動作' }))
    expect(screen.getByRole('dialog', { name: '對 小潔 的動作' })).toBeInTheDocument()
  })
})

describe('PanelTabs', () => {
  it('switches with a click and with the arrow keys', () => {
    const onSelect = vi.fn()
    render(
      <PanelTabs
        label="側欄內容"
        tabs={[
          { id: 'chat', label: '聊天' },
          { id: 'participants', label: '參與者 3' },
        ]}
        selected="chat"
        onSelect={onSelect}
      />,
    )
    expect(screen.getByRole('tab', { name: '聊天' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: '參與者 3' }))
    expect(onSelect).toHaveBeenLastCalledWith('participants')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith('participants')
  })
})

describe('LeftScreen after a host control (F1)', () => {
  const props = { roomName: '週五聊天', onRate: vi.fn(), onRejoin: vi.fn(), onHome: vi.fn() }

  it('ended: the host ended the meeting, nothing to rejoin', () => {
    render(<LeftScreen reason="ended" {...props} />)
    expect(screen.getByRole('heading', { name: '主持人已結束會議' })).toBeInTheDocument()
    expect(screen.getByText('「週五聊天」已經結束，會議室也關閉了。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新加入' })).toBeNull()
  })

  it('removed: says so and for how long, nothing to rejoin', () => {
    render(<LeftScreen reason="removed" {...props} />)
    expect(screen.getByRole('heading', { name: '你已被移出會議室' })).toBeInTheDocument()
    expect(screen.getByText(/主持人把你移出了「週五聊天」/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新加入' })).toBeNull()
    expect(screen.getByRole('button', { name: '回首頁' })).toBeInTheDocument()
  })
})

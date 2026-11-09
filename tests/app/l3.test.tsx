// L3 (e10-t05; AC-10.4): the 分組討論室 panel for a host or co-host, the bar over the stage for
// everyone, the participants grouped by room, and what the room page says. Each only asks; the room
// decides (tests/worker/room-breakout*.test.ts).
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BREAKOUT_RECALL_MS, type BreakoutView } from '../../shared/breakout.ts'
import { PROTOCOL_VERSION, type ClientMessage, type Member } from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'
import { BreakoutBar } from '../../src/components/BreakoutBar.tsx'
import BreakoutPanel from '../../src/components/BreakoutPanel.tsx'
import { ParticipantsPanel } from '../../src/components/ParticipantsPanel.tsx'
import { useBreakoutNotices } from '../../src/components/useBreakoutClock.ts'
import { setLocale, strings } from '../../src/strings.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

const member = (
  id: string,
  name: string,
  role: Member['role'] = 'participant',
  group: string | null = null,
  joinedAt = id.charCodeAt(0),
): Member => ({
  id,
  name,
  role,
  joinedAt,
  reconnecting: false,
  tracks: [],
  hand: null,
  signal: null,
  mayRecord: false,
  group,
})

const OPEN: BreakoutView = {
  groups: [
    { id: 'g1', name: '第 1 組' },
    { id: 'g2', name: '第 2 組' },
  ],
  openedAt: 0,
  endsAt: 10 * 60_000,
  closesAt: null,
  broadcast: null,
}

describe('the 分組討論室 panel: opening the rooms', () => {
  const MEMBERS = [
    member('a', 'Gene', 'host'),
    member('b', 'Bob'),
    member('c', 'Carol'),
    member('d', 'Dan'),
  ]
  function setup(random = () => 0) {
    const send = vi.fn<(message: ClientMessage) => void>()
    render(<BreakoutPanel breakout={null} members={MEMBERS} you="a" send={send} random={random} />)
    return send
  }
  const form = () => within(screen.getByRole('form', { name: strings.breakout.setupLabel }))

  it('spreads everyone but us over two named rooms, for 15 minutes, by default', () => {
    const send = setup()
    expect(form().getByText(strings.breakout.autoHint(3, 2))).toBeTruthy()
    // Opening ends the poll and stops recordings: said before
    expect(form().getByText(strings.breakout.openEnds)).toBeTruthy()
    expect(
      (form().getByRole('textbox', { name: strings.breakout.name(1) }) as HTMLInputElement).value,
    ).toBe(strings.breakout.defaultName(1))
    fireEvent.click(form().getByRole('button', { name: strings.breakout.open }))
    expect(send).toHaveBeenCalledTimes(1)
    const message = send.mock.calls[0][0]
    if (message.t !== 'breakoutOpen') throw new Error(message.t)
    expect(message.groups).toEqual(['第 1 組', '第 2 組'])
    expect(message.minutes).toBe(15)
    expect(Object.keys(message.assign).sort()).toEqual(['b', 'c', 'd'])
    // Groups differ by at most one
    const sizes = [0, 1].map(
      (index) => Object.values(message.assign).filter((at) => at === index).length,
    )
    expect(Math.abs(sizes[0] - sizes[1])).toBeLessThanOrEqual(1)
  })

  it('more rooms, renamed, no time limit', () => {
    const send = setup()
    fireEvent.change(form().getByRole('combobox', { name: strings.breakout.count }), {
      target: { value: '3' },
    })
    fireEvent.change(form().getByRole('textbox', { name: strings.breakout.name(3) }), {
      target: { value: '  討論區 ' },
    })
    fireEvent.click(form().getByRole('checkbox', { name: strings.breakout.noLimit }))
    expect(
      (form().getByRole('spinbutton', { name: strings.breakout.minutes }) as HTMLInputElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(form().getByRole('button', { name: strings.breakout.open }))
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        t: 'breakoutOpen',
        groups: ['第 1 組', '第 2 組', '討論區'],
        minutes: null,
      }),
    )
  })

  it('by hand: only who was picked goes to a room, the rest stay in the main room', () => {
    const send = setup()
    fireEvent.click(form().getByRole('radio', { name: strings.breakout.manual }))
    fireEvent.change(form().getByRole('combobox', { name: strings.breakout.assignOf('Bob') }), {
      target: { value: '1' },
    })
    fireEvent.change(form().getByRole('combobox', { name: strings.breakout.assignOf('Carol') }), {
      target: { value: '0' },
    })
    // Not us: we join a room ourselves
    expect(form().queryByRole('combobox', { name: strings.breakout.assignOf('Gene') })).toBeNull()
    fireEvent.click(form().getByRole('button', { name: strings.breakout.open }))
    expect(send).toHaveBeenCalledWith({
      t: 'breakoutOpen',
      groups: ['第 1 組', '第 2 組'],
      assign: { b: 1, c: 0 },
      minutes: 15,
    })
  })

  it('refuses an empty name or a length that is not one', () => {
    setup()
    const open = form().getByRole('button', { name: strings.breakout.open }) as HTMLButtonElement
    fireEvent.change(form().getByRole('textbox', { name: strings.breakout.name(2) }), {
      target: { value: '   ' },
    })
    expect(open.disabled).toBe(true)
    fireEvent.change(form().getByRole('textbox', { name: strings.breakout.name(2) }), {
      target: { value: 'B' },
    })
    expect(open.disabled).toBe(false)
    for (const value of ['0', '', '1.5', '241']) {
      fireEvent.change(form().getByRole('spinbutton', { name: strings.breakout.minutes }), {
        target: { value },
      })
      expect(open.disabled).toBe(true)
    }
  })
})

describe('the 分組討論室 panel while the rooms are open', () => {
  const MEMBERS = [
    member('a', 'Gene', 'host'),
    member('b', 'Bob', 'participant', 'g1'),
    member('c', 'Carol', 'participant', 'g2'),
  ]
  function running(breakout: BreakoutView = OPEN, at = 0) {
    const send = vi.fn<(message: ClientMessage) => void>()
    render(
      <BreakoutPanel breakout={breakout} members={MEMBERS} you="a" send={send} now={() => at} />,
    )
    return send
  }

  it('lists each room with its people and the time left', () => {
    running(OPEN, 60_000)
    expect(screen.getByRole('timer').textContent).toBe(strings.breakout.remaining('00:09:00'))
    const room1 = within(screen.getByRole('region', { name: '第 1 組' }))
    expect(room1.getByText('Bob')).toBeTruthy()
    expect(room1.queryByText('Carol')).toBeNull()
    const main = within(screen.getByRole('region', { name: strings.breakout.mainRoom }))
    expect(main.getByText('Gene')).toBeTruthy()
  })

  it('moves someone to another room or back to the main room', () => {
    const send = running()
    const select = screen.getByRole('combobox', { name: strings.breakout.moveOf('Bob') })
    expect((select as HTMLSelectElement).value).toBe('g1')
    fireEvent.change(select, { target: { value: 'g2' } })
    expect(send).toHaveBeenCalledWith({ t: 'breakoutMove', memberId: 'b', group: 'g2' })
    fireEvent.change(screen.getByRole('combobox', { name: strings.breakout.moveOf('Carol') }), {
      target: { value: 'main' },
    })
    expect(send).toHaveBeenCalledWith({ t: 'breakoutMove', memberId: 'c', group: null })
  })

  it('joins a room ourselves; from a room, comes back', () => {
    const send = running()
    expect(screen.queryByRole('button', { name: strings.breakout.leave })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.breakout.joinRoom('第 2 組') }))
    expect(send).toHaveBeenCalledWith({ t: 'breakoutMove', memberId: 'a', group: 'g2' })
  })

  it('from a room: 回到主會議室', () => {
    const send = vi.fn<(message: ClientMessage) => void>()
    render(
      <BreakoutPanel
        breakout={OPEN}
        members={[member('a', 'Gene', 'host', 'g1'), ...MEMBERS.slice(1)]}
        you="a"
        send={send}
      />,
    )
    expect(screen.queryByRole('button', { name: strings.breakout.joinRoom('第 1 組') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.breakout.leave }))
    expect(send).toHaveBeenCalledWith({ t: 'breakoutMove', memberId: 'a', group: null })
  })

  it('broadcasts to every room, then clears the box', () => {
    const send = running()
    const box = screen.getByRole('textbox', {
      name: strings.breakout.broadcastLabel,
    }) as HTMLInputElement
    const sendButton = screen.getByRole('button', {
      name: strings.breakout.broadcastSend,
    }) as HTMLButtonElement
    expect(sendButton.disabled).toBe(true)
    fireEvent.change(box, { target: { value: ' 還剩 5 分鐘 ' } })
    fireEvent.click(sendButton)
    expect(send).toHaveBeenCalledWith({ t: 'breakoutBroadcast', text: '還剩 5 分鐘' })
    expect(box.value).toBe('')
  })

  it('recalls everyone; during the recall, ends at once', () => {
    const send = running()
    fireEvent.click(screen.getByRole('button', { name: strings.breakout.recall }))
    expect(send).toHaveBeenLastCalledWith({ t: 'breakoutClose', now: false })
  })

  it('during the recall: the seconds left and 立即結束', () => {
    const send = running({ ...OPEN, closesAt: 100_000 }, 100_000 - 42_500)
    expect(screen.getByRole('timer').textContent).toBe(strings.breakout.closing(43))
    expect(screen.queryByRole('button', { name: strings.breakout.recall })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.breakout.endNow }))
    expect(send).toHaveBeenCalledWith({ t: 'breakoutClose', now: true })
  })
})

describe('the breakout bar', () => {
  it('in a room: its name and the time left, ticking', () => {
    vi.useFakeTimers()
    try {
      let at = 0
      render(<BreakoutBar breakout={OPEN} room="第 1 組" now={() => at} />)
      const bar = within(screen.getByRole('region', { name: strings.breakout.label }))
      expect(bar.getByText(strings.breakout.inRoom('第 1 組'))).toBeTruthy()
      expect(bar.getByRole('timer').textContent).toBe(strings.breakout.remaining('00:10:00'))
      at = 61_000
      act(() => void vi.advanceTimersByTime(1_000))
      expect(bar.getByRole('timer').textContent).toBe(strings.breakout.remaining('00:08:59'))
      expect(bar.queryByRole('button', { name: strings.breakout.manage })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('during the recall: how long until back in the main room', () => {
    render(
      <BreakoutBar
        breakout={{ ...OPEN, closesAt: BREAKOUT_RECALL_MS }}
        room="第 1 組"
        now={() => 0}
      />,
    )
    expect(screen.getByRole('timer').textContent).toBe(strings.breakout.backIn(60))
  })

  it('in the main room: that they are on; a host gets the panel’s button', () => {
    const onManage = vi.fn()
    render(<BreakoutBar breakout={OPEN} room={null} onManage={onManage} now={() => 0} />)
    expect(screen.getByText(strings.breakout.inProgress)).toBeTruthy()
    expect(screen.queryByRole('timer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: strings.breakout.manage }))
    expect(onManage).toHaveBeenCalled()
  })

  it('shows the last broadcast until dismissed', () => {
    const breakout = { ...OPEN, broadcast: { text: '回來集合', by: 'Gene', at: 5 } }
    const { rerender } = render(<BreakoutBar breakout={breakout} room="第 1 組" now={() => 0} />)
    const banner = screen.getByRole('region', { name: strings.breakout.broadcastFrom('Gene') })
    expect(within(banner).getByText('回來集合')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: strings.breakout.dismissBroadcast }))
    expect(screen.queryByText('回來集合')).toBeNull()
    rerender(
      <BreakoutBar
        breakout={{ ...OPEN, broadcast: { text: '再一則', by: 'Gene', at: 6 } }}
        room="第 1 組"
        now={() => 0}
      />,
    )
    expect(screen.getByText('再一則')).toBeTruthy()
  })
})

describe('what is said when the rooms change', () => {
  it('a broadcast, the recall and our moves, once each; nothing for what was so before', () => {
    const show = vi.fn()
    const { rerender } = renderHook(
      ({ breakout, group }: { breakout: BreakoutView | null; group: string | null }) =>
        useBreakoutNotices(breakout, group, show, true, () => 0),
      {
        initialProps: {
          breakout: { ...OPEN, broadcast: { text: 'old', by: 'G', at: 1 } } as BreakoutView | null,
          group: 'g1' as string | null,
        },
      },
    )
    expect(show).not.toHaveBeenCalled()
    rerender({ breakout: { ...OPEN, broadcast: { text: '集合', by: 'Gene', at: 2 } }, group: 'g1' })
    expect(show).toHaveBeenLastCalledWith(strings.breakout.broadcastToast('Gene', '集合'))
    rerender({ breakout: { ...OPEN, broadcast: { text: '集合', by: 'Gene', at: 2 } }, group: 'g2' })
    expect(show).toHaveBeenLastCalledWith(strings.breakout.movedTo('第 2 組'))
    rerender({
      breakout: {
        ...OPEN,
        broadcast: { text: '集合', by: 'Gene', at: 2 },
        closesAt: BREAKOUT_RECALL_MS,
      },
      group: 'g2',
    })
    expect(show).toHaveBeenLastCalledWith(strings.breakout.recalled(60))
    rerender({ breakout: null, group: null })
    expect(show).toHaveBeenLastCalledWith(strings.breakout.backToMain)
    expect(show).toHaveBeenCalledTimes(4)
  })
})

describe('the participants panel while the rooms are open', () => {
  it('a host sees everyone grouped by room, the main room first', () => {
    render(
      <ParticipantsPanel
        members={[
          member('a', 'Gene', 'host'),
          member('b', 'Bob', 'participant', 'g1'),
          member('c', 'Carol', 'participant', 'g2'),
        ]}
        you="a"
        sharerIds={[]}
        onAction={() => {}}
        onMuteAll={() => {}}
        onEndMeeting={() => {}}
        breakout={OPEN}
      />,
    )
    const list = screen.getByRole('list', { name: strings.participants.list })
    const headings = within(list)
      .getAllByRole('heading')
      .map((heading) => heading.textContent)
    expect(headings).toEqual([
      strings.breakout.mainRoom + strings.breakout.roomCount(1),
      '第 1 組' + strings.breakout.roomCount(1),
      '第 2 組' + strings.breakout.roomCount(1),
    ])
    expect(within(screen.getByRole('list', { name: /第 1 組/ })).getByText('Bob')).toBeTruthy()
  })
})

// ── The room page ──────────────────────────────────────────────────────────────────────────

const ROOM_ID = 'abcdefghij'
const TOKEN = 'S'.repeat(43)

class RoomSocket {
  static instances: RoomSocket[] = []
  static members: Member[] = []
  static breakout: BreakoutView | null = null
  static shares: Record<string, { memberId: string; since: number }> = {}
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    RoomSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(data: string) {
    this.sent.push(data)
    if ((JSON.parse(data) as { t: string }).t !== 'join') return
    const state = {
      room: { id: ROOM_ID, createdAt: 1, shares: RoomSocket.shares, spotlight: null },
      members: Object.fromEntries(RoomSocket.members.map((m) => [m.id, m])),
      waiting: {},
      usage: 'normal',
      breakout: RoomSocket.breakout,
    }
    queueMicrotask(() =>
      this.receive({ t: 'welcome', v: PROTOCOL_VERSION, you: 'a', token: TOKEN, rev: 1, state }),
    )
  }
  close() {}
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

describe('breakout rooms in the room page', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', RoomSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === `/api/rooms/${ROOM_ID}`
          ? Response.json({ id: ROOM_ID, createdAt: 1, memberCount: 1 })
          : Response.json({ error: 'not_found' }, { status: 404 }),
      ),
    )
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('longtalk.client', 'browser-id-0123456789')
    localStorage.setItem('longtalk.name', 'Gene')
    sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    RoomSocket.instances = []
    RoomSocket.breakout = null
    RoomSocket.shares = {}
    window.history.replaceState(null, '', '/')
  })
  async function enter(members: Member[], breakout: BreakoutView | null = null) {
    RoomSocket.members = members
    RoomSocket.breakout = breakout
    window.history.pushState({}, '', `/r/${ROOM_ID}`)
    render(<App />)
    await screen.findByRole('toolbar', { name: strings.devices.controls })
    await screen.findByRole('button', { name: strings.toolbar.more })
    return RoomSocket.instances.at(-1)!
  }
  const openMore = () => fireEvent.click(screen.getByRole('button', { name: strings.toolbar.more }))

  it('a host opens the panel from 更多 (its own chunk) and opens the rooms', async () => {
    const socket = await enter([member('a', 'Gene', 'host'), member('w', 'Wei')])
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: strings.breakout.menu }))
    const panel = await screen.findByRole('complementary', { name: strings.breakout.title })
    const form = await within(panel).findByRole('form', { name: strings.breakout.setupLabel })
    fireEvent.click(within(form).getByRole('radio', { name: strings.breakout.manual }))
    fireEvent.change(
      within(form).getByRole('combobox', { name: strings.breakout.assignOf('Wei') }),
      {
        target: { value: '1' },
      },
    )
    fireEvent.click(within(form).getByRole('button', { name: strings.breakout.open }))
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      t: 'breakoutOpen',
      groups: ['第 1 組', '第 2 組'],
      assign: { w: 1 },
      minutes: 15,
    })
  })

  it('a participant has no such menu entry', async () => {
    await enter([member('a', 'Gene'), member('w', 'Wei', 'host')])
    openMore()
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: strings.breakout.menu })).toBeNull()
  })

  it('a member in a room sees its name and the time left, then the broadcast and the recall', async () => {
    const breakout = { ...OPEN, endsAt: Date.now() + 5 * 60_000 }
    const socket = await enter(
      [
        member('a', 'Gene', 'participant', 'g2'),
        member('w', 'Wei', 'host'),
        member('b', 'Bob', 'participant', 'g2'),
      ],
      breakout,
    )
    const bar = within(await screen.findByRole('region', { name: strings.breakout.label }))
    expect(bar.getByText(strings.breakout.inRoom('第 2 組'))).toBeTruthy()
    expect(bar.getByRole('timer').textContent).toMatch(/00:0[45]:/)
    expect(bar.queryByRole('button', { name: strings.breakout.manage })).toBeNull()
    // The host (in the main room) is not in our scoped view
    expect(screen.queryByRole('figure', { name: /Wei/ })).toBeNull()
    act(() =>
      socket.receive({
        t: 'patch',
        rev: 2,
        ops: [
          { op: 'set', path: ['breakout', 'broadcast'], value: { text: '集合', by: 'Wei', at: 9 } },
        ],
      }),
    )
    expect(screen.getByRole('region', { name: strings.breakout.broadcastFrom('Wei') })).toBeTruthy()
    expect(screen.getByText(strings.breakout.broadcastToast('Wei', '集合'))).toBeTruthy()
    act(() =>
      socket.receive({
        t: 'patch',
        rev: 3,
        ops: [
          { op: 'set', path: ['breakout', 'closesAt'], value: Date.now() + BREAKOUT_RECALL_MS },
        ],
      }),
    )
    expect(screen.getByRole('timer').textContent).toMatch(
      new RegExp(strings.breakout.backIn(60).replace('60', '(59|60)')),
    )
  })

  it('the room refusing something while the rooms are open is explained', async () => {
    const socket = await enter(
      [member('a', 'Gene', 'host'), member('w', 'Wei', 'participant', 'g1')],
      OPEN,
    )
    act(() => socket.receive({ t: 'error', code: 'breakout_active' }))
    expect(screen.getByText(strings.breakout.busy)).toBeTruthy()
    // In the main room, a host sees that they are on and can open the panel from the bar
    fireEvent.click(screen.getByRole('button', { name: strings.breakout.manage }))
    const panel = await screen.findByRole('complementary', { name: strings.breakout.title })
    expect(
      await within(panel).findByRole('combobox', { name: strings.breakout.moveOf('Wei') }),
    ).toBeTruthy()
  })

  it('a host sees who shares in another room, and acts on them by name', async () => {
    RoomSocket.shares = { w: { memberId: 'w', since: 5 } }
    const wei = { ...member('w', 'Wei', 'participant', 'g1'), hand: 3 }
    await enter([member('a', 'Gene', 'host'), wei], OPEN)
    fireEvent.click(screen.getByRole('button', { name: /^參與者/ }))
    const row = within(await screen.findByRole('listitem', { name: 'Wei' }))
    expect(row.getByRole('img', { name: strings.participants.sharing })).toBeTruthy()
    fireEvent.click(row.getByRole('button', { name: strings.participants.actions('Wei') }))
    fireEvent.click(screen.getByRole('menuitem', { name: strings.participants.stopShare }))
    fireEvent.click(row.getByRole('button', { name: strings.participants.actions('Wei') }))
    fireEvent.click(screen.getByRole('menuitem', { name: strings.reactions.lowerHand }))
    expect(screen.getByText(strings.reactions.lowered('Wei'))).toBeTruthy()
  })

  it('no recording while the rooms are open: 開始錄影 is greyed, with why', async () => {
    await enter([member('a', 'Gene', 'host'), member('w', 'Wei', 'participant', 'g1')], OPEN)
    openMore()
    const item = screen.getByRole('menuitem', { name: strings.record.start })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain(strings.breakout.noRecording)
  })

  it('a host alone in a room can still hand over: the leave question lists the main room', async () => {
    await enter([member('a', 'Gene', 'host', 'g1'), member('w', 'Wei')], OPEN)
    fireEvent.click(
      within(screen.getByRole('toolbar', { name: strings.devices.controls })).getByRole('button', {
        name: strings.toolbar.leave,
      }),
    )
    const dialog = await screen.findByRole('dialog', { name: strings.leave.title })
    expect(within(dialog).getByText(strings.leave.endForAll)).toBeTruthy()
    expect(within(dialog).getAllByText(/Wei/).length).toBeGreaterThan(0)
  })

  it('reads in English too', () => {
    setLocale('en', false)
    expect(strings.breakout.closing(1)).toBe('Everyone back in the main room in 1 second')
    expect(strings.breakout.roomCount(3)).toBe('3 people')
    setLocale('zh-TW', false)
  })
})

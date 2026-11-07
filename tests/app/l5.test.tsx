// L5 (e5-t07, e5-t08; AC-5.5): the 互動 panel, the results in the chat, the countdown on the top bar
// and the agenda bar. Each only asks; the room decides (tests/worker/room-l5.test.ts).
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TIMER_SHOWN_AFTER_MS, type AgendaInfo, type PollView } from '../../shared/interact.ts'
import type { ClientMessage } from '../../shared/protocol.ts'
import { AgendaBar } from '../../src/components/AgendaBar.tsx'
import { ChatPanel } from '../../src/components/ChatPanel.tsx'
import InteractPanel from '../../src/components/InteractPanel.tsx'
import { TopBar } from '../../src/components/TopBar.tsx'
import { setLocale, strings } from '../../src/strings.ts'

const POLL: PollView = {
  id: 7,
  by: 'Alice',
  question: '午餐吃什麼',
  options: ['麵', '飯'],
  multi: false,
  anonymous: false,
  counts: [1, 0],
  voters: 1,
  votes: [{ name: 'Carol', choices: [0] }],
}

function panel(
  overrides: Partial<Parameters<typeof InteractPanel>[0]> = {},
): { send: ReturnType<typeof vi.fn<(message: ClientMessage) => void>> } {
  const send = vi.fn<(message: ClientMessage) => void>()
  render(
    <InteractPanel
      poll={null}
      myVote={null}
      timer={null}
      agenda={null}
      manage={false}
      send={send}
      {...overrides}
    />,
  )
  return { send }
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } })

describe('the 互動 panel', () => {
  it('a participant with no poll sees that, and none of the host’s forms', () => {
    panel()
    expect(screen.getByText(strings.poll.none)).toBeTruthy()
    expect(screen.queryByRole('form', { name: strings.poll.formLabel })).toBeNull()
    expect(screen.queryByRole('form', { name: strings.timer.title })).toBeNull()
    expect(screen.queryByRole('form', { name: strings.agenda.title })).toBeNull()
  })

  it('a host starts a poll: empty options left out, the room’s own check before sending', () => {
    const { send } = panel({ manage: true })
    const start = screen.getByRole('button', { name: strings.poll.start }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    type(strings.poll.question, ' 午餐吃什麼 ')
    type(strings.poll.option(1), '麵')
    expect(start.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: strings.poll.addOption }))
    type(strings.poll.option(3), '飯')
    expect(start.disabled).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: strings.poll.multi }))
    fireEvent.click(screen.getByRole('checkbox', { name: strings.poll.anonymous }))
    fireEvent.click(start)
    expect(send).toHaveBeenCalledWith({
      t: 'pollStart',
      question: '午餐吃什麼',
      options: ['麵', '飯'],
      multi: true,
      anonymous: true,
    })
  })

  it('two options that are the same cannot start', () => {
    panel({ manage: true })
    type(strings.poll.question, 'q')
    type(strings.poll.option(1), '同')
    type(strings.poll.option(2), '同')
    expect((screen.getByRole('button', { name: strings.poll.start }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('one choice: radios; the answer goes to the room, and can be changed', () => {
    const { send } = panel({ poll: POLL })
    expect(screen.queryByRole('button', { name: strings.poll.end })).toBeNull()
    const vote = screen.getByRole('button', { name: strings.poll.vote }) as HTMLButtonElement
    expect(vote.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '飯' }))
    fireEvent.click(vote)
    expect(send).toHaveBeenCalledWith({ t: 'pollVote', poll: 7, choices: [1] })
  })

  it('having answered: what we said is picked, and only a different answer can be sent', () => {
    const { send } = panel({ poll: POLL, myVote: [0] })
    expect((screen.getByRole('radio', { name: '麵' }) as HTMLInputElement).checked).toBe(true)
    const change = screen.getByRole('button', { name: strings.poll.change }) as HTMLButtonElement
    expect(change.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '飯' }))
    expect(change.disabled).toBe(false)
    fireEvent.click(change)
    expect(send).toHaveBeenCalledWith({ t: 'pollVote', poll: 7, choices: [1] })
  })

  it('several choices: checkboxes, picked and unpicked', () => {
    const { send } = panel({ poll: { ...POLL, multi: true } })
    fireEvent.click(screen.getByRole('checkbox', { name: '麵' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '飯' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '麵' }))
    fireEvent.click(screen.getByRole('button', { name: strings.poll.vote }))
    expect(send).toHaveBeenCalledWith({ t: 'pollVote', poll: 7, choices: [1] })
  })

  it('shows live results in words, with names only when the poll has them', () => {
    panel({ poll: POLL })
    const results = within(screen.getByRole('list', { name: strings.poll.results }))
    expect(results.getByText(strings.poll.count(1, 100))).toBeTruthy()
    expect(results.getByText('Carol')).toBeTruthy()
    expect(screen.getByText(strings.poll.voters(1))).toBeTruthy()
  })

  it('an anonymous poll shows no names, and says it is anonymous', () => {
    const { votes: _votes, ...anonymous } = POLL
    panel({ poll: { ...anonymous, anonymous: true } })
    expect(screen.queryByText('Carol')).toBeNull()
    expect(screen.getByText(strings.poll.meta('Alice', false, true))).toBeTruthy()
  })

  it('a host ends the poll', () => {
    const { send } = panel({ poll: POLL, manage: true })
    fireEvent.click(screen.getByRole('button', { name: strings.poll.end }))
    expect(send).toHaveBeenCalledWith({ t: 'pollEnd', poll: 7 })
  })

  it('a host sets the countdown in minutes, and ends it', () => {
    const { send } = panel({ manage: true, timer: { endsAt: 1, seconds: 60 } })
    fireEvent.change(screen.getByRole('spinbutton', { name: strings.timer.minutes }), {
      target: { value: '1.5' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.timer.restart }))
    expect(send).toHaveBeenCalledWith({ t: 'timer', seconds: 90 })
    fireEvent.click(screen.getByRole('button', { name: strings.timer.stop }))
    expect(send).toHaveBeenCalledWith({ t: 'timer', seconds: null })
  })

  it('refuses a countdown that is not a length of time', () => {
    panel({ manage: true })
    const start = screen.getByRole('button', { name: strings.timer.start }) as HTMLButtonElement
    expect(start.disabled).toBe(false)
    for (const value of ['0', '-3', '', '100000']) {
      fireEvent.change(screen.getByRole('spinbutton', { name: strings.timer.minutes }), {
        target: { value },
      })
      expect(start.disabled).toBe(true)
    }
  })

  it('a host writes the agenda: rows without a title are left out', () => {
    const { send } = panel({ manage: true })
    type(strings.agenda.item(1), '開場')
    fireEvent.click(screen.getByRole('button', { name: strings.agenda.add }))
    fireEvent.click(screen.getByRole('button', { name: strings.agenda.save }))
    expect(send).toHaveBeenCalledWith({ t: 'agenda', items: [{ title: '開場', minutes: 5 }] })
  })

  it('a host clears the agenda', () => {
    const { send } = panel({
      manage: true,
      agenda: { items: [{ title: '開場', minutes: 5 }], current: 0 },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.agenda.clear }))
    expect(send).toHaveBeenCalledWith({ t: 'agenda', items: [] })
  })

  it('keeps the focus in the panel when the button that had it goes', () => {
    const send = vi.fn()
    const props = { myVote: null, timer: null, agenda: null, manage: true, send }
    const { rerender } = render(<InteractPanel {...props} poll={POLL} />)
    const end = screen.getByRole('button', { name: strings.poll.end })
    end.focus()
    rerender(<InteractPanel {...props} poll={POLL} />)
    expect(document.activeElement).toBe(end)
    rerender(<InteractPanel {...props} poll={null} />)
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement?.contains(screen.getByRole('form', { name: strings.poll.formLabel }))).toBe(true)
  })

  it('the agenda form follows what the room has, without losing what has the focus', () => {
    const send = vi.fn()
    const props = { poll: null, myVote: null, timer: null, manage: true, send }
    const { rerender } = render(<InteractPanel {...props} agenda={null} />)
    type(strings.agenda.item(1), '  開場 ')
    const save = screen.getByRole('button', { name: strings.agenda.save })
    save.focus()
    rerender(
      <InteractPanel
        {...props}
        agenda={{ items: [{ title: '開場', minutes: 5 }], current: 0 }}
      />,
    )
    expect((screen.getByRole('textbox', { name: strings.agenda.item(1) }) as HTMLInputElement).value).toBe('開場')
    expect(document.activeElement).toBe(save)
  })

  it('reads in English too', () => {
    setLocale('en', false)
    panel()
    expect(screen.getByText(strings.poll.none)).toBeTruthy()
    expect(strings.poll.voters(1)).toBe('1 person voted')
    expect(strings.poll.count(2, 50)).toBe('2 votes · 50%')
  })
})

describe('a poll’s results in the chat', () => {
  it('shows the question, the counts and the names', () => {
    render(
      <ChatPanel
        messages={[
          {
            id: 1,
            from: 'm1',
            name: 'Alice',
            text: '午餐吃什麼',
            at: 1,
            poll: {
              question: '午餐吃什麼',
              options: ['麵', '飯'],
              multi: false,
              anonymous: false,
              counts: [1, 0],
              voters: 1,
              votes: [{ name: 'Carol', choices: [0] }],
            },
          },
        ]}
        you="m2"
        onSend={() => 'sent'}
      />,
    )
    const log = within(screen.getByRole('log', { name: strings.chat.messages }))
    expect(log.getByText(strings.poll.resultTitle('午餐吃什麼'))).toBeTruthy()
    expect(log.getByText(strings.poll.count(1, 100))).toBeTruthy()
    expect(log.getByText('Carol')).toBeTruthy()
    expect(log.getByText(strings.poll.voters(1))).toBeTruthy()
  })
})

describe('the countdown on the top bar', () => {
  function bar(now: () => number, endsAt: number) {
    return render(
      <TopBar
        title="會議"
        startedAt={null}
        status=""
        warn={false}
        timer={{ endsAt, seconds: 60 }}
        onCopyLink={() => {}}
        now={now}
      />,
    )
  }
  const timer = () => screen.queryByRole('timer', { name: strings.timer.label })

  it('counts down, says when it is over, then goes', () => {
    vi.useFakeTimers()
    try {
      let at = 1_000
      bar(() => at, 61_000)
      expect(timer()?.textContent).toBe('00:01:00')
      at += 1_500
      act(() => void vi.advanceTimersByTime(1_000))
      expect(timer()?.textContent).toBe('00:00:59')
      at = 61_000
      act(() => void vi.advanceTimersByTime(1_000))
      expect(timer()?.textContent).toBe(strings.timer.done)
      at = 61_000 + TIMER_SHOWN_AFTER_MS
      act(() => void vi.advanceTimersByTime(1_000))
      expect(timer()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('someone coming in long after it ended does not see it', () => {
    bar(() => 10 * 60_000, 1_000)
    expect(timer()).toBeNull()
  })
})

describe('the agenda bar', () => {
  const AGENDA: AgendaInfo = {
    items: [
      { title: '開場', minutes: 5 },
      { title: '討論', minutes: 20 },
    ],
    current: 0,
  }

  it('lists every item with its time; the current one is marked, not by colour alone', () => {
    render(<AgendaBar agenda={AGENDA} />)
    const bar = within(screen.getByRole('navigation', { name: strings.agenda.label }))
    expect(bar.getByText(strings.agenda.minutes(20))).toBeTruthy()
    const items = bar.getAllByRole('listitem')
    expect(items[0].getAttribute('aria-current')).toBe('step')
    expect(items[1].getAttribute('aria-current')).toBeNull()
    expect(bar.queryByRole('button')).toBeNull()
  })

  it('a host moves it along, and it stops at the ends', () => {
    const onCurrent = vi.fn()
    const { rerender } = render(<AgendaBar agenda={AGENDA} onCurrent={onCurrent} />)
    const previous = () =>
      screen.getByRole('button', { name: strings.agenda.previous }) as HTMLButtonElement
    const next = () => screen.getByRole('button', { name: strings.agenda.next }) as HTMLButtonElement
    expect(previous().disabled).toBe(true)
    fireEvent.click(next())
    expect(onCurrent).toHaveBeenCalledWith(1)
    rerender(<AgendaBar agenda={{ ...AGENDA, current: 1 }} onCurrent={onCurrent} />)
    expect(next().disabled).toBe(true)
    fireEvent.click(previous())
    expect(onCurrent).toHaveBeenCalledWith(0)
  })
})

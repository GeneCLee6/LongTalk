// N3 (e9-t04; f-remote-control-security.md §5.2 step 3, T-10): the agent's consent dialog. Who asks
// (with 「名字是對方自己取的」 and no 「已登入」), the room, what allowing means, the three answers
// with 拒絕 focused once they work, nothing before CONSENT_DIALOG_ARM_MS, 「不再接受請求 N 分鐘」
// with a deny only, and the hourly question. Rust checks the arming and the deadline again
// (control.rs, cargo test); this is what the person sees and what it asks Rust for.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSENT_DIALOG_ARM_MS } from '../../shared/control.ts'
import { dictionaries } from '../../agent/ui/src/i18n.ts'
import type { ControlView } from '../../agent/ui/src/native.ts'

const calls: { cmd: string; args: unknown[] }[] = []
let current: ControlView = { phase: 'idle' }
let push: ((view: ControlView) => void) | null = null

vi.mock('../../agent/ui/src/native.ts', () => ({
  native: {
    controlState: async () => current,
    onControl: async (handler: (view: ControlView) => void) => {
      push = handler
      return () => {}
    },
    controlAnswer: async (...args: unknown[]) => void calls.push({ cmd: 'answer', args }),
    controlKeepGoing: async () => void calls.push({ cmd: 'keepGoing', args: [] }),
    controlStop: async () => void calls.push({ cmd: 'stop', args: [] }),
  },
}))

const { ConsentWindow, StopWindow } = await import('../../agent/ui/src/control.tsx')
const text = dictionaries['zh-TW']

const ASKING: ControlView = {
  phase: 'asking',
  request: 'R'.repeat(22),
  fromName: 'Bob',
  roomName: '週五讀書會',
  createdBy: 'Alice',
  leftMs: 60_000,
  armMs: CONSENT_DIALOG_ARM_MS,
}

describe('the consent dialog (T-10)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    calls.length = 0
    current = ASKING
  })
  afterEach(() => {
    vi.useRealTimers()
    push = null
  })

  async function open() {
    render(<ConsentWindow />)
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('says who asks, that the name is theirs, the room and what allowing means', async () => {
    await open()
    expect(screen.getByRole('heading', { name: text.control.asks('Bob') })).toBeTruthy()
    expect(screen.getByText(text.control.nameNote)).toBeTruthy()
    expect(screen.getByText(text.control.inRoom('週五讀書會'))).toBeTruthy()
    expect(screen.getByText(text.control.consequence)).toBeTruthy()
    expect(document.body.textContent).not.toContain('已登入')
    expect(screen.getByRole('timer').textContent).toBe(text.control.closesIn('1:00'))
    // The three answers and no other ("always" does not exist)
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons).toEqual([text.control.allow10, text.control.allowUntilStop, text.control.deny])
  })

  it('does nothing for the first second, then 拒絕 has the focus', async () => {
    await open()
    const allow = screen.getByRole('button', { name: text.control.allow10 })
    expect((allow as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(allow)
    expect(calls).toEqual([])
    await act(async () => {
      vi.advanceTimersByTime(CONSENT_DIALOG_ARM_MS + 500)
    })
    expect((allow as HTMLButtonElement).disabled).toBe(false)
    expect(document.activeElement?.textContent).toBe(text.control.deny)
    fireEvent.click(allow)
    expect(calls).toEqual([{ cmd: 'answer', args: ['R'.repeat(22), 'allow10', null] }])
  })

  it('sends 「不再接受請求」 only with 拒絕', async () => {
    await open()
    await act(async () => {
      vi.advanceTimersByTime(CONSENT_DIALOG_ARM_MS + 500)
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByRole('combobox', { name: text.control.muteFor }), {
      target: { value: String(30 * 60_000) },
    })
    fireEvent.click(screen.getByRole('button', { name: text.control.allowUntilStop }))
    fireEvent.click(screen.getByRole('button', { name: text.control.deny }))
    expect(calls).toEqual([
      { cmd: 'answer', args: ['R'.repeat(22), 'allowUntilStop', null] },
      { cmd: 'answer', args: ['R'.repeat(22), 'deny', 30 * 60_000] },
    ])
  })

  it('closes when Rust says the request ended', async () => {
    await open()
    act(() => push?.({ phase: 'idle' }))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('asks again every hour during an until-stopped grant', async () => {
    current = {
      phase: 'granted',
      controllerName: 'Bob',
      untilStopped: true,
      leftMs: null,
      reconfirm: [60_000, CONSENT_DIALOG_ARM_MS],
      hint: null,
    }
    await open()
    expect(screen.getByRole('heading', { name: text.control.reconfirm('Bob') })).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(CONSENT_DIALOG_ARM_MS + 500)
    })
    fireEvent.click(screen.getByRole('button', { name: text.control.keepGoing }))
    fireEvent.click(screen.getByRole('button', { name: text.control.stop }))
    expect(calls.map((c) => c.cmd)).toEqual(['keepGoing', 'stop'])
  })
})

describe('the floating 中斷 button', () => {
  it('says who controls, how long is left, and stops', async () => {
    calls.length = 0
    current = {
      phase: 'granted',
      controllerName: 'Bob',
      untilStopped: false,
      leftMs: 9 * 60_000 + 41_000,
      reconfirm: null,
      hint: null,
    }
    render(<StopWindow />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(`${text.control.controlling('Bob')} · 9:41`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: text.control.stop }))
    expect(calls).toEqual([{ cmd: 'stop', args: [] }])
  })

  // N4 (f-remote-control-security.md 5.6): a combination that opens something powerful is named
  it('names a combination the controller just pressed', async () => {
    current = {
      phase: 'granted',
      controllerName: 'Bob',
      untilStopped: true,
      leftMs: null,
      reconfirm: null,
      hint: 'Win+R',
    }
    render(<StopWindow />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('status').textContent).toBe(text.control.pressed('Bob', 'Win+R'))
    expect(text.control.pressed('Bob', 'Win+R')).toBe('Bob 按了 Win+R')
  })
})

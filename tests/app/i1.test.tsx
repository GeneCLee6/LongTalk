import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TURNSTILE_HEADER } from '../../shared/abuse.ts'
import { createRoom, CreateRoomError, getRoom, BlockedError } from '../../src/api/rooms.ts'
import { HomePage } from '../../src/pages/HomePage.tsx'
import { strings } from '../../src/strings.ts'

// I1 (e11-t05): the home page's side of the abuse protection. Turnstile runs only when POST
// /api/rooms asks for it; each refusal has its own notice. The secret never reaches the browser.

vi.mock('../../src/turnstile.ts', () => ({
  turnstileToken: vi.fn(async () => 'token-from-widget'),
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

function home() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/r/:roomId" element={<p>room page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('createRoom', () => {
  it('turns each refusal into its problem', async () => {
    const answers = [
      Response.json({ error: 'turnstile_required', siteKey: 'site' }, { status: 403 }),
      Response.json({ error: 'turnstile_failed' }, { status: 403 }),
      Response.json({ error: 'rate_limited', retryAfter: 120 }, { status: 429 }),
      Response.json({ error: 'blocked' }, { status: 403 }),
      new Response('oops', { status: 500 }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answers.shift()!),
    )
    const problems = []
    for (let i = 0; i < 5; i++) {
      problems.push(
        await createRoom().catch((error: unknown) => (error as CreateRoomError).problem),
      )
    }
    expect(problems).toEqual([
      { reason: 'turnstile', siteKey: 'site' },
      { reason: 'turnstileFailed' },
      { reason: 'rateLimited', retryAfter: 120 },
      { reason: 'blocked' },
      { reason: 'failed' },
    ])
  })

  it('sends the Turnstile token in its header', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ id: 'abcdefghij' }, { status: 201 }),
    )
    vi.stubGlobal('fetch', fetcher)
    await createRoom('tok')
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ [TURNSTILE_HEADER]: 'tok' })
  })

  it('getRoom says when this network is blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'blocked' }, { status: 403 })),
    )
    await expect(getRoom('abcdefghij')).rejects.toBeInstanceOf(BlockedError)
  })
})

describe('HomePage room creation', () => {
  it('runs Turnstile when the server asks, then creates the room with the token', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      return headers[TURNSTILE_HEADER] === 'token-from-widget'
        ? Response.json({ id: 'abcdefghij' }, { status: 201 })
        : Response.json({ error: 'turnstile_required', siteKey: 'site' }, { status: 403 })
    })
    vi.stubGlobal('fetch', fetcher)
    home()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: strings.home.createRoom }))
    })
    expect(await screen.findByText('room page')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
    const { turnstileToken } = await import('../../src/turnstile.ts')
    expect(vi.mocked(turnstileToken).mock.calls[0][1]).toBe('site')
  })

  it.each([
    [{ error: 'rate_limited', retryAfter: 125 }, 429, strings.home.createRoomRateLimited(3)],
    [{ error: 'blocked' }, 403, strings.home.createRoomBlocked],
    [{ error: 'unavailable' }, 503, strings.home.createRoomFailed],
  ])('says why it could not start a room (%j)', async (body, status, text) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body, { status })),
    )
    home()
    fireEvent.click(screen.getByRole('button', { name: strings.home.createRoom }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text))
    expect(screen.getByRole('button', { name: strings.home.createRoom })).toBeEnabled()
  })

  it('says the check failed when the widget gives no token', async () => {
    const { turnstileToken } = await import('../../src/turnstile.ts')
    vi.mocked(turnstileToken).mockRejectedValueOnce(new Error('turnstile error 110200'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'turnstile_required', siteKey: 'site' }, { status: 403 }),
      ),
    )
    home()
    fireEvent.click(screen.getByRole('button', { name: strings.home.createRoom }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(strings.home.createRoomVerifyFailed),
    )
  })
})

describe('AdminBlocks', () => {
  it('blocks a typed address, lists blocks and offenders, and lifts a block', async () => {
    const { AdminBlocks } = await import('../../src/pages/AdminBlocks.tsx')
    const onBlock = vi.fn(async () => true)
    const onUnblock = vi.fn(async () => true)
    const key = 'a'.repeat(24)
    const offender = 'b'.repeat(24)
    render(
      <AdminBlocks
        abuse={{
          blocks: [{ key, at: 1, until: Date.UTC(2026, 10, 4), note: 'spam' }],
          offenders: [{ key: offender, last: 2, counts: { flood: 3 } }],
          turnstile: true,
          pepper: false,
        }}
        onBlock={onBlock}
        onUnblock={onUnblock}
      />,
    )
    const text = strings.admin.abuse
    expect(screen.getByText(new RegExp(text.turnstile(true)))).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(text.ipLabel), { target: { value: '203.0.113.9' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: text.block }))
    })
    expect(onBlock).toHaveBeenCalledWith({ ip: '203.0.113.9', hours: 24, note: undefined })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: text.unblockLabel(key) }))
    })
    expect(onUnblock).toHaveBeenCalledWith(key)
    expect(screen.getByText(new RegExp(`${text.kinds.flood} 3`))).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: text.blockKeyLabel(offender) }))
    })
    expect(onBlock).toHaveBeenLastCalledWith({ key: offender, hours: 24 })
  })
})

import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_SUMMARY_PATH,
  emptyCounts,
  type AdminSummary,
  type ClientEvent,
} from '../../shared/telemetry.ts'
import AdminPage from '../../src/pages/AdminPage.tsx'
import {
  MEDIA_REPORT_AFTER_MS,
  useRoomTelemetry,
  type RoomTelemetryInput,
} from '../../src/room/useRoomTelemetry.ts'
import { strings } from '../../src/strings.ts'
import {
  FLUSH_DELAY_MS,
  MAX_ERRORS_PER_PAGE,
  Telemetry,
  installTelemetry,
} from '../../src/telemetry.ts'

function setup(random = () => 0) {
  const sent: { events: ClientEvent[]; leaving: boolean }[] = []
  const telemetry = new Telemetry({
    send: (body, leaving) =>
      sent.push({ ...(JSON.parse(body) as { events: ClientEvent[] }), leaving }),
    random,
  })
  return { telemetry, sent }
}

describe('Telemetry (e11-t03)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('batches events and sends them after a short wait', () => {
    const { telemetry, sent } = setup()
    telemetry.track({ type: 'join', ok: true })
    telemetry.track({ type: 'rebuild' })
    expect(sent).toEqual([])
    vi.advanceTimersByTime(FLUSH_DELAY_MS)
    expect(sent).toEqual([
      { events: [{ type: 'join', ok: true }, { type: 'rebuild' }], leaving: false },
    ])
  })

  it('sends at once when the page goes away, with sendBeacon', () => {
    const { telemetry, sent } = setup()
    const stop = installTelemetry(telemetry)
    telemetry.track({ type: 'rebuild' })
    window.dispatchEvent(new Event('pagehide'))
    expect(sent).toEqual([{ events: [{ type: 'rebuild' }], leaving: true }])
    stop()
  })

  it('reports uncaught errors scrubbed, once each, at most a few per page', () => {
    const { telemetry, sent } = setup()
    const stop = installTelemetry(telemetry)
    const boom = new TypeError('cannot read gene@example.com at https://x.example/r/k7pq2x9m4a')
    window.dispatchEvent(new ErrorEvent('error', { error: boom, message: boom.message }))
    window.dispatchEvent(new ErrorEvent('error', { error: boom, message: boom.message }))
    for (let i = 0; i < MAX_ERRORS_PER_PAGE + 3; i++)
      telemetry.reportError('rejection', new Error(`e${i}`))
    telemetry.flush()
    const errors = sent.flatMap((batch) => batch.events).filter((e) => e.type === 'error')
    expect(errors).toHaveLength(MAX_ERRORS_PER_PAGE)
    expect(errors[0]).toMatchObject({
      kind: 'error',
      name: 'TypeError',
      message: 'cannot read <email> at <url>',
    })
    expect(JSON.stringify(sent)).not.toContain('gene@')
    stop()
  })

  it('samples errors', () => {
    const { telemetry, sent } = setup(() => 0.99)
    telemetry.reportError('error', new Error('x'))
    telemetry.flush()
    // ERROR_SAMPLE_RATE is 1 for now: everything under it is kept
    expect(sent.flatMap((b) => b.events)).toHaveLength(1)
    const sampled = new Telemetry({
      send: () => sent.push({ events: [], leaving: false }),
      random: () => 1,
    })
    sampled.reportError('error', new Error('y'))
    sampled.flush()
    expect(sent).toHaveLength(1)
  })

  it('does nothing when disabled', () => {
    const send = vi.fn()
    const off = new Telemetry({ send, enabled: false })
    off.track({ type: 'rebuild' })
    off.flush()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('useRoomTelemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const base: RoomTelemetryInput = {
    status: 'connecting',
    mediaStatus: 'idle',
    usingRelay: false,
    rebuilds: 0,
  }

  it('reports the join, reconnects, rebuilds and the TURN ratio once per session', () => {
    const track = vi.fn()
    const { rerender } = renderHook((input: RoomTelemetryInput) => useRoomTelemetry(input, track), {
      initialProps: base,
    })
    rerender({ ...base, status: 'open', mediaStatus: 'connected' })
    expect(track).toHaveBeenLastCalledWith({ type: 'join', ok: true })
    rerender({ ...base, status: 'reconnecting', mediaStatus: 'connected' })
    expect(track).toHaveBeenLastCalledWith({ type: 'reconnect', layer: 'socket' })
    rerender({ ...base, status: 'open', mediaStatus: 'connected', usingRelay: true })
    vi.advanceTimersByTime(MEDIA_REPORT_AFTER_MS)
    expect(track).toHaveBeenLastCalledWith({ type: 'media', relay: true })
    rerender({ ...base, status: 'open', mediaStatus: 'reconnecting', usingRelay: true })
    expect(track).toHaveBeenLastCalledWith({ type: 'reconnect', layer: 'media' })
    rerender({ ...base, status: 'open', mediaStatus: 'connected', rebuilds: 1 })
    expect(track).toHaveBeenLastCalledWith({ type: 'rebuild' })
    vi.advanceTimersByTime(MEDIA_REPORT_AFTER_MS)
    expect(track).toHaveBeenLastCalledWith({ type: 'media', relay: false })
    // Never a second join
    expect(track.mock.calls.filter(([e]) => e.type === 'join')).toHaveLength(1)
  })

  it('reports a failed join with its reason, once', () => {
    const track = vi.fn()
    const { rerender } = renderHook((input: RoomTelemetryInput) => useRoomTelemetry(input, track), {
      initialProps: base,
    })
    rerender({ ...base, status: 'full' })
    rerender({ ...base, status: 'lost' })
    expect(track.mock.calls).toEqual([[{ type: 'join', ok: false, reason: 'full' }]])
  })
})

describe('AdminPage', () => {
  const summary: AdminSummary = {
    telemetry: {
      now: Date.UTC(2026, 10, 2),
      last24h: {
        ...emptyCounts(),
        joinOk: 9,
        joinFail: { lost: 1 },
        media: 4,
        relayed: 1,
        errors: 2,
        ratings: { 5: 3, 4: 1, 1: 1 },
      },
      last7d: { ...emptyCounts(), joinOk: 20 },
      days: [{ day: '2026-11-02', ...emptyCounts(), joinOk: 9 }],
      recentErrors: [
        {
          at: 1,
          kind: 'error',
          name: 'TypeError',
          message: 'x is undefined',
          source: 'a.js:1:2',
          count: 3,
        },
      ],
      alerts: ['errors'],
    },
    usage: { month: '2026-11', bytes: 12_300_000_000, state: 'normal' },
    analyticsEngine: true,
  }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is locked; a wrong password says so; the password goes in a header, not the URL', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    render(<AdminPage />)
    expect(screen.getByRole('heading', { name: strings.admin.lockedTitle })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(strings.admin.tokenLabel), {
      target: { value: 'secret-ish' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.admin.unlock }))
    expect(await screen.findByRole('alert')).toHaveTextContent(strings.admin.wrongToken)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(ADMIN_SUMMARY_PATH)
    expect(url).not.toContain('secret')
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-ish' })
  })

  it('folds a password typed in full-width (IME) back to ASCII', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    render(<AdminPage />)
    fireEvent.change(screen.getByLabelText(strings.admin.tokenLabel), {
      target: { value: 'Ａｂ１＋／＝' },
    })
    fireEvent.click(screen.getByRole('button', { name: strings.admin.unlock }))
    await screen.findByRole('alert')
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ Authorization: 'Bearer Ab1+/=' })
  })

  it('says when ADMIN_TOKEN is not set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    )
    render(<AdminPage />)
    fireEvent.change(screen.getByLabelText(strings.admin.tokenLabel), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: strings.admin.unlock }))
    expect(await screen.findByRole('alert')).toHaveTextContent(strings.admin.notConfigured)
  })

  it('shows the counters, the alert, the errors and the usage once unlocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(summary)),
    )
    render(<AdminPage />)
    fireEvent.change(screen.getByLabelText(strings.admin.tokenLabel), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: strings.admin.unlock }))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: strings.admin.title })).toBeInTheDocument(),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(strings.admin.alerts.errors)
    const totals = within(screen.getByRole('region', { name: strings.admin.totalsTitle }))
    expect(totals.getByRole('row', { name: /進房成功率/ })).toHaveTextContent('90%（9／10）')
    expect(totals.getByRole('row', { name: /進房失敗/ })).toHaveTextContent('連不上 1')
    expect(totals.getByRole('row', { name: /經由 TURN 轉送/ })).toHaveTextContent('25%（1／4）')
    // The after-leave ratings (e4-t18): average and distribution, highest score first
    expect(totals.getByRole('row', { name: /離開評分（平均）/ })).toHaveTextContent('4.0（5 則）')
    expect(totals.getByRole('row', { name: /評分分布/ })).toHaveTextContent(
      '5 分 3、4 分 1、1 分 1',
    )
    expect(screen.getByText('TypeError: x is undefined')).toBeInTheDocument()
    expect(screen.getByText(/2026-11：約 12.3 GB（正常）/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: strings.admin.lock }))
    expect(screen.getByRole('heading', { name: strings.admin.lockedTitle })).toBeInTheDocument()
  })
})

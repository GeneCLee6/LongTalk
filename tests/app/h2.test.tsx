import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StatsPanel from '../../src/components/StatsPanel.tsx'
import { Tile } from '../../src/components/Tile.tsx'
import { DOWNLINK_BUDGET_BPS } from '../../src/media/layers.ts'
import type { StatsSample } from '../../src/media/stats.ts'
import { StatsStore, type StatsSnapshot } from '../../src/room/statsStore.ts'
import { setLocale } from '../../src/strings.ts'

// H2 (e2-t13, e2-t14): the nameplate's signal bars, and 更多 › 連線統計

describe('signal bars on the nameplate (e2-t13)', () => {
  it('shows three bars named by the level, and says it with the tile’s state', () => {
    render(<Tile name="Wei" video={null} signal="poor" />)
    const tile = screen.getByRole('figure', { name: 'Wei' })
    const bars = within(tile).getByRole('img', { name: '訊號差' })
    expect(bars).toHaveAttribute('data-signal', 'poor')
    expect(bars).toHaveAttribute('title', '訊號差')
    expect(tile).toHaveAccessibleDescription('麥克風開著，鏡頭沒開，訊號差')
  })

  it('shows no bars while the level is unknown or the member reconnects', () => {
    const { rerender } = render(<Tile name="Wei" video={null} />)
    expect(screen.queryByRole('img', { name: /訊號/ })).toBeNull()
    rerender(<Tile name="Wei" video={null} signal="good" reconnecting />)
    expect(screen.queryByRole('img', { name: /訊號/ })).toBeNull()
  })

  it('says a camera paused for the downlink is paused, not off (e2-t15)', () => {
    render(<Tile name="Wei" video={null} videoPaused signal="fair" />)
    expect(screen.getByRole('figure', { name: 'Wei' })).toHaveAccessibleDescription(
      '麥克風開著，視訊已暫停（網路不佳），訊號普通',
    )
  })

  it('has the levels in English', () => {
    setLocale('en', false)
    render(<Tile name="Wei" video={null} signal="good" />)
    expect(screen.getByRole('img', { name: 'good signal' })).toBeInTheDocument()
  })
})

const sample: StatsSample = {
  at: 4000,
  intervalMs: 2000,
  rttMs: 48.4,
  usingRelay: true,
  candidateType: 'relay',
  protocol: 'tcp',
  availableOutgoingBitrate: 2_500_000,
  sendBps: 1_250_000,
  receiveBps: 640_000,
  outbound: [
    {
      trackName: 'cam-1',
      kind: 'cam',
      codec: 'VP8',
      bps: 1_100_000,
      lossRate: 0.004,
      qualityLimitationReason: 'bandwidth',
      layers: [
        {
          rid: 'f',
          active: false,
          width: null,
          height: null,
          fps: null,
          bps: 0,
          qualityLimitationReason: null,
        },
        {
          rid: 'h',
          active: true,
          width: 640,
          height: 360,
          fps: 30,
          bps: 380_000,
          qualityLimitationReason: 'bandwidth',
        },
      ],
    },
  ],
  inbound: [
    {
      sessionId: 'wei',
      trackName: 'cam-w',
      media: 'video',
      codec: 'VP8',
      bps: 390_000,
      lossRate: 0.02,
      packets: 196,
      lost: 4,
      jitterMs: 9.6,
      width: 640,
      height: 360,
      fps: 29.7,
      framesDropped: 0,
      freezes: 1,
      freezeMs: 320,
      jitterBufferMs: 40,
      concealedRatio: null,
    },
    {
      sessionId: 'gone',
      trackName: 'mic-g',
      media: 'audio',
      codec: 'opus',
      bps: 32_000,
      lossRate: 0,
      packets: 100,
      lost: 0,
      jitterMs: 3,
      width: null,
      height: null,
      fps: null,
      framesDropped: 0,
      freezes: 0,
      freezeMs: 0,
      jitterBufferMs: 60,
      concealedRatio: 0,
    },
  ],
}

const snapshot: StatsSnapshot = {
  sample,
  layers: { 'wei/cam-w': 'medium' },
  signal: 'fair',
  downlink: { stage: 'reduced', budgetBps: 1_200_000 },
  uplink: { cam: 'medium', screen: 'high' },
  paused: [],
  audioOnly: false,
  hd: true,
  hdLimited: false,
  powerSaving: false,
}

const describeTrack = (key: string) =>
  key === 'wei/cam-w' ? { name: 'Wei', kind: 'cam' as const } : null

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the stats panel (e2-t14)', () => {
  it('says it is collecting until the first sample, then follows the store', () => {
    const store = new StatsStore()
    render(<StatsPanel store={store} describe={describeTrack} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在收集連線資料')
    act(() => store.set(snapshot))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('heading', { name: /你的連線/ })).toBeInTheDocument()
  })

  it('shows our connection, the adaptation, what we send and every subscription', () => {
    const store = new StatsStore()
    store.set(snapshot)
    render(<StatsPanel store={store} describe={describeTrack} />)
    const yours = screen.getByRole('region', { name: /你的連線/ })
    expect(within(yours).getByRole('img', { name: '訊號普通' })).toBeInTheDocument()
    expect(yours).toHaveTextContent('往返延遲48 ms')
    expect(yours).toHaveTextContent('接收640 kbps')
    expect(yours).toHaveTextContent('傳送1.3 Mbps')
    expect(yours).toHaveTextContent('經由轉送伺服器（TURN）')
    expect(yours).toHaveTextContent('relay · TCP')
    const adaptation = screen.getByRole('region', { name: '自動調整' })
    expect(adaptation).toHaveTextContent('已降低畫質')
    expect(adaptation).toHaveTextContent('1.2 Mbps')
    expect(adaptation).toHaveTextContent('已關閉你送出的最高畫質')
    const cam = screen.getByRole('article', { name: '鏡頭' })
    expect(cam).toHaveTextContent('f · 已關閉')
    expect(cam).toHaveTextContent('h · 640×360 · 30 fps · 380 kbps')
    expect(cam).toHaveTextContent('頻寬不足')
    const wei = screen.getByRole('article', { name: 'Wei・鏡頭' })
    expect(wei).toHaveTextContent('要求的層中')
    expect(wei).toHaveTextContent('丟包2.0%')
    expect(wei).toHaveTextContent('卡頓1 · 320 ms')
    // A track whose member left is still listed
    expect(screen.getByRole('article', { name: '已離開的成員・麥克風' })).toBeInTheDocument()
  })

  it('downloads the snapshot as JSON with names and nothing secret', async () => {
    const blobs: Blob[] = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        blobs.push(blob)
        return 'blob:stats'
      },
      revokeObjectURL: () => {},
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const store = new StatsStore()
    store.set(snapshot)
    const onExported = vi.fn()
    render(<StatsPanel store={store} describe={describeTrack} onExported={onExported} />)
    fireEvent.click(screen.getByRole('button', { name: '匯出 JSON' }))
    expect(click).toHaveBeenCalled()
    expect(onExported).toHaveBeenCalled()
    const json = JSON.parse(await blobs[0].text())
    expect(json).toMatchObject({
      app: 'LongTalk',
      signal: 'fair',
      members: { 'wei/cam-w': { name: 'Wei', kind: 'cam' } },
    })
    expect(JSON.stringify(json)).not.toMatch(/token|password|sdp/i)
    click.mockRestore()
  })

  it('is in English too', () => {
    setLocale('en', false)
    const store = new StatsStore()
    store.set({ ...snapshot, downlink: { stage: 'normal', budgetBps: DOWNLINK_BUDGET_BPS } })
    render(<StatsPanel store={store} describe={describeTrack} />)
    expect(screen.getByRole('region', { name: /Your connection/ })).toHaveTextContent(
      'Through a relay server (TURN)',
    )
    expect(screen.getByRole('article', { name: 'Wei · camera' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument()
  })
})

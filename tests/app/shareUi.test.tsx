import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../../src/components/ConfirmDialog.tsx'
import { LoadFailedBoundary, LoadFailedScreen } from '../../src/components/LoadFailed.tsx'
import { PhoneLayoutContext } from '../../src/components/layoutContext.ts'
import { ShareTile } from '../../src/components/ShareTile.tsx'
import { SharingBar } from '../../src/components/SharingBar.tsx'
import { Stage } from '../../src/components/Stage.tsx'
import { strings } from '../../src/strings.ts'

/** A ResizeObserver the test drives (as in Stage.test.tsx) */
class FakeResizeObserver {
  static last: FakeResizeObserver | null = null
  readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.last = this
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  resize(width: number, height: number) {
    act(() =>
      this.callback(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      ),
    )
  }
}

const tiles = (count: number) =>
  Array.from({ length: count }, (_, i) => <figure key={`m${i}`} aria-label={`m${i}`} />)

beforeEach(() => vi.stubGlobal('ResizeObserver', FakeResizeObserver))
afterEach(() => vi.unstubAllGlobals())

describe('the share layout on the stage (e3-t05, e4-t08)', () => {
  it('puts the share in the main area and everyone in a strip on the right of a wide stage', () => {
    render(<Stage share={<ShareTile name="子安" video={null} />}>{tiles(4)}</Stage>)
    const stage = screen.getByRole('region', { name: strings.room.grid })
    expect(stage).toHaveAttribute('data-mode', 'share')
    FakeResizeObserver.last!.resize(1280, 640)
    const main = stage.querySelector('[data-share]') as HTMLElement
    expect(within(main).getByRole('figure', { name: '子安 分享的畫面' })).toBeInTheDocument()
    expect(main.style.height).toBe('640px')
    expect(parseInt(main.style.width)).toBeGreaterThan(0.74 * 1280)
    const strip = within(stage).getByRole('group', { name: strings.stage.strip })
    expect(within(strip).getAllByRole('figure')).toHaveLength(4)
  })

  it('puts the share on top and the people in a row under it on a phone held upright', () => {
    render(
      <PhoneLayoutContext.Provider value="portrait">
        <Stage mode="paged" share={<ShareTile name="子安" video={null} />}>
          {tiles(6)}
        </Stage>
      </PhoneLayoutContext.Provider>,
    )
    FakeResizeObserver.last!.resize(374, 600)
    const stage = screen.getByRole('region', { name: strings.room.grid })
    expect(stage).toHaveAttribute('data-mode', 'share')
    const main = stage.querySelector('[data-share]') as HTMLElement
    expect(main.style.width).toBe('374px')
    // Everyone in one row (the paged gallery's dots are not there)
    expect(within(stage).getAllByRole('figure')).toHaveLength(7)
    expect(screen.queryByRole('group', { name: strings.stage.pages })).toBeNull()
  })

  it('makes the share the big tile on a phone held sideways', () => {
    render(
      <Stage mode="speaker" speaker={2} share={<ShareTile name="子安" video={null} />}>
        {tiles(3)}
      </Stage>,
    )
    FakeResizeObserver.last!.resize(812, 290)
    const stage = screen.getByRole('region', { name: strings.room.grid })
    expect(stage).toHaveAttribute('data-mode', 'share')
    // The speaker is not big while someone shares: everyone is in the strip
    expect(stage.querySelector('[data-speaker]')).toBeNull()
    expect((stage.querySelector('[data-share]') as HTMLElement).style.height).toBe('290px')
  })
})

describe('share UI (e3-t03)', () => {
  it('tags the share with the sharer and says it is on its way until it arrives', () => {
    render(<ShareTile name="子安" video={null} />)
    const tile = screen.getByRole('figure', { name: '子安 分享的畫面' })
    expect(tile).toHaveTextContent('子安 的畫面')
    expect(within(tile).getByRole('status')).toHaveTextContent('子安 開始分享畫面')
  })

  it('shows the sharer the bar with a stop button', () => {
    const onStop = vi.fn()
    render(<SharingBar onStop={onStop} />)
    const bar = screen.getByRole('region', { name: '你正在分享畫面' })
    fireEvent.click(within(bar).getByRole('button', { name: '停止分享' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('asks whether to take over, yes having focus; Escape is no', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmDialog
        title={strings.screenShare.takeOverTitle}
        body={strings.screenShare.takeOverBody('子安')}
        confirmLabel={strings.screenShare.takeOver}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    const dialog = screen.getByRole('alertdialog', { name: '接手分享？' })
    expect(dialog).toHaveAccessibleDescription(
      '子安 正在分享畫面。接手後，子安 的分享會停止，改成分享你的畫面。',
    )
    const yes = within(dialog).getByRole('button', { name: '接手分享' })
    expect(yes).toHaveFocus()
    fireEvent.click(yes)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('load failure (e4-t20)', () => {
  it('shows 載入失敗，請重新整理 with a reload button instead of a blank page', () => {
    const onReload = vi.fn()
    render(<LoadFailedScreen onReload={onReload} />)
    expect(screen.getByRole('alert')).toHaveTextContent(strings.loadFailed.title)
    fireEvent.click(screen.getByRole('button', { name: '重新整理' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('catches a chunk that failed to load', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Broken(): never {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/RoomPage-x.js')
    }
    render(
      <LoadFailedBoundary>
        <Broken />
      </LoadFailedBoundary>,
    )
    expect(screen.getByRole('heading', { name: '載入失敗，請重新整理' })).toBeInTheDocument()
    error.mockRestore()
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../../src/components/Button.tsx'
import { IconButton } from '../../src/components/IconButton.tsx'
import { TileVisibleContext } from '../../src/components/layoutContext.ts'
import { MemberAudio } from '../../src/components/MemberAudio.tsx'
import { Menu } from '../../src/components/Menu.tsx'
import { Tile } from '../../src/components/Tile.tsx'
import { ToastViewport } from '../../src/components/Toast.tsx'
import { useToasts } from '../../src/components/useToasts.ts'
import { strings } from '../../src/strings.ts'
import { avatar, avatarColor } from '../../src/styles/tokens.ts'

describe('Button', () => {
  it('is a non-submitting button that keeps style props off the DOM', () => {
    const onClick = vi.fn()
    render(
      <form onSubmit={() => onClick('submit')}>
        <Button variant="danger" block onClick={() => onClick('click')}>
          {strings.toolbar.leave}
        </Button>
      </form>,
    )
    const button = screen.getByRole('button', { name: '離開' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).not.toHaveAttribute('variant')
    expect(button).not.toHaveAttribute('block')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledExactlyOnceWith('click')
  })
})

describe('IconButton', () => {
  it('is named by its label and exposes on/off as aria-pressed', () => {
    render(<IconButton label={strings.toolbar.micOff} icon={<svg />} pressed={false} />)
    const button = screen.getByRole('button', { name: '解除靜音' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps the label as the accessible name when it shows a caption (hidden on phones)', () => {
    render(<IconButton label={strings.toolbar.chat} icon={<svg />} showLabel />)
    expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-label', '聊天')
    expect(screen.getByText('聊天')).toHaveAttribute('aria-hidden', 'true')
  })

  it('can show a shorter caption and a count than its accessible name', () => {
    render(
      <IconButton
        label={strings.toolbar.participantsCount(3)}
        caption={strings.toolbar.participants}
        badge={3}
        icon={<svg />}
        showLabel
      />,
    )
    const button = screen.getByRole('button', { name: '參與者（3 人）' })
    expect(button).toHaveTextContent('3參與者')
  })
})

describe('Menu', () => {
  const items = (onSelect = vi.fn()) => [
    { id: 'a', label: '第一項', onSelect: () => onSelect('a') },
    { id: 'b', label: '停用', onSelect: () => onSelect('b'), disabled: true },
    { id: 'c', label: '第三項', onSelect: () => onSelect('c') },
  ]

  it('opens from the keyboard, skips disabled items, and selects', () => {
    const onSelect = vi.fn()
    render(<Menu label={strings.common.more} items={items(onSelect)} />)
    const trigger = screen.getByRole('button', { name: '更多' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitem', { name: '第一項' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: '第三項' })).toHaveFocus()
    fireEvent.click(screen.getByRole('menuitem', { name: '第三項' }))
    expect(onSelect).toHaveBeenCalledWith('c')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on Escape and on a click outside', () => {
    render(<Menu label={strings.common.more} items={items()} />)
    const trigger = screen.getByRole('button', { name: '更多' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('Toast', () => {
  function Harness() {
    const { toasts, show, dismiss } = useToasts(4000)
    return (
      <>
        <button type="button" onClick={() => show(strings.toast.joined('小明'))}>
          show
        </button>
        <ToastViewport toasts={toasts} onDismiss={dismiss} />
      </>
    )
  }

  it('announces a toast and removes it after 4 seconds', () => {
    vi.useFakeTimers()
    try {
      render(<Harness />)
      fireEvent.click(screen.getByRole('button', { name: 'show' }))
      expect(screen.getByRole('status')).toHaveTextContent('小明 加入了')
      act(() => vi.advanceTimersByTime(4000))
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it('can be dismissed by hand', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'show' }))
    fireEvent.click(screen.getByRole('button', { name: strings.common.close }))
    expect(screen.queryByText('小明 加入了')).not.toBeInTheDocument()
  })
})

describe('Menu with choices (e2-t06)', () => {
  it('shows radio items under section headings, the current one checked', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        label="選擇麥克風與喇叭"
        items={[
          { id: 'm1', label: 'Built-in', section: '麥克風', checked: true, onSelect },
          { id: 'm2', label: 'Headset', section: '麥克風', checked: false, onSelect },
          { id: 's1', label: 'Speakers', section: '喇叭', checked: true, onSelect },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '選擇麥克風與喇叭' }))
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'true',
    ])
    expect(screen.getByRole('menu')).toHaveTextContent(/麥克風.*Built-in.*Headset.*喇叭.*Speakers/)
    fireEvent.click(items[1])
    expect(onSelect).toHaveBeenCalledOnce()
  })
})

describe('MemberAudio (e4-t07)', () => {
  it("plays a member's microphone through the chosen speaker, and nothing without one", () => {
    const setSinkId = vi.fn(async () => {})
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      value: setSinkId,
      configurable: true,
    })
    const audio = { kind: 'audio' } as MediaStreamTrack
    const { container, rerender } = render(<MemberAudio name="Wei" track={audio} speaker="spk-1" />)
    expect(container.querySelector('audio[data-member="Wei"]')).not.toBeNull()
    expect(setSinkId).toHaveBeenCalledWith('spk-1')
    rerender(<MemberAudio name="Wei" track={null} speaker={null} />)
    expect(container.querySelector('audio')).toBeNull()
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId
  })
})

describe('Tile (e4-t04, e4-t05)', () => {
  const video = { kind: 'video' } as MediaStreamTrack

  it('marks a muted microphone on the nameplate', () => {
    const { rerender } = render(<Tile name="Wei" video={null} micMuted />)
    expect(screen.getByRole('img', { name: strings.room.micMuted })).toBeInTheDocument()
    rerender(<Tile name="Wei" video={null} micMuted={false} />)
    expect(screen.queryByRole('img', { name: strings.room.micMuted })).toBeNull()
  })

  it('shows the initial instead of the video while out of view (e4-t07)', () => {
    const { rerender } = render(
      <TileVisibleContext.Provider value={false}>
        <Tile name="Wei" video={video} />
      </TileVisibleContext.Provider>,
    )
    const tile = screen.getByRole('figure', { name: 'Wei' })
    expect(screen.queryByLabelText(strings.room.tileVideo('Wei'))).toBeNull()
    expect(tile).toHaveTextContent('W')
    // Not "camera off": the camera is on, the tile is just not on screen
    expect(tile).not.toHaveTextContent(strings.room.camOff)
    rerender(
      <TileVisibleContext.Provider value={true}>
        <Tile name="Wei" video={video} />
      </TileVisibleContext.Provider>,
    )
    expect(screen.getByLabelText(strings.room.tileVideo('Wei'))).toBeInTheDocument()
  })

  it('shows the initial on a colour from the name when the camera is off', () => {
    render(<Tile name="小潔" video={null} />)
    const tile = screen.getByRole('figure', { name: '小潔' })
    expect(tile).toHaveTextContent('小')
    expect(tile).toHaveTextContent(strings.room.camOff)
    expect(screen.queryByLabelText(strings.room.tileVideo('小潔'))).toBeNull()
    // The same name, the same colour; the colour is one of the palette's
    expect(avatarColor('小潔')).toBe(avatarColor('小潔'))
    expect(avatar.backgrounds).toContain(avatarColor('小潔'))
    expect(
      new Set(['Gene', 'Wei', '阿明', '子安', '佑佑', '小潔'].map(avatarColor)).size,
    ).toBeGreaterThan(2)
  })

  it('shows the camera, mirrored only on our own tile, and marks our own tile 「你」', () => {
    const { rerender } = render(<Tile name="Gene" you video={video} />)
    const own = screen.getByRole('figure', { name: `Gene（${strings.common.you}）` })
    expect(own).toHaveTextContent(strings.common.you)
    expect(own).not.toHaveTextContent(strings.room.camOff)
    expect(screen.getByLabelText(strings.room.tileVideo('Gene'))).toHaveStyle({
      transform: 'scaleX(-1)',
    })
    rerender(<Tile name="Wei" video={video} />)
    expect(screen.getByLabelText(strings.room.tileVideo('Wei'))).toHaveStyle({ transform: 'none' })
  })

  it('outlines a speaker, with a speaking mark so it is not colour alone', () => {
    const { rerender } = render(<Tile name="Wei" video={null} speaking />)
    const tile = screen.getByRole('figure', { name: 'Wei' })
    expect(tile).toHaveAttribute('data-speaking', 'true')
    expect(screen.getByRole('img', { name: strings.room.speaking })).toBeInTheDocument()
    rerender(<Tile name="Wei" video={null} speaking={false} />)
    expect(tile).not.toHaveAttribute('data-speaking')
    expect(screen.queryByRole('img', { name: strings.room.speaking })).toBeNull()
    // Muted or reconnecting: no outline whatever the level said
    rerender(<Tile name="Wei" video={null} speaking micMuted />)
    expect(tile).not.toHaveAttribute('data-speaking')
    rerender(<Tile name="Wei" video={null} speaking reconnecting />)
    expect(tile).not.toHaveAttribute('data-speaking')
  })

  it('dims a reconnecting member and says so', () => {
    render(<Tile name="佑佑" video={null} reconnecting />)
    const tile = screen.getByRole('figure', { name: '佑佑' })
    expect(tile).toHaveAttribute('data-reconnecting', 'true')
    expect(tile).toHaveTextContent(strings.room.reconnecting)
  })

  it('notes our own relayed media quietly', () => {
    render(<Tile name="Gene" you relayed video={null} />)
    expect(screen.getByRole('figure', { name: `Gene（${strings.common.you}）` })).toHaveTextContent(
      strings.room.relayed,
    )
  })
})

describe('Menu checkbox items (G2)', () => {
  it('shows a switch on its own as a menuitemcheckbox', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        label="更多"
        items={[
          { id: 'h', label: '隱藏自己', kind: 'checkbox', checked: true, onSelect },
          { id: 'g', label: '格狀', checked: false, onSelect },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menuitemcheckbox', { name: '隱藏自己' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: '格狀' })).toBeInTheDocument()
  })
})

describe('Tile pin and spotlight (G2, e4-t10, e4-t11)', () => {
  it('has a pin button, and a spotlight button only when given one; badges when on', () => {
    const onTogglePin = vi.fn()
    const { rerender } = render(<Tile name="Wei" video={null} onTogglePin={onTogglePin} />)
    const pin = screen.getByRole('button', { name: strings.view.pin('Wei') })
    expect(pin).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: strings.view.spotlight('Wei') })).toBeNull()
    fireEvent.click(pin)
    expect(onTogglePin).toHaveBeenCalledOnce()
    const onToggleSpotlight = vi.fn()
    rerender(
      <Tile
        name="Wei"
        video={null}
        pinned
        spotlighted
        onTogglePin={onTogglePin}
        onToggleSpotlight={onToggleSpotlight}
      />,
    )
    expect(screen.getByRole('button', { name: strings.view.unpin('Wei') })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: strings.view.unspotlight('Wei') }))
    expect(onToggleSpotlight).toHaveBeenCalledOnce()
    const figure = screen.getByRole('figure', { name: 'Wei' })
    expect(figure).toHaveTextContent(strings.view.pinnedBadge)
    expect(figure).toHaveTextContent(strings.view.spotlightBadge)
  })

  it('has no buttons when nothing can be done', () => {
    render(<Tile name="Gene" you video={null} />)
    expect(screen.queryAllByRole('button')).toEqual([])
  })
})

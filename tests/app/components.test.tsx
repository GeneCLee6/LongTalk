import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../../src/components/Button.tsx'
import { IconButton } from '../../src/components/IconButton.tsx'
import { Menu } from '../../src/components/Menu.tsx'
import { ToastViewport } from '../../src/components/Toast.tsx'
import { useToasts } from '../../src/components/useToasts.ts'
import { strings } from '../../src/strings.ts'

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

  it('shows the caption as the accessible name when showLabel is set', () => {
    render(<IconButton label={strings.toolbar.chat} icon={<svg />} showLabel />)
    expect(screen.getByRole('button', { name: '聊天' })).not.toHaveAttribute('aria-label')
    expect(screen.getByText('聊天')).toBeInTheDocument()
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

// N5 (e9-t08; AC-9.5, T-24, f-remote-control-security.md §5.12): the agent window's permission
// guide. What the OS must allow, each missing one with 「打開設定」; Linux without X11 says it cannot
// be controlled instead of failing silently; nothing at all where nothing is needed (Windows).
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { dictionaries } from '../../agent/ui/src/i18n.ts'
import type { Permissions } from '../../agent/ui/src/native.ts'

vi.mock('../../agent/ui/src/native.ts', () => ({ native: {} }))

const { PermissionGuide } = await import('../../agent/ui/src/App.tsx')
const text = dictionaries['zh-TW']

const NONE: Permissions = {
  screen: 'notNeeded',
  accessibility: 'notNeeded',
  inputMonitoring: 'notNeeded',
  x11: 'notNeeded',
}

describe('the permission guide (N5)', () => {
  it('shows nothing where nothing is needed or everything is allowed', () => {
    const { container, rerender } = render(<PermissionGuide permissions={NONE} onOpen={() => {}} />)
    expect(container.textContent).toBe('')
    rerender(
      <PermissionGuide
        permissions={{
          ...NONE,
          screen: 'granted',
          accessibility: 'granted',
          inputMonitoring: 'granted',
        }}
        onOpen={() => {}}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('lists the macOS permissions, opening settings for a missing one', () => {
    const onOpen = vi.fn()
    render(
      <PermissionGuide
        permissions={{
          ...NONE,
          screen: 'granted',
          accessibility: 'missing',
          inputMonitoring: 'missing',
        }}
        onOpen={onOpen}
      />,
    )
    expect(screen.getByRole('heading', { name: text.permissions.title })).toBeTruthy()
    expect(screen.getByText(text.permissions.accessibility)).toBeTruthy()
    expect(screen.getByText(text.permissions.granted)).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: text.permissions.open })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[1])
    expect(onOpen.mock.calls).toEqual([['accessibility'], ['inputMonitoring']])
    expect(screen.getByText(text.permissions.afterUpdate)).toBeTruthy()
  })

  it('says a Wayland session cannot be controlled', () => {
    render(<PermissionGuide permissions={{ ...NONE, x11: 'missing' }} onOpen={() => {}} />)
    expect(screen.getByText(text.permissions.noX11)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has the same texts in both languages', () => {
    expect(Object.keys(dictionaries.en.permissions).sort()).toEqual(
      Object.keys(dictionaries['zh-TW'].permissions).sort(),
    )
  })
})

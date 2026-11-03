// G4 (e4-t13, AC-4.9): keyboard shortcuts and push-to-talk. The rules (no modifiers, never
// while typing or composing, never inside menus and dialogs), then the room: M mutes, Space held
// talks, C opens the chat, Esc closes it, ? lists the shortcuts, L asks before leaving, and the
// toolbar's tooltips name the keys.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ClientMessage } from '../../shared/protocol.ts'
import { App } from '../../src/App.tsx'
import { MediaDevicesContext } from '../../src/room/devicesContext.ts'
import {
  PushToTalk,
  SHORTCUTS,
  ariaKeys,
  isTypingTarget,
  shortcutFor,
  startsPushToTalk,
  type KeyInput,
} from '../../src/room/shortcuts.ts'
import { TransportContext } from '../../src/room/transportContext.ts'
import { en } from '../../src/i18n/en.ts'
import { zhTW } from '../../src/i18n/zh-TW.ts'
import { FakeSfu } from '../../src/media/FakeTransport.ts'
import { fakeMediaDevices } from './media/fakeMedia.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

function key(init: Partial<KeyInput> & { key: string }): KeyInput {
  return {
    code: init.key.length === 1 ? `Key${init.key.toUpperCase()}` : init.key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    target: document.body,
    ...init,
  }
}

function element(html: string): HTMLElement {
  const holder = document.createElement('div')
  holder.innerHTML = html
  document.body.append(holder)
  return holder.querySelector('[data-target]') ?? (holder.firstElementChild as HTMLElement)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('shortcut rules (e4-t13)', () => {
  it('maps the PRD’s keys, whatever the case', () => {
    expect(shortcutFor(key({ key: 'm' }))).toBe('mic')
    expect(shortcutFor(key({ key: 'M', shiftKey: true }))).toBe('mic')
    expect(shortcutFor(key({ key: 'v' }))).toBe('cam')
    expect(shortcutFor(key({ key: 's' }))).toBe('share')
    expect(shortcutFor(key({ key: 'c' }))).toBe('chat')
    expect(shortcutFor(key({ key: 'p' }))).toBe('participants')
    expect(shortcutFor(key({ key: 'r' }))).toBe('hand')
    expect(shortcutFor(key({ key: 'l' }))).toBe('leave')
    expect(shortcutFor(key({ key: '?', code: 'Slash', shiftKey: true }))).toBe('help')
    expect(shortcutFor(key({ key: 'Escape' }))).toBe('close')
    expect(shortcutFor(key({ key: 'x' }))).toBeNull()
    expect(shortcutFor(key({ key: 'Enter' }))).toBeNull()
  })

  it('goes by the physical key on a layout without Latin letters', () => {
    expect(shortcutFor(key({ key: 'ь', code: 'KeyM' }))).toBe('mic')
    expect(shortcutFor(key({ key: 'ㄩ', code: 'KeyM' }))).toBe('mic')
  })

  it('leaves every Ctrl, Cmd and Alt combination to the browser and the system', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      for (const letter of ['m', 'v', 's', 'c', 'p', 'r', 'l']) {
        expect(shortcutFor(key({ key: letter, [modifier]: true }))).toBeNull()
      }
    }
  })

  it('never fires while typing: inputs, text areas, selects, editable text', () => {
    for (const html of [
      '<input type="text">',
      '<input>',
      '<input type="search">',
      '<input type="password">',
      '<textarea></textarea>',
      '<select><option>a</option></select>',
      '<div contenteditable="true"><span data-target>x</span></div>',
      '<div role="textbox" data-target></div>',
    ]) {
      const target = element(html)
      expect(isTypingTarget(target), html).toBe(true)
      expect(shortcutFor(key({ key: 'm', target })), html).toBeNull()
      expect(startsPushToTalk(key({ key: ' ', code: 'Space', target })), html).toBe(false)
    }
    // A check box or a button is not typing
    expect(shortcutFor(key({ key: 'm', target: element('<input type="checkbox">') }))).toBe('mic')
    expect(shortcutFor(key({ key: 'm', target: element('<button>x</button>') }))).toBe('mic')
  })

  it('never fires while an IME composes (注音: isComposing, key code 229)', () => {
    expect(shortcutFor(key({ key: 'm', isComposing: true }))).toBeNull()
    expect(shortcutFor(key({ key: 'Process', keyCode: 229 }))).toBeNull()
    expect(startsPushToTalk(key({ key: ' ', code: 'Space', isComposing: true }))).toBe(false)
    expect(startsPushToTalk(key({ key: ' ', code: 'Space', keyCode: 229 }))).toBe(false)
  })

  it('waits while a menu, dialog or drawer has the keys, or a modal is open', () => {
    for (const html of [
      '<div role="menu"><button role="menuitem" data-target>x</button></div>',
      '<div role="dialog"><button data-target>x</button></div>',
      '<div role="alertdialog"><button data-target>x</button></div>',
      '<div aria-modal="true"><button data-target>x</button></div>',
    ]) {
      const target = element(html)
      expect(shortcutFor(key({ key: 'm', target })), html).toBeNull()
      expect(shortcutFor(key({ key: 'Escape', target })), html).toBeNull()
    }
    expect(shortcutFor(key({ key: 'm' }), { modal: true })).toBeNull()
    expect(startsPushToTalk(key({ key: ' ', code: 'Space' }), { modal: true })).toBe(false)
  })

  it('ignores a key something on the page already handled, and held-down repeats', () => {
    expect(shortcutFor(key({ key: 'Escape', defaultPrevented: true }))).toBeNull()
    expect(shortcutFor(key({ key: 'm', repeat: true }))).toBeNull()
  })

  it('talks on Space, except on a control reached with the keyboard (Space presses it)', () => {
    expect(startsPushToTalk(key({ key: ' ', code: 'Space' }))).toBe(true)
    expect(startsPushToTalk(key({ key: ' ', code: 'Space', shiftKey: true }))).toBe(false)
    expect(startsPushToTalk(key({ key: ' ', code: 'Space', ctrlKey: true }))).toBe(false)
    expect(startsPushToTalk(key({ key: 'm' }))).toBe(false)
    const button = element('<button>靜音</button>')
    // Clicked with the mouse (no focus ring): Space talks
    vi.spyOn(button, 'matches').mockImplementation(() => false)
    expect(startsPushToTalk(key({ key: ' ', code: 'Space', target: button }))).toBe(true)
    // Reached with Tab (focus ring): Space is the button's
    vi.spyOn(button, 'matches').mockImplementation((selector) => selector === ':focus-visible')
    expect(startsPushToTalk(key({ key: ' ', code: 'Space', target: button }))).toBe(false)
  })

  it('push-to-talk only while muted, and mutes again on release', () => {
    const ptt = new PushToTalk()
    expect(ptt.press(true, false)).toBe(false)
    expect(ptt.press(false, true)).toBe(false)
    expect(ptt.release()).toBe(false)
    expect(ptt.press(false, false)).toBe(true)
    expect(ptt.active).toBe(true)
    expect(ptt.press(true, false)).toBe(true)
    expect(ptt.release()).toBe(true)
    expect(ptt.release()).toBe(false)
  })

  it('lists every shortcut in both languages, with aria-keyshortcuts spellings', () => {
    for (const { action } of SHORTCUTS) {
      expect(zhTW.shortcuts.actions[action]).toBeTruthy()
      expect(en.shortcuts.actions[action]).toBeTruthy()
    }
    expect(ariaKeys('mic')).toBe('M')
    expect(ariaKeys('help')).toBe('Shift+?')
  })
})

// The room, as RoomMediaPage.test.tsx sets it up: a tab that joined before (no pre-join), Wei in
// the room, the media on a FakeSfu, fake devices
const ROOM_ID = 'abcdefghij'
const TOKEN = 'K'.repeat(43)
const SLOW = { timeout: 5000 }
let sfu: FakeSfu
const sockets: RoomSocket[] = []

class RoomSocket {
  readyState = 0
  sent: ClientMessage[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor() {
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(data: string) {
    if (data === 'ping') return
    const message = JSON.parse(data) as ClientMessage
    this.sent.push(message)
    if (message.t !== 'join') return
    const state = {
      room: { id: ROOM_ID, createdAt: 1, passwordSetAt: null, spotlight: null },
      members: {
        w: {
          id: 'w',
          name: 'Wei',
          role: 'host',
          joinedAt: 1,
          reconnecting: false,
          tracks: [],
          hand: null,
        },
        a: {
          id: 'a',
          name: 'Gene',
          role: 'participant',
          joinedAt: 2,
          reconnecting: false,
          tracks: [],
          hand: null,
        },
      },
      waiting: {},
      usage: 'normal',
    }
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({
          t: 'welcome',
          v: PROTOCOL_VERSION,
          you: 'a',
          token: TOKEN,
          rev: 1,
          state,
        }),
      }),
    )
  }
  close() {}
}

async function enterRoom() {
  const fake = fakeMediaDevices()
  localStorage.setItem('longtalk.name', 'Gene')
  sessionStorage.setItem(`longtalk.session.${ROOM_ID}`, TOKEN)
  window.history.pushState({}, '', `/r/${ROOM_ID}`)
  render(
    <TransportContext.Provider value={() => sfu.createTransport()}>
      <MediaDevicesContext.Provider value={fake.devices}>
        <App />
      </MediaDevicesContext.Provider>
    </TransportContext.Provider>,
  )
  const toolbar = await screen.findByRole('toolbar', { name: '會議控制' }, SLOW)
  // The microphone is open and on (the pre-join choice): wait for it
  await within(toolbar).findByRole('button', { name: '靜音' }, SLOW)
  await waitFor(
    () => expect(within(toolbar).getByRole('button', { name: '靜音' })).toBeEnabled(),
    SLOW,
  )
  return toolbar
}

const press = (init: KeyboardEventInit, target: EventTarget = document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
const release = (init: KeyboardEventInit, target: EventTarget = document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init }))
  })

describe('shortcuts in the room (e4-t13)', () => {
  beforeEach(() => {
    sfu = new FakeSfu()
    sockets.length = 0
    vi.stubGlobal('WebSocket', RoomSocket)
    localStorage.clear()
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
  })

  it('M mutes and unmutes; the tooltip and aria-keyshortcuts say so', async () => {
    const toolbar = await enterRoom()
    const mic = within(toolbar).getByRole('button', { name: '靜音' })
    expect(mic).toHaveAttribute('title', '靜音（M）')
    expect(mic).toHaveAttribute('aria-keyshortcuts', 'M')
    expect(within(toolbar).getByRole('button', { name: '聊天' })).toHaveAttribute(
      'aria-keyshortcuts',
      'C',
    )
    await press({ key: 'm', code: 'KeyM' })
    expect(await within(toolbar).findByRole('button', { name: '解除靜音' })).toBeInTheDocument()
    // Ctrl+M is the browser's
    await press({ key: 'm', code: 'KeyM', ctrlKey: true })
    expect(within(toolbar).getByRole('button', { name: '解除靜音' })).toBeInTheDocument()
    await press({ key: 'M', code: 'KeyM' })
    expect(await within(toolbar).findByRole('button', { name: '靜音' })).toBeInTheDocument()
  })

  it('holding Space while muted talks, letting go mutes again', async () => {
    const toolbar = await enterRoom()
    await press({ key: 'm', code: 'KeyM' })
    await within(toolbar).findByRole('button', { name: '解除靜音' })
    await press({ key: ' ', code: 'Space' })
    expect(await within(toolbar).findByRole('button', { name: '靜音' })).toBeInTheDocument()
    expect(screen.getByText('按住說話中…')).toBeInTheDocument()
    // The key repeats while held: still talking
    await press({ key: ' ', code: 'Space', repeat: true })
    expect(within(toolbar).getByRole('button', { name: '靜音' })).toBeInTheDocument()
    await release({ key: ' ', code: 'Space' })
    expect(await within(toolbar).findByRole('button', { name: '解除靜音' })).toBeInTheDocument()
    expect(screen.queryByText('按住說話中…')).toBeNull()
    // The window losing focus mid-hold (the key up never comes) mutes too
    await press({ key: ' ', code: 'Space' })
    await within(toolbar).findByRole('button', { name: '靜音' })
    await act(async () => window.dispatchEvent(new Event('blur')))
    expect(await within(toolbar).findByRole('button', { name: '解除靜音' })).toBeInTheDocument()
  })

  it('C opens the chat; typing M there types; Esc closes it', async () => {
    const toolbar = await enterRoom()
    await press({ key: 'c', code: 'KeyC' })
    const box = await screen.findByRole('textbox', {}, SLOW)
    await press({ key: 'm', code: 'KeyM' }, box)
    expect(within(toolbar).getByRole('button', { name: '靜音' })).toBeInTheDocument()
    // Composing with an IME: not even Space talks
    await press({ key: ' ', code: 'Space', isComposing: true })
    expect(within(toolbar).getByRole('button', { name: '靜音' })).toBeInTheDocument()
    ;(document.activeElement as HTMLElement | null)?.blur()
    await press({ key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  })

  it('? and 更多 list the shortcuts; L asks before leaving', async () => {
    const toolbar = await enterRoom()
    await press({ key: '?', code: 'Slash', shiftKey: true })
    const list = screen.getByRole('dialog', { name: '鍵盤快捷鍵' })
    expect(list).toHaveTextContent('空白鍵')
    expect(list).toHaveTextContent('靜音時按住說話')
    // Inside the dialog the shortcuts wait
    await press({ key: 'm', code: 'KeyM' }, within(list).getByRole('button', { name: '關閉' }))
    expect(within(toolbar).getByRole('button', { name: '靜音' })).toBeInTheDocument()
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '鍵盤快捷鍵' })).toBeNull()
    fireEvent.click(within(toolbar).getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '鍵盤快捷鍵…' }))
    expect(screen.getByRole('dialog', { name: '鍵盤快捷鍵' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '關閉' }))
    await press({ key: 'l', code: 'KeyL' })
    const ask = screen.getByRole('alertdialog', { name: '要離開會議室嗎？' })
    fireEvent.click(within(ask).getByRole('button', { name: '取消' }))
    expect(sockets.at(-1)!.sent.some((m) => m.t === 'leave')).toBe(false)
    await press({ key: 'l', code: 'KeyL' })
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '離開' }))
    expect(await screen.findByRole('heading', { name: '你已經離開會議室' })).toBeInTheDocument()
  })
})

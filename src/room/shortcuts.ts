// The room's keyboard shortcuts and push-to-talk (G4, e4-t13, AC-4.9), as pure functions over a
// key event: useRoomShortcuts.ts listens on the window and calls them; the shortcuts dialog and
// the toolbar's tooltips read SHORTCUTS. tests/app/shortcuts.test.tsx covers them.
//
// Single keys without Ctrl, Cmd or Alt (PRD e4: M, V, S, C, P, R, Space, Esc), so no browser or
// system shortcut is taken: a key with one of those held is always left to the browser. Never
// while typing (inputs, text areas, editable text, menus' type-ahead, dialogs), never during an
// IME's composition (注音 and other input methods: `isComposing`, key code 229), never when
// something on the page already handled the key.

export type ShortcutAction =
  'mic' | 'cam' | 'share' | 'chat' | 'participants' | 'hand' | 'leave' | 'help' | 'close'

export interface Shortcut {
  action: ShortcutAction
  /** The key as shown (tooltips, the list) and as aria-keyshortcuts writes it */
  key: string
}

/** Every shortcut, in the list's order (push-to-talk is apart: it is held, not pressed) */
export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'mic', key: 'M' },
  { action: 'cam', key: 'V' },
  { action: 'share', key: 'S' },
  { action: 'chat', key: 'C' },
  { action: 'participants', key: 'P' },
  { action: 'hand', key: 'R' },
  { action: 'leave', key: 'L' },
  { action: 'help', key: '?' },
  { action: 'close', key: 'Escape' },
]

/** The key for an action (tooltips and aria-keyshortcuts) */
export function shortcutKey(action: ShortcutAction): string {
  return SHORTCUTS.find((shortcut) => shortcut.action === action)?.key ?? ''
}

/** aria-keyshortcuts' spelling: `?` is typed with Shift on most layouts */
export function ariaKeys(action: ShortcutAction): string {
  const key = shortcutKey(action)
  return key === '?' ? 'Shift+?' : key
}

const LETTERS: Partial<Record<string, ShortcutAction>> = {
  m: 'mic',
  v: 'cam',
  s: 'share',
  c: 'chat',
  p: 'participants',
  r: 'hand',
  l: 'leave',
}

/** The part of a KeyboardEvent the rules read */
export interface KeyInput {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  isComposing: boolean
  keyCode: number
  defaultPrevented: boolean
  target: EventTarget | null
}

/** <input> types that take typing (everything but buttons, boxes and pickers) */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

const asElement = (target: EventTarget | null): Element | null =>
  target && typeof (target as Element).closest === 'function' ? (target as Element) : null

/** Focus is where typing goes: a text field, a select, editable text */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = asElement(target)
  if (!element) return false
  const tag = element.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((element as HTMLInputElement).type)
  if ((element as HTMLElement).isContentEditable) return true
  return !!element.closest(
    '[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="combobox"],[role="searchbox"]',
  )
}

/**
 * Focus is inside something with keys of its own: a menu (type-ahead, arrows), a dialog or a
 * drawer (their own Escape and Tab), a list box. The shortcuts wait until it closes.
 */
function insideWidget(target: EventTarget | null): boolean {
  const element = asElement(target)
  return !!element?.closest(
    '[role="menu"],[role="menubar"],[role="listbox"],[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
  )
}

/** A modal is open somewhere on the page (focus may have fallen back to the body) */
export function modalOpen(doc: Pick<Document, 'querySelector'> = document): boolean {
  return !!doc.querySelector('[aria-modal="true"]')
}

const IME = (event: KeyInput) => event.isComposing || event.keyCode === 229

/**
 * The action a key press stands for, or null when the press is not ours: a modifier held, typing,
 * an IME composing, focus in a menu or dialog, a modal open, or already handled. Letters go by
 * the key typed, or by the physical key (`KeyM`) on a layout without Latin letters.
 */
export function shortcutFor(
  event: KeyInput,
  { modal = false }: { modal?: boolean } = {},
): ShortcutAction | null {
  if (event.defaultPrevented || IME(event)) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (modal || isTypingTarget(event.target) || insideWidget(event.target)) return null
  if (event.key === 'Escape') return 'close'
  if (event.repeat) return null
  if (event.key === '?') return 'help'
  const typed = event.key.length === 1 ? event.key.toLowerCase() : ''
  const letter = /^[a-z]$/.test(typed)
    ? typed
    : /^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : ''
  return LETTERS[letter] ?? null
}

const isSpace = (event: Pick<KeyInput, 'key' | 'code'>) =>
  event.code === 'Space' || event.key === ' '

/** Controls a Space press activates (buttons, links, check boxes, tabs, menu items…) */
function spaceActivates(element: Element): boolean {
  return !!element.closest(
    'button,a[href],summary,input,[role="button"],[role="checkbox"],[role="switch"],[role="tab"],[role="radio"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="slider"]',
  )
}

const keyboardFocused = (element: Element): boolean => {
  try {
    return element.matches(':focus-visible')
  } catch {
    return false
  }
}

/**
 * Whether a Space key down starts push-to-talk. Not while typing, composing, with a modifier,
 * in a menu or dialog, with a modal open, or on a control someone reached with the keyboard
 * (Tab, then Space presses it: G5's keyboard use comes first). A control merely clicked before
 * (focus left on the mute button) does not count: there Space talks, and the browser's own
 * press is held back (useRoomShortcuts calls preventDefault on the key down and up).
 */
export function startsPushToTalk(
  event: KeyInput,
  { modal = false }: { modal?: boolean } = {},
): boolean {
  if (!isSpace(event) || event.defaultPrevented || IME(event)) return false
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  if (modal || isTypingTarget(event.target) || insideWidget(event.target)) return false
  const element = asElement(event.target)
  if (element && spaceActivates(element) && keyboardFocused(element)) return false
  return true
}

/** Whether a key up ends push-to-talk */
export const endsPushToTalk = (event: Pick<KeyInput, 'key' | 'code'>) => isSpace(event)

/**
 * Push-to-talk (AC-4.9): Space held while muted turns the microphone on; letting go (or the tab
 * losing focus, when the key up never comes) turns it off again. Space while the microphone is
 * already on does nothing: it is not a "hold to mute".
 */
export class PushToTalk {
  private holding = false

  get active(): boolean {
    return this.holding
  }

  /**
   * Space went down: true when it starts talking (the caller turns the microphone on), or is
   * already holding. Not when the microphone is on already or still opening.
   */
  press(micOn: boolean, micBusy: boolean): boolean {
    if (this.holding) return true
    if (micOn || micBusy) return false
    this.holding = true
    return true
  }

  /** Space came up, or focus left the page: true when talking stops (the caller mutes again) */
  release(): boolean {
    if (!this.holding) return false
    this.holding = false
    return true
  }
}

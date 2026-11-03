// The home page's install offer (e4-t12, AC-4.7). Chromium fires `beforeinstallprompt` when the
// site can be installed: the event is kept and 「安裝」 calls its prompt(). iOS and iPadOS Safari
// have no such dialog, only the share sheet's 「加入主畫面」: a one-time hint says so. Nothing
// shows once installed (opened as the app), after 「不用了」 (remembered), or in other browsers.
// Only the home page shows it, never the room.

export type InstallOffer = 'prompt' | 'ios' | null

/** What decides the offer (a pure function: tests/app/pwa.test.ts) */
export interface InstallInput {
  /** A `beforeinstallprompt` event is kept (Chromium, not installed yet) */
  deferred: boolean
  /** The browser installs from its share sheet (capabilities.ts `homeScreenHint`) */
  homeScreenHint: boolean
  /** Opened as the installed app (display-mode: standalone, or navigator.standalone) */
  standalone: boolean
  /** 「不用了」 earlier, or the browser said it was installed */
  dismissed: boolean
}

export function installOffer({
  deferred,
  homeScreenHint,
  standalone,
  dismissed,
}: InstallInput): InstallOffer {
  if (standalone || dismissed) return null
  if (deferred) return 'prompt'
  if (homeScreenHint) return 'ios'
  return null
}

/** The part of `beforeinstallprompt` used here */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface InstallEnv {
  addEventListener(
    type: 'beforeinstallprompt' | 'appinstalled',
    listener: (event: Event) => void,
  ): void
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  standalone: () => boolean
  homeScreenHint: boolean
}

/** localStorage: `1` once the offer was dismissed or used (the iOS hint: once it was shown) */
export const INSTALL_DISMISSED_KEY = 'longtalk.installDismissed'

export class InstallOffers {
  private deferred: InstallPromptEvent | null = null
  private dismissed: boolean
  private offer: InstallOffer = null
  private readonly listeners = new Set<() => void>()
  private readonly env: InstallEnv

  constructor(env: InstallEnv) {
    this.env = env
    this.dismissed = this.read()
    this.offer = this.compute()
  }

  /** Starts listening; call once, early (the event can come before React renders) */
  listen(): void {
    this.env.addEventListener('beforeinstallprompt', (event) => {
      // Our own button instead of the browser's mini bar
      event.preventDefault()
      this.deferred = event as InstallPromptEvent
      this.update()
    })
    this.env.addEventListener('appinstalled', () => {
      this.deferred = null
      this.remember()
    })
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): InstallOffer => this.offer

  /** 「安裝」: the browser's own dialog; either answer ends the offer (it cannot be asked twice) */
  async install(): Promise<void> {
    const event = this.deferred
    if (!event) return
    this.deferred = null
    await event.prompt()
    await event.userChoice.catch(() => null)
    this.remember()
  }

  /** 「不用了」 / 「知道了」: remembered in this browser */
  dismiss(): void {
    this.remember()
  }

  /**
   * The iOS hint was on screen: it is a one-time hint, so the next visit does not show it again
   * (it stays for this visit until dismissed)
   */
  shown(): void {
    if (this.offer !== 'ios') return
    try {
      this.env.storage?.setItem(INSTALL_DISMISSED_KEY, '1')
    } catch {
      // Storage may be off (private mode): then it shows again next time
    }
  }

  private read(): boolean {
    try {
      return this.env.storage?.getItem(INSTALL_DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  }

  private remember() {
    this.dismissed = true
    try {
      this.env.storage?.setItem(INSTALL_DISMISSED_KEY, '1')
    } catch {
      // Remembered for this page only
    }
    this.update()
  }

  private compute(): InstallOffer {
    return installOffer({
      deferred: this.deferred !== null,
      homeScreenHint: this.env.homeScreenHint,
      standalone: this.env.standalone(),
      dismissed: this.dismissed,
    })
  }

  private update() {
    const next = this.compute()
    if (next === this.offer) return
    this.offer = next
    for (const listener of this.listeners) listener()
  }
}

// 「有新版本，重新整理」 (e4-t12, AC-4.7): notices that a newer LongTalk is deployed and reloads
// only when the person says so, or at the next change of page after they said 稍後. A meeting
// never reloads by itself.
//
// Where a service worker runs (src/pwa/sw.ts), a new version is a new sw.js waiting to take over:
// the page asks it which build it brings and offers the reload only when that differs from what
// the page runs (a docs-only deploy changes no file the browser runs; a page that a navigation
// already loaded from the new deploy is new already). Without a service worker (Firefox's private
// windows, an http page) it compares GET /api/health's version with the page's
// <meta name="app-version">.
import type { SwMessage, SwVersionReply } from './swRouting.ts'

export type UpdateState =
  /** Nothing newer known */
  | 'none'
  /** A newer version is out: the prompt shows */
  | 'available'
  /** 稍後: the prompt is gone; the next change of page applies it */
  | 'dismissed'
  /** Taking the new version: the page is about to reload */
  | 'applying'

export interface WorkerLike {
  state: string
  postMessage(message: SwMessage, transfer?: Transferable[]): void
  addEventListener(type: 'statechange', listener: () => void): void
}

export interface RegistrationLike {
  installing: WorkerLike | null
  waiting: WorkerLike | null
  update(): Promise<unknown>
  addEventListener(type: 'updatefound', listener: () => void): void
}

export interface ContainerLike {
  controller: WorkerLike | null
  addEventListener(type: 'controllerchange', listener: () => void): void
  removeEventListener(type: 'controllerchange', listener: () => void): void
}

export interface UpdateDeps {
  /** The page's own version: <meta name="app-version"> (`local` in development) */
  pageVersion: string
  /** GET /api/health's version, or null when it cannot be read */
  fetchVersion: () => Promise<string | null>
  /** Asks a worker which build it brings (a MessageChannel with a timeout), or null */
  askVersion: (worker: WorkerLike) => Promise<SwVersionReply | null>
  reload: () => void
  /** navigator.serviceWorker, when there is one */
  container: ContainerLike | null
  setTimeout: (callback: () => void, ms: number) => unknown
}

/** How long a reload waits for the new worker to take over before going ahead anyway */
export const TAKEOVER_TIMEOUT_MS = 3_000

const isRealVersion = (version: string | null): version is string =>
  !!version && version !== 'local'

export class UpdateManager {
  private state: UpdateState = 'none'
  private readonly listeners = new Set<() => void>()
  private registration: RegistrationLike | null = null
  private reloading = false
  private readonly deps: UpdateDeps

  constructor(deps: UpdateDeps) {
    this.deps = deps
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): UpdateState => this.state

  private set(state: UpdateState) {
    if (state === this.state) return
    this.state = state
    for (const listener of this.listeners) listener()
  }

  private offer() {
    if (this.state === 'none') this.set('available')
  }

  /** Follows a service worker registration: a waiting worker now, and every one found later */
  watch(registration: RegistrationLike): void {
    this.registration = registration
    if (registration.waiting) void this.consider(registration.waiting)
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing
      if (!worker) return
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') void this.consider(worker)
      })
    })
  }

  /**
   * A new worker is installed and waits. The first install (no controller yet) activates by
   * itself; otherwise the prompt shows unless the page already runs what it brings, or it brings
   * the same files as the one in charge: then it takes over quietly (nothing visible changes).
   */
  async consider(worker: WorkerLike): Promise<void> {
    const controller = this.deps.container?.controller ?? null
    if (!controller) return
    const [incoming, current] = await Promise.all([
      this.deps.askVersion(worker),
      this.deps.askVersion(controller),
    ])
    const pageHasIt = !!incoming && incoming.appVersion === this.deps.pageVersion
    const sameFiles = !!incoming && !!current && incoming.version === current.version
    if (pageHasIt || sameFiles) {
      worker.postMessage({ type: 'skipWaiting' })
      return
    }
    this.offer()
  }

  /**
   * Looks for a new version (on start, when the tab comes back, when the network does, and every
   * so often): asks the browser to check sw.js, or, without a service worker, compares
   * /api/health's version.
   */
  async check(): Promise<void> {
    if (this.registration) {
      await this.registration.update().catch(() => undefined)
      return
    }
    const live = await this.deps.fetchVersion().catch(() => null)
    if (
      isRealVersion(live) &&
      isRealVersion(this.deps.pageVersion) &&
      live !== this.deps.pageVersion
    ) {
      this.offer()
    }
  }

  /** 稍後: hide the prompt; the next change of page takes the new version */
  dismiss(): void {
    if (this.state === 'available') this.set('dismissed')
  }

  /** The app moved to another page (react-router): the moment to take a dismissed update */
  navigated(): void {
    if (this.state === 'available' || this.state === 'dismissed') this.apply()
  }

  /** 重新整理: let the waiting worker take over, then reload this tab (and only this one) */
  apply(): void {
    if (this.state === 'applying') return
    this.set('applying')
    const waiting = this.registration?.waiting ?? null
    const container = this.deps.container
    if (!waiting || !container) {
      this.reload()
      return
    }
    const onChange = () => {
      container.removeEventListener('controllerchange', onChange)
      this.reload()
    }
    container.addEventListener('controllerchange', onChange)
    waiting.postMessage({ type: 'skipWaiting' })
    this.deps.setTimeout(onChange, TAKEOVER_TIMEOUT_MS)
  }

  private reload() {
    if (this.reloading) return
    this.reloading = true
    this.deps.reload()
  }
}

/** Asks a worker for its build over a MessageChannel; null if it does not answer in time */
export function askWorkerVersion(
  worker: WorkerLike,
  timeoutMs = 2_000,
): Promise<SwVersionReply | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(null), timeoutMs)
    channel.port1.onmessage = (event: MessageEvent<SwVersionReply>) => {
      clearTimeout(timer)
      resolve(event.data ?? null)
    }
    try {
      worker.postMessage({ type: 'version' }, [channel.port2])
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

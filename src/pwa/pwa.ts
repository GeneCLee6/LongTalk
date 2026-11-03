// The app's PWA side (e4-t12): registers the service worker (src/pwa/sw.ts, built to /sw.js),
// watches for new versions (update.ts) and keeps the install offer (install.ts). main.tsx calls
// startPwa() once; components read the state through the hooks below.
import { useSyncExternalStore } from 'react'
import { canUseServiceWorker, hasHomeScreenHint } from '../media/capabilities.ts'
import { InstallOffers, type InstallOffer } from './install.ts'
import { UpdateManager, askWorkerVersion, type ContainerLike, type UpdateState } from './update.ts'

/**
 * The worker's script (swRouting.ts `SW_URL`, which scripts/swPlugin.ts writes). Not imported:
 * swRouting.ts must stay the worker's alone, or the build would split it into a shared chunk
 * that sw.js (a classic script) cannot import. tests/app/pwa.test.tsx checks the two match.
 */
export const SW_SCRIPT = '/sw.js'

/** How often an open tab looks for a new version, besides coming back to it and going online */
export const UPDATE_CHECK_MS = 30 * 60_000

const pageVersion = () =>
  document.querySelector<HTMLMetaElement>('meta[name="app-version"]')?.content ?? 'local'

async function healthVersion(): Promise<string | null> {
  const response = await fetch('/api/health', { cache: 'no-store' })
  if (!response.ok) return null
  const body = (await response.json()) as { version?: unknown }
  return typeof body.version === 'string' ? body.version : null
}

const standalone = () =>
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

const container = (): ContainerLike | null =>
  canUseServiceWorker() ? (navigator.serviceWorker as unknown as ContainerLike) : null

export const updates = new UpdateManager({
  pageVersion: typeof document === 'undefined' ? 'local' : pageVersion(),
  fetchVersion: healthVersion,
  askVersion: (worker) => askWorkerVersion(worker),
  reload: () => location.reload(),
  get container() {
    return container()
  },
  setTimeout: (callback, ms) => setTimeout(callback, ms),
})

export const installOffers = new InstallOffers({
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  get storage() {
    try {
      return localStorage
    } catch {
      return null
    }
  },
  standalone,
  homeScreenHint: hasHomeScreenHint(),
})

let started = false

/**
 * Once, from main.tsx: the install offer listens at once (Chromium may fire beforeinstallprompt
 * before React renders); the service worker is registered after the page has loaded, so its
 * precaching never competes with the first render. Only in a production build: `vite dev`
 * serves source files a shell cache would only get in the way of.
 */
export function startPwa({ register = import.meta.env.PROD } = {}): void {
  if (started) return
  started = true
  installOffers.listen()
  const check = () => void updates.check()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  window.addEventListener('online', check)
  setInterval(check, UPDATE_CHECK_MS)
  if (!register || !canUseServiceWorker()) return
  const go = () => {
    navigator.serviceWorker.register(SW_SCRIPT).then(
      (registration) => updates.watch(registration),
      (error: unknown) => console.warn('LongTalk: no service worker', error),
    )
  }
  if (document.readyState === 'complete') go()
  else window.addEventListener('load', go, { once: true })
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(updates.subscribe, updates.getSnapshot)
}

export function useInstallOffer(): InstallOffer {
  return useSyncExternalStore(installOffers.subscribe, installOffers.getSnapshot)
}

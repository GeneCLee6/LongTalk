// The service worker (e4-t12): an app shell only. Built by scripts/swPlugin.ts into /sw.js, a
// classic script with this version's file list in front (`self.__LT_SW__`). The handlers are in
// swWorker.ts and the rules in swRouting.ts; DEPLOY.md §10 says how it behaves across deploys.
//
// No skipWaiting on install: a new version waits until the page asks for it (the user pressed
// 重新整理 on 「有新版本」) or every tab of the old one is closed, so a meeting never reloads by
// itself. clients.claim on activate: the first visit is controlled at once (offline works from
// then on); a tab that stays on the previous version keeps finding its files in the cache kept
// for it (swRouting.ts `cachesToDelete`).
import type { SwMessage, SwVersionReply } from './swRouting.ts'
import { activateShell, installShell, respond, type SwBuild, type SwEnv } from './swWorker.ts'

// The few worker types used here (the app's tsconfig has the DOM library, not WebWorker)
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void
}
interface FetchEvent extends ExtendableEvent {
  request: Request
  respondWith(response: Promise<Response>): void
}
interface ExtendableMessageEvent extends ExtendableEvent {
  data: unknown
  ports: readonly MessagePort[]
}
interface WorkerScope {
  location: Location
  caches: CacheStorage
  fetch: typeof fetch
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void
  addEventListener(type: 'message', listener: (event: ExtendableMessageEvent) => void): void
  __LT_SW__?: SwBuild
}

const scope = self as unknown as WorkerScope
const build: SwBuild = scope.__LT_SW__ ?? { version: 'dev', appVersion: 'local', precache: [] }

const env: SwEnv = {
  caches: {
    open: (name) => scope.caches.open(name),
    keys: () => scope.caches.keys(),
    delete: (name) => scope.caches.delete(name),
    match: (url) => scope.caches.match(url),
  },
  fetch: (input, init) => scope.fetch(input, init),
  origin: scope.location.origin,
  build,
}

scope.addEventListener('install', (event) => event.waitUntil(installShell(env)))

scope.addEventListener('activate', (event) =>
  event.waitUntil(activateShell(env).then(() => scope.clients.claim())),
)

scope.addEventListener('fetch', (event) => {
  const { request } = event
  const answer = respond(env, {
    url: request.url,
    method: request.method,
    mode: request.mode,
    raw: request,
  })
  if (answer) event.respondWith(answer)
})

scope.addEventListener('message', (event) => {
  const message = event.data as SwMessage | null
  if (message?.type === 'skipWaiting') {
    event.waitUntil(scope.skipWaiting())
  } else if (message?.type === 'version') {
    const reply: SwVersionReply = { appVersion: build.appVersion, version: build.version }
    event.ports[0]?.postMessage(reply)
  }
})

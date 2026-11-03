// The service worker's handlers (e4-t12), with the browser's caches and fetch passed in, so
// tests/app/pwa.test.ts runs them against stand-ins. src/pwa/sw.ts wires them to the worker's
// events. The rules (what is cached, what is never touched) are in swRouting.ts.
import {
  META_ACTIVE_URL,
  META_CACHE,
  SHELL_URL,
  cachesToDelete,
  mayCache,
  shellCacheName,
  swRoute,
  type SwRequest,
} from './swRouting.ts'

/** What the build writes into sw.js (scripts/swPlugin.ts) */
export interface SwBuild {
  /** A hash of the precache list: a new build with any file changed is a new version */
  version: string
  /** The deployed commit (APP_VERSION), as the page's <meta name="app-version"> says it */
  appVersion: string
  precache: string[]
}

export interface CacheLike {
  match(url: string): Promise<Response | undefined>
  put(url: string, response: Response): Promise<void>
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>
  keys(): Promise<string[]>
  delete(name: string): Promise<boolean>
  /** Looks in every cache of this origin */
  match(url: string): Promise<Response | undefined>
}

export interface SwEnv {
  caches: CacheStorageLike
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>
  /** The worker's origin (self.location.origin) */
  origin: string
  build: SwBuild
}

/**
 * Install: fetch every file of this version past the HTTP cache and keep it. One failure fails
 * the install (the browser tries again later), so a version is never half cached.
 */
export async function installShell(env: SwEnv): Promise<void> {
  const cache = await env.caches.open(shellCacheName(env.build.version))
  await Promise.all(
    env.build.precache.map(async (path) => {
      const url = new URL(path, env.origin).href
      const response = await env.fetch(url, { cache: 'reload', credentials: 'same-origin' })
      if (!mayCache(url, response)) throw new Error(`precache ${path}: ${response.status}`)
      await cache.put(path, response)
    }),
  )
}

/**
 * Activate: remember this version as the active one and delete the shell caches of every
 * version but this one and the one active before it (swRouting.ts `cachesToDelete`).
 */
export async function activateShell(env: SwEnv): Promise<string[]> {
  const meta = await env.caches.open(META_CACHE)
  const before = await meta.match(META_ACTIVE_URL)
  const previous = before ? (await before.text()) || null : null
  const stale = cachesToDelete(
    await env.caches.keys(),
    env.build.version,
    previous === env.build.version ? null : previous,
  )
  await Promise.all(stale.map((key) => env.caches.delete(key)))
  await meta.put(META_ACTIVE_URL, new Response(env.build.version))
  return stale
}

/**
 * Fetch: the answer for a request, or null to leave it alone (no respondWith: the browser goes
 * to the network itself). /api/*, other origins and anything but GET are always left alone.
 */
export function respond(
  env: SwEnv,
  request: SwRequest & { raw?: Request },
): Promise<Response> | null {
  const input = request.raw ?? request.url
  switch (swRoute(request, env.origin)) {
    case 'bypass':
      return null
    case 'navigate':
      // The network first: online, a page load always gets the deployed version. Offline, this
      // version's shell, which opens the app (the room then says it needs the network).
      return env.fetch(input).catch(async () => {
        const own = await env.caches.open(shellCacheName(env.build.version))
        return (
          (await own.match(SHELL_URL)) ?? (await env.caches.match(SHELL_URL)) ?? Response.error()
        )
      })
    case 'asset':
      // Hashed names never change their bytes: whichever version's cache has it (the one before
      // included, for a meeting tab still running it), else the network
      return env.caches.match(new URL(request.url).pathname).then((hit) => hit ?? env.fetch(input))
    case 'static':
      return env
        .fetch(input)
        .catch(
          async () => (await env.caches.match(new URL(request.url).pathname)) ?? Response.error(),
        )
  }
}

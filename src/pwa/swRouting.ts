// The service worker's rules (e4-t12), as pure functions: src/pwa/sw.ts applies them, the build
// (vite.config.ts) uses `precacheUrls`, and tests/app/pwa.test.ts checks them. Only sw.ts and
// the build import this file, so the build can inline it into sw.js (a classic script).
//
// The service worker is an app shell only: it keeps this version's index.html and its hashed
// files, so the app opens offline (joining a room needs the network: AC-4.7) and a meeting tab
// can still load a lazy chunk after a deploy replaced it on the server. It never answers /api/*
// (rooms, the SFU proxy, TURN credentials, telemetry), WebSockets (the browser does not route
// them through a service worker at all) or anything from another origin.

/** What the service worker does with a request */
export type SwRoute =
  /** Not ours: no respondWith, the browser goes to the network as if there were no worker */
  | 'bypass'
  /** A page load: the network first, this version's shell when offline */
  | 'navigate'
  /** A hashed file under /assets/: the same name is always the same bytes, so the cache first */
  | 'asset'
  /** Another file of ours (icons, manifest): the network first, the cache when offline */
  | 'static'

export interface SwRequest {
  url: string
  method: string
  /** Request.mode: `navigate` for a page load */
  mode: string
}

/** The shell's cache key: index.html, as the site serves it at / */
export const SHELL_URL = '/'
/** Every shell cache starts with this; the rest is the build's version */
export const CACHE_PREFIX = 'longtalk-shell-'
/** One small cache that remembers which version was active (for keeping the one before) */
export const META_CACHE = 'longtalk-meta'
export const META_ACTIVE_URL = '/__sw/active'
/** The worker's own file: never cached by it */
export const SW_URL = '/sw.js'

/** Files of public/ the shell keeps besides the build's: what the installed app shows offline */
export const STATIC_PRECACHE = ['/favicon.svg', '/favicon.ico', '/manifest.webmanifest'] as const

const isApi = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/')

/** Which strategy a request gets; anything not clearly ours is `bypass` */
export function swRoute(request: SwRequest, origin: string): SwRoute {
  if (request.method !== 'GET') return 'bypass'
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return 'bypass'
  }
  if (url.origin !== origin) return 'bypass'
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'bypass'
  if (isApi(url.pathname) || url.pathname === SW_URL) return 'bypass'
  if (request.mode === 'navigate') return 'navigate'
  if (url.pathname.startsWith('/assets/')) return 'asset'
  return 'static'
}

/** Whether a response may be stored: never an API answer, only a whole same-origin 200 */
export function mayCache(url: string, response: { ok: boolean; status: number; type: string }) {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return false
  }
  return (
    !isApi(pathname) &&
    pathname !== SW_URL &&
    response.ok &&
    response.status === 200 &&
    (response.type === 'basic' || response.type === 'default')
  )
}

export const shellCacheName = (version: string) => `${CACHE_PREFIX}${version}`

/**
 * The shell caches to delete when `current` activates: all but this version's and the one that
 * was active before it (`previous`). A meeting tab still running the previous version can then
 * load its lazy chunks from that cache after the server dropped them; one version later they go.
 */
export function cachesToDelete(keys: string[], current: string, previous: string | null): string[] {
  const keep = new Set([shellCacheName(current), ...(previous ? [shellCacheName(previous)] : [])])
  return keys.filter((key) => key.startsWith(CACHE_PREFIX) && !keep.has(key))
}

/**
 * 背景模糊's worker and MediaPipe's loader (e6-t06), half a megabyte nobody needs until they turn
 * the blur on: fetched then, and cached like any /assets/ file from that moment (the wasm and the
 * model too)
 */
const NOT_PRECACHED = /^assets\/(blurWorker|vision_wasm_internal)-/

/**
 * What the shell precaches, from the build's output file names: the shell itself, every
 * JavaScript and CSS file under assets/ (the home page, the room, the lazy chunks: the whole
 * current version, but for NOT_PRECACHED) and a few files of public/. Sorted and unique, so the
 * same build always gives the same list (and the same sw.js).
 */
export function precacheUrls(files: readonly string[]): string[] {
  const built = files
    .filter(
      (file) =>
        file.startsWith('assets/') && /\.(js|css)$/.test(file) && !NOT_PRECACHED.test(file),
    )
    .map((file) => `/${file}`)
  return [...new Set([SHELL_URL, ...STATIC_PRECACHE, ...built])].sort()
}

/** Messages between the page and the service worker */
export type SwMessage =
  /** Page → waiting worker: take over now (the page reloads itself after) */
  | { type: 'skipWaiting' }
  /** Page → worker: which app version did you come with? Answered on the message's port */
  | { type: 'version' }

export interface SwVersionReply {
  /** The deployed commit the worker was built with (APP_VERSION; `local` in development) */
  appVersion: string
  /** The hash of what it precaches */
  version: string
}

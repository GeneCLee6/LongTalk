// G4 (e4-t12, AC-4.7): the service worker's rules (never /api, never another origin, the shell
// offline, versioned caches), the new-version flow (never a reload by itself) and the install
// offer (Chromium's dialog, the iOS hint, remembered), plus the offline screens.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstallCard } from '../../src/components/InstallPrompt.tsx'
import { UpdateCard } from '../../src/components/UpdatePrompt.tsx'
import { App } from '../../src/App.tsx'
import { HomePage } from '../../src/pages/HomePage.tsx'
import {
  INSTALL_DISMISSED_KEY,
  InstallOffers,
  installOffer,
  type InstallEnv,
} from '../../src/pwa/install.ts'
import {
  CACHE_PREFIX,
  META_ACTIVE_URL,
  META_CACHE,
  SHELL_URL,
  SW_URL,
  cachesToDelete,
  mayCache,
  precacheUrls,
  shellCacheName,
  swRoute,
} from '../../src/pwa/swRouting.ts'
import {
  activateShell,
  installShell,
  respond,
  type CacheLike,
  type CacheStorageLike,
  type SwEnv,
} from '../../src/pwa/swWorker.ts'
import {
  TAKEOVER_TIMEOUT_MS,
  UpdateManager,
  type ContainerLike,
  type RegistrationLike,
  type UpdateDeps,
  type WorkerLike,
} from '../../src/pwa/update.ts'
import { SW_SCRIPT } from '../../src/pwa/pwa.ts'
import { preloadRoomPage } from './preloadRoom.ts'

preloadRoomPage()

const ORIGIN = 'https://longtalk.example'
const at = (path: string) => `${ORIGIN}${path}`
const get = (path: string, mode = 'cors') => ({ url: at(path), method: 'GET', mode })

describe('service worker routes (e4-t12)', () => {
  it('never touches /api/*, whatever the method or mode', () => {
    for (const path of [
      '/api/health',
      '/api/rooms',
      '/api/rooms/abc/ws?v=13',
      '/api/sfu/abc/sessions',
      '/api/turn/abc',
      '/api/events',
      '/api',
    ]) {
      expect(swRoute(get(path), ORIGIN)).toBe('bypass')
      expect(swRoute(get(path, 'navigate'), ORIGIN)).toBe('bypass')
      expect(swRoute({ url: at(path), method: 'POST', mode: 'cors' }, ORIGIN)).toBe('bypass')
    }
  })

  it('leaves other origins, WebSockets, non-GET and itself alone', () => {
    // The SFU and TURN are other hosts (and the SFU is reached through /api anyway)
    expect(
      swRoute(
        {
          url: 'https://rtc.live.cloudflare.com/v1/apps/x/sessions/new',
          method: 'POST',
          mode: 'cors',
        },
        ORIGIN,
      ),
    ).toBe('bypass')
    expect(
      swRoute({ url: 'https://speed.cloudflare.com/x.js', method: 'GET', mode: 'no-cors' }, ORIGIN),
    ).toBe('bypass')
    expect(
      swRoute(
        { url: 'wss://longtalk.example/api/rooms/abc/ws', method: 'GET', mode: 'websocket' },
        ORIGIN,
      ),
    ).toBe('bypass')
    expect(swRoute({ url: at('/'), method: 'POST', mode: 'navigate' }, ORIGIN)).toBe('bypass')
    expect(swRoute(get('/sw.js'), ORIGIN)).toBe('bypass')
    expect(swRoute({ url: 'not a url', method: 'GET', mode: 'cors' }, ORIGIN)).toBe('bypass')
  })

  it('serves page loads network-first, hashed files cache-first, the rest network-first', () => {
    expect(swRoute(get('/', 'navigate'), ORIGIN)).toBe('navigate')
    expect(swRoute(get('/r/abcdefghij', 'navigate'), ORIGIN)).toBe('navigate')
    expect(swRoute(get('/assets/RoomPage-abc123.js'), ORIGIN)).toBe('asset')
    expect(swRoute(get('/favicon.svg'), ORIGIN)).toBe('static')
    expect(swRoute(get('/manifest.webmanifest'), ORIGIN)).toBe('static')
  })

  it('only ever stores whole same-origin 200s, never an API answer', () => {
    const ok = { ok: true, status: 200, type: 'basic' }
    expect(mayCache(at('/assets/a.js'), ok)).toBe(true)
    expect(mayCache(at('/api/health'), ok)).toBe(false)
    expect(mayCache(at('/sw.js'), ok)).toBe(false)
    expect(mayCache(at('/assets/a.js'), { ok: false, status: 404, type: 'basic' })).toBe(false)
    expect(mayCache(at('/assets/a.js'), { ok: true, status: 206, type: 'basic' })).toBe(false)
    expect(mayCache(at('/assets/a.js'), { ok: false, status: 0, type: 'opaque' })).toBe(false)
  })

  it('precaches the shell and this version’s files, sorted, the same every time', () => {
    const files = [
      'index.html',
      'assets/index-B.js',
      'assets/RoomPage-A.js',
      'assets/style-C.css',
      'favicon.svg',
      '.vite/manifest.json',
      'assets/logo.png',
    ]
    const list = precacheUrls(files)
    expect(list).toEqual([
      '/',
      '/assets/RoomPage-A.js',
      '/assets/index-B.js',
      '/assets/style-C.css',
      '/favicon.ico',
      '/favicon.svg',
      '/manifest.webmanifest',
    ])
    expect(precacheUrls([...files].reverse())).toEqual(list)
    expect(list.some((url) => url.startsWith('/api'))).toBe(false)
  })

  it('leaves 背景模糊’s worker and loader out: nobody downloads them until they turn it on', () => {
    expect(
      precacheUrls([
        'assets/blurWorker-X.js',
        'assets/vision_wasm_internal-Y.js',
        'assets/vision_wasm_internal-Z.wasm',
        'assets/backgroundBlur-A.js',
      ]),
    ).toContain('/assets/backgroundBlur-A.js')
    const list = precacheUrls(['assets/blurWorker-X.js', 'assets/vision_wasm_internal-Y.js'])
    expect(list.some((url) => /blurWorker|vision_wasm/.test(url))).toBe(false)
  })

  it('deletes every shell cache but this version’s and the one before', () => {
    const keys = [
      shellCacheName('v1'),
      shellCacheName('v2'),
      shellCacheName('v3'),
      META_CACHE,
      'someone-else',
    ]
    expect(cachesToDelete(keys, 'v3', 'v2')).toEqual([shellCacheName('v1')])
    expect(cachesToDelete(keys, 'v3', null)).toEqual([shellCacheName('v1'), shellCacheName('v2')])
    expect(CACHE_PREFIX).toBe('longtalk-shell-')
  })
})

/** In-memory CacheStorage, keyed by path */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>()
  const open = (name: string): CacheLike => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)!
    return {
      match: async (url) => store.get(url)?.clone(),
      put: async (url, response) => {
        store.set(url, response)
      },
    }
  }
  const storage: CacheStorageLike = {
    open: async (name) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (url) => {
      for (const store of stores.values()) {
        const hit = store.get(url)
        if (hit) return hit.clone()
      }
      return undefined
    },
  }
  return { storage, stores }
}

function swEnv(precache: string[], fetcher: SwEnv['fetch'], version = 'v2') {
  const { storage, stores } = fakeCaches()
  const env: SwEnv = {
    caches: storage,
    fetch: fetcher,
    origin: ORIGIN,
    build: { version, appVersion: 'abc', precache },
  }
  return { env, stores }
}

const page = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

describe('service worker handlers (e4-t12)', () => {
  it('installs this version’s shell past the HTTP cache', async () => {
    const fetcher = vi.fn(async (input: string | Request) => page(`body of ${String(input)}`))
    const { env, stores } = swEnv(['/', '/assets/a.js'], fetcher)
    await installShell(env)
    expect(fetcher).toHaveBeenCalledWith(at('/'), expect.objectContaining({ cache: 'reload' }))
    expect([...stores.get(shellCacheName('v2'))!.keys()]).toEqual(['/', '/assets/a.js'])
  })

  it('fails the install rather than keep half a version, and never stores /api', async () => {
    const { env } = swEnv(['/', '/assets/gone.js'], async (input) =>
      String(input).endsWith('gone.js') ? new Response('', { status: 404 }) : page('ok'),
    )
    await expect(installShell(env)).rejects.toThrow(/gone\.js/)
    const sneaky = swEnv(['/api/health'], async () => page('{}'))
    await expect(installShell(sneaky.env)).rejects.toThrow()
    expect([...(sneaky.stores.get(shellCacheName('v2'))?.keys() ?? [])]).toEqual([])
  })

  it('leaves /api, other origins and non-GET to the browser (no respondWith)', () => {
    const fetcher = vi.fn(async () => page('x'))
    const { env } = swEnv([], fetcher)
    expect(respond(env, get('/api/health'))).toBeNull()
    expect(respond(env, { url: at('/api/rooms'), method: 'POST', mode: 'cors' })).toBeNull()
    expect(
      respond(env, { url: 'https://rtc.live.cloudflare.com/x', method: 'GET', mode: 'cors' }),
    ).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('loads pages from the network, and this version’s shell when offline', async () => {
    let online = true
    const { env } = swEnv(['/'], async () => {
      if (!online) throw new TypeError('Failed to fetch')
      return page('live')
    })
    await installShell(env)
    expect(await respond(env, get('/r/abcdefghij', 'navigate'))!.then((r) => r.text())).toBe('live')
    online = false
    expect(await respond(env, get('/r/abcdefghij', 'navigate'))!.then((r) => r.text())).toBe('live')
    // (the shell cached at install is what came back: the same body here)
    const empty = swEnv([], async () => {
      throw new TypeError('offline')
    })
    expect((await respond(empty.env, get('/', 'navigate'))!).type).toBe('error')
  })

  it('serves a hashed file from any kept version, so an old meeting tab still loads its chunks', async () => {
    const fetcher = vi.fn(async () => page('from network'))
    const { env, stores } = swEnv([], fetcher, 'v3')
    stores.set(shellCacheName('v2'), new Map([['/assets/Old-1.js', page('old chunk')]]))
    expect(await respond(env, get('/assets/Old-1.js'))!.then((r) => r.text())).toBe('old chunk')
    expect(fetcher).not.toHaveBeenCalled()
    expect(await respond(env, get('/assets/New-2.js'))!.then((r) => r.text())).toBe('from network')
  })

  it('activates: keeps the version before, deletes older ones, remembers itself', async () => {
    const { env, stores } = swEnv([], async () => page(''), 'v3')
    for (const v of ['v1', 'v2', 'v3']) stores.set(shellCacheName(v), new Map())
    stores.set(META_CACHE, new Map([[META_ACTIVE_URL, new Response('v2')]]))
    expect(await activateShell(env)).toEqual([shellCacheName('v1')])
    expect([...stores.keys()].sort()).toEqual([
      META_CACHE,
      shellCacheName('v2'),
      shellCacheName('v3'),
    ])
    expect(await stores.get(META_CACHE)!.get(META_ACTIVE_URL)!.text()).toBe('v3')
  })

  it('has its shell at /, and the page registers the script the build writes', () => {
    expect(SHELL_URL).toBe('/')
    expect(SW_SCRIPT).toBe(SW_URL)
  })
})

/** A service worker stand-in that answers `version` with `reply` */
function fakeWorker(reply: { appVersion: string; version: string } | null) {
  const listeners: (() => void)[] = []
  const worker = {
    state: 'installed',
    reply,
    postMessage: vi.fn(),
    addEventListener: (_type: 'statechange', listener: () => void) => listeners.push(listener),
    change(state: string) {
      worker.state = state
      for (const listener of listeners) listener()
    },
  }
  return worker
}

function updateSetup({
  page = 'new-commit',
  live = 'new-commit',
  controller = fakeWorker({ appVersion: 'old-commit', version: 'files-1' }) as ReturnType<
    typeof fakeWorker
  > | null,
  sw = true,
}: {
  page?: string
  live?: string | null
  controller?: ReturnType<typeof fakeWorker> | null
  sw?: boolean
} = {}) {
  const changeListeners = new Set<() => void>()
  const container: ContainerLike = {
    controller: controller as WorkerLike | null,
    addEventListener: (_type, listener) => changeListeners.add(listener),
    removeEventListener: (_type, listener) => changeListeners.delete(listener),
  }
  const timers: (() => void)[] = []
  const deps: UpdateDeps = {
    pageVersion: page,
    fetchVersion: vi.fn(async () => live),
    askVersion: async (worker) => (worker as unknown as ReturnType<typeof fakeWorker>).reply,
    reload: vi.fn(),
    container: sw ? container : null,
    setTimeout: (callback) => timers.push(callback),
  }
  const updates = new UpdateManager(deps)
  const found: (() => void)[] = []
  const registration = {
    installing: null as WorkerLike | null,
    waiting: null as WorkerLike | null,
    update: vi.fn(async () => undefined),
    addEventListener: (_type: 'updatefound', listener: () => void) => found.push(listener),
  } satisfies RegistrationLike
  return {
    updates,
    deps,
    registration,
    timers,
    /** A new worker installs and waits */
    async arrive(worker: ReturnType<typeof fakeWorker>) {
      registration.installing = worker as WorkerLike
      for (const listener of found) listener()
      registration.waiting = worker as WorkerLike
      registration.installing = null
      worker.change('installed')
      await Promise.resolve()
      await Promise.resolve()
    },
    takeOver() {
      for (const listener of [...changeListeners]) listener()
    },
  }
}

describe('new versions (e4-t12)', () => {
  it('offers a reload when a waiting worker brings other files than the page runs', async () => {
    const setup = updateSetup({ page: 'old-commit' })
    setup.updates.watch(setup.registration)
    const incoming = fakeWorker({ appVersion: 'new-commit', version: 'files-2' })
    await setup.arrive(incoming)
    expect(setup.updates.getSnapshot()).toBe('available')
    expect(incoming.postMessage).not.toHaveBeenCalled()
    // Never by itself: nothing reloads until asked
    expect(setup.deps.reload).not.toHaveBeenCalled()
  })

  it('takes over quietly when the page already runs it, or nothing the browser runs changed', async () => {
    // A navigation already brought the new deploy's page
    const already = updateSetup({ page: 'new-commit' })
    already.updates.watch(already.registration)
    const incoming = fakeWorker({ appVersion: 'new-commit', version: 'files-2' })
    await already.arrive(incoming)
    expect(already.updates.getSnapshot()).toBe('none')
    expect(incoming.postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' })
    // A docs-only deploy: same files under another commit
    const docs = updateSetup({ page: 'old-commit' })
    docs.updates.watch(docs.registration)
    const same = fakeWorker({ appVersion: 'docs-commit', version: 'files-1' })
    await docs.arrive(same)
    expect(docs.updates.getSnapshot()).toBe('none')
    expect(same.postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' })
    expect(docs.deps.reload).not.toHaveBeenCalled()
  })

  it('stays quiet on the first install (nothing controls the page yet)', async () => {
    const setup = updateSetup({ page: 'old-commit', controller: null })
    setup.updates.watch(setup.registration)
    await setup.arrive(fakeWorker({ appVersion: 'new-commit', version: 'files-2' }))
    expect(setup.updates.getSnapshot()).toBe('none')
  })

  it('reloads this tab once the new worker has taken over (or after a timeout)', async () => {
    const setup = updateSetup({ page: 'old-commit' })
    setup.updates.watch(setup.registration)
    const incoming = fakeWorker({ appVersion: 'new-commit', version: 'files-2' })
    await setup.arrive(incoming)
    setup.updates.apply()
    expect(setup.updates.getSnapshot()).toBe('applying')
    expect(incoming.postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' })
    expect(setup.deps.reload).not.toHaveBeenCalled()
    setup.takeOver()
    expect(setup.deps.reload).toHaveBeenCalledTimes(1)
    // The fallback timer does not reload a second time
    setup.timers.forEach((timer) => timer())
    expect(setup.deps.reload).toHaveBeenCalledTimes(1)
    expect(TAKEOVER_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('稍後 hides it until the next change of page, which applies it', async () => {
    const setup = updateSetup({ page: 'old-commit' })
    setup.updates.watch(setup.registration)
    await setup.arrive(fakeWorker({ appVersion: 'new-commit', version: 'files-2' }))
    setup.updates.dismiss()
    expect(setup.updates.getSnapshot()).toBe('dismissed')
    expect(setup.deps.reload).not.toHaveBeenCalled()
    setup.updates.navigated()
    setup.takeOver()
    expect(setup.deps.reload).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a change of page when there is no update', () => {
    const setup = updateSetup()
    setup.updates.navigated()
    expect(setup.deps.reload).not.toHaveBeenCalled()
  })

  it('asks the browser to check sw.js when it has a worker', async () => {
    const setup = updateSetup({ page: 'old-commit', live: 'new-commit' })
    setup.updates.watch(setup.registration)
    await setup.updates.check()
    expect(setup.registration.update).toHaveBeenCalled()
    expect(setup.deps.fetchVersion).not.toHaveBeenCalled()
  })

  it('without a service worker, compares /api/health with the page’s version', async () => {
    const differs = updateSetup({ page: 'old-commit', live: 'new-commit', sw: false })
    await differs.updates.check()
    expect(differs.updates.getSnapshot()).toBe('available')
    differs.updates.apply()
    expect(differs.deps.reload).toHaveBeenCalledTimes(1)
    for (const [page, live] of [
      ['same', 'same'],
      ['local', 'abc'],
      ['abc', 'local'],
      ['abc', null],
    ] as const) {
      const setup = updateSetup({ page, live, sw: false })
      await setup.updates.check()
      expect(setup.updates.getSnapshot()).toBe('none')
    }
  })

  it('shows a card, not a dialog: the room says a reload goes straight back in', () => {
    const onReload = vi.fn()
    const onLater = vi.fn()
    const { rerender } = render(
      <UpdateCard state="available" inRoom={false} onReload={onReload} onLater={onLater} />,
    )
    const card = screen.getByRole('status', { name: '新版本' })
    expect(card).toHaveTextContent('有新版本，重新整理就能使用。')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新整理' }))
    fireEvent.click(screen.getByRole('button', { name: '稍後' }))
    expect(onReload).toHaveBeenCalled()
    expect(onLater).toHaveBeenCalled()
    rerender(<UpdateCard state="available" inRoom onReload={onReload} onLater={onLater} />)
    expect(screen.getByRole('status', { name: '新版本' })).toHaveTextContent('直接回到這場會議')
    rerender(<UpdateCard state="dismissed" inRoom onReload={onReload} onLater={onLater} />)
    expect(screen.queryByRole('status', { name: '新版本' })).toBeNull()
  })
})

/** The browser's side of the install offer */
function installEnv({
  standalone = false,
  homeScreenHint = false,
  stored = null as string | null,
} = {}) {
  const listeners = new Map<string, (event: Event) => void>()
  const store = new Map<string, string>(stored ? [[INSTALL_DISMISSED_KEY, stored]] : [])
  const env: InstallEnv = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
    standalone: () => standalone,
    homeScreenHint,
  }
  const promptEvent = () => {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>
      userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
    }
    event.prompt = vi.fn(async () => undefined)
    event.userChoice = Promise.resolve({ outcome: 'dismissed' })
    return event
  }
  return {
    env,
    store,
    fire(type: string, event: Event = promptEvent()) {
      listeners.get(type)?.(event)
      return event
    },
    promptEvent,
  }
}

describe('install offer (e4-t12)', () => {
  it('offers the browser’s dialog, or the iOS hint, never once installed or dismissed', () => {
    const base = { deferred: false, homeScreenHint: false, standalone: false, dismissed: false }
    expect(installOffer(base)).toBeNull()
    expect(installOffer({ ...base, deferred: true })).toBe('prompt')
    expect(installOffer({ ...base, homeScreenHint: true })).toBe('ios')
    expect(installOffer({ ...base, deferred: true, homeScreenHint: true })).toBe('prompt')
    expect(installOffer({ ...base, deferred: true, standalone: true })).toBeNull()
    expect(installOffer({ ...base, homeScreenHint: true, dismissed: true })).toBeNull()
  })

  it('keeps beforeinstallprompt for its own button, and asks once', async () => {
    const browser = installEnv()
    const offers = new InstallOffers(browser.env)
    offers.listen()
    expect(offers.getSnapshot()).toBeNull()
    const event = browser.fire('beforeinstallprompt')
    expect(event.defaultPrevented).toBe(true)
    expect(offers.getSnapshot()).toBe('prompt')
    await offers.install()
    expect((event as unknown as { prompt: () => void }).prompt).toHaveBeenCalledTimes(1)
    expect(offers.getSnapshot()).toBeNull()
    // Remembered: a new page load offers nothing, even when the browser fires the event again
    const next = new InstallOffers(browser.env)
    next.listen()
    browser.fire('beforeinstallprompt')
    expect(next.getSnapshot()).toBeNull()
  })

  it('remembers 不用了, and stops once the browser says it is installed', () => {
    const browser = installEnv()
    const offers = new InstallOffers(browser.env)
    offers.listen()
    browser.fire('beforeinstallprompt')
    offers.dismiss()
    expect(offers.getSnapshot()).toBeNull()
    expect(browser.store.get(INSTALL_DISMISSED_KEY)).toBe('1')
    const other = installEnv()
    const fresh = new InstallOffers(other.env)
    fresh.listen()
    other.fire('beforeinstallprompt')
    other.fire('appinstalled', new Event('appinstalled'))
    expect(fresh.getSnapshot()).toBeNull()
  })

  it('shows the iOS hint once, and never in the installed app', () => {
    const iphone = installEnv({ homeScreenHint: true })
    const offers = new InstallOffers(iphone.env)
    expect(offers.getSnapshot()).toBe('ios')
    offers.shown()
    // Still on screen for this visit, gone on the next
    expect(offers.getSnapshot()).toBe('ios')
    expect(new InstallOffers(iphone.env).getSnapshot()).toBeNull()
    expect(
      new InstallOffers(installEnv({ homeScreenHint: true, standalone: true }).env).getSnapshot(),
    ).toBeNull()
  })

  it('renders the offer: 安裝 for Chromium, the share-sheet steps for iOS', () => {
    const onInstall = vi.fn()
    const onDismiss = vi.fn()
    const { rerender } = render(
      <InstallCard offer="prompt" onInstall={onInstall} onDismiss={onDismiss} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '安裝' }))
    fireEvent.click(screen.getByRole('button', { name: '不用了' }))
    expect(onInstall).toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalled()
    rerender(<InstallCard offer="ios" onInstall={onInstall} onDismiss={onDismiss} />)
    expect(screen.getByText(/「分享」，再選「加入主畫面」/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '安裝' })).toBeNull()
    expect(screen.getByRole('button', { name: '知道了' })).toBeInTheDocument()
    rerender(<InstallCard offer={null} onInstall={onInstall} onDismiss={onDismiss} />)
    expect(screen.queryByRole('complementary', { name: '安裝 App' })).toBeNull()
  })
})

describe('offline (e4-t12)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
  })

  it('says so on the home page', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('你目前離線')
  })

  it('opens a room link offline as 「你目前離線」, and tries again once back online', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const fetcher = vi.fn(async () => {
      if (!navigator.onLine) throw new TypeError('Failed to fetch')
      return Response.json({ id: 'abcdefghij', createdAt: 1, memberCount: 2 })
    })
    vi.stubGlobal('fetch', fetcher)
    window.history.replaceState(null, '', '/r/abcdefghij')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '你目前離線' })).toBeInTheDocument()
    onLine.mockReturnValue(true)
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(await screen.findByText(/目前 2 人在裡面/)).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

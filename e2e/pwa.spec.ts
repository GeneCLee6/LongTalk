import { expect, test, type Page } from '@playwright/test'
// The browsers run in zh-TW (playwright.config.ts)
import { zhTW as strings } from '../src/i18n/zh-TW.ts'
import { receivesOnlyWhatIsInView } from './subscribeScenario.ts'

// G4 (e4-t12, e4-t13): light checks on the deployed preview. The service worker registers and
// takes control, precaches the shell, never answers /api/* (nor keeps any /api answer), and the
// shell opens offline; in a room, M mutes and unmutes, and Space held while muted talks.

/** Waits until a service worker controls the page (the first visit claims it on activate) */
async function controlled(page: Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30_000 })
}

test('the service worker keeps the shell, opens it offline, and never touches /api', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'zh-TW' })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: strings.tagline })).toBeVisible()
  await controlled(page)
  const sw = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return registration.active?.scriptURL ?? ''
  })
  expect(new URL(sw).pathname).toBe('/sw.js')

  // /api goes to the network, never through the worker
  const [health] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/health'),
    page.evaluate(() => fetch('/api/health').then((r) => r.status)),
  ])
  expect(health.fromServiceWorker()).toBe(false)
  expect(health.status()).toBe(200)

  // The shell is cached; nothing under /api is
  const cached = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) urls.push(new URL(request.url).pathname)
    }
    return urls
  })
  expect(cached).toContain('/')
  expect(cached.some((path) => path.startsWith('/assets/'))).toBe(true)
  expect(cached.filter((path) => path.startsWith('/api'))).toEqual([])

  // Offline: the home page still opens (from the worker) and says it is offline; a room's link
  // says joining needs the network
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: strings.tagline })).toBeVisible()
  await expect(page.getByText(strings.pwa.offlineHome)).toBeVisible()
  await page.goto('/r/abcdefghij')
  await expect(page.getByRole('heading', { name: strings.pwa.offlineTitle })).toBeVisible()
  await context.setOffline(false)
  await context.close()
})

test('M mutes and unmutes, and Space held while muted talks', async ({ browser }) => {
  test.setTimeout(240_000)
  const context = await browser.newContext({
    locale: 'zh-TW',
    permissions: ['camera', 'microphone'],
  })
  const page = await context.newPage()
  await page.goto('/')
  await page.getByRole('button', { name: strings.home.createRoom }).click()
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{10}$/)
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Keys')
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  const mic = (name: string) => toolbar.getByRole('button', { name, exact: true })
  await expect(mic(strings.toolbar.micOn)).toBeEnabled()
  await expect(mic(strings.toolbar.micOn)).toHaveAttribute('aria-keyshortcuts', 'M')

  // Focus on the page itself, not a field
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('m')
  await expect(mic(strings.toolbar.micOff)).toBeVisible()
  await page.keyboard.down('Space')
  await expect(mic(strings.toolbar.micOn)).toBeVisible()
  await expect(page.getByText(strings.shortcuts.talking)).toBeVisible()
  await page.keyboard.up('Space')
  await expect(mic(strings.toolbar.micOff)).toBeVisible()
  await page.keyboard.press('m')
  await expect(mic(strings.toolbar.micOn)).toBeVisible()

  // The list of shortcuts
  await page.keyboard.press('Shift+?')
  await expect(page.getByRole('dialog', { name: strings.shortcuts.title })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: strings.shortcuts.title })).toHaveCount(0)
  // L1 (e2-t18, e10-t01): the same room, as a large one seen on a phone
  const url = page.url()
  // Leaving for real: a member that only drops stays on the stage for the reconnect grace
  await page.getByRole('button', { name: strings.toolbar.leave, exact: true }).click()
  await context.close()
  await receivesOnlyWhatIsInView(browser, url)
})

import { expect, test, type Page } from '@playwright/test'
import { API_HEADERS, PAGE_HEADERS } from '../../shared/security-headers.ts'
import { joinRoom, newRoom, strings } from './helpers.ts'

// Security headers and the Content-Security-Policy (I1, e11-t06) against the built app in
// `vite preview`: every page and file carries PAGE_HEADERS (public/_headers), the API carries
// API_HEADERS, and nothing the app does is blocked: the home page, the pre-join screen, a room
// with the RNNoise worklet and wasm, the speaker test tone, /admin, the service worker.

/** Every securitypolicyviolation in the page, kept on window from before any script runs */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __csp: string[] }).__csp = seen
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI} @ ${event.sourceFile}`)
    })
  })
  const consoleRefusals: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (/Content Security Policy|Permissions-Policy|Refused to/i.test(text)) {
      consoleRefusals.push(text)
    }
  })
  return async () => [
    ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])),
    ...consoleRefusals,
  ]
}

const lower = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))

test('pages, files and the API carry the security headers', async ({ request }) => {
  const path = (await (await request.post('/api/rooms')).json()) as { id: string }
  for (const url of ['/', `/r/${path.id}`, '/admin', '/sw.js', '/manifest.webmanifest']) {
    const headers = (await request.get(url)).headers()
    for (const [name, value] of Object.entries(lower(PAGE_HEADERS))) {
      expect(headers[name], `${url} ${name}`).toBe(value)
    }
  }
  const api = (await request.get('/api/health')).headers()
  for (const [name, value] of Object.entries(lower(API_HEADERS))) {
    expect(api[name], `/api/health ${name}`).toBe(value)
  }
})

test('nothing the home page, a room, RNNoise and /admin do is blocked', async ({ page }) => {
  const violations = await watchViolations(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: strings.home.createRoom })).toBeVisible()

  // Start a room from the home page (no Turnstile here: the keys are not set locally)
  await page.getByRole('button', { name: strings.home.createRoom }).click()
  await expect(page.getByRole('heading', { name: strings.prejoin.title })).toBeVisible()
  const speaker = page.getByRole('button', { name: strings.prejoin.speakerTest })
  if (await speaker.isVisible()) {
    await speaker.click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: strings.prejoin.speakerTestStop }).click()
  }
  const path = new URL(page.url()).pathname
  await joinRoom(page, path, 'Ada')

  // RNNoise: an AudioWorklet module and WebAssembly ('wasm-unsafe-eval')
  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await page.getByRole('menuitem', { name: strings.settings.menu }).click()
  const settings = page.getByRole('dialog', { name: strings.settings.title })
  await settings.getByRole('switch', { name: strings.settings.advancedNoise }).check()
  await expect(settings.getByText(strings.settings.advancedNoiseHandles)).toBeVisible()
  await page.waitForTimeout(3_000)
  await expect(page.getByText(strings.settings.advancedNoiseFailed)).toHaveCount(0)
  expect(await violations()).toEqual([])

  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: strings.admin.lockedTitle })).toBeVisible()
  expect(await violations()).toEqual([])
})

test.describe('with the service worker', () => {
  test.use({ serviceWorkers: 'allow' })

  test('the service worker registers under the policy', async ({ page }) => {
    const violations = await watchViolations(page)
    await page.goto('/')
    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready
      return registration.scope
    })
    expect(new URL(scope).pathname).toBe('/')
    expect(await violations()).toEqual([])
  })
})

test('a room page in a frame elsewhere is refused (frame-ancestors)', async ({ page, baseURL }) => {
  const room = await newRoom(page)
  // A page of another origin (about:blank with a data: document) tries to frame the room
  await page.setContent(`<iframe src="${baseURL}${room}"></iframe>`)
  const frame = page.frames().find((f) => f !== page.mainFrame())
  await page.waitForTimeout(1_000)
  // The frame never gets the app (blocked documents stay empty or show the browser's error)
  const heading = await frame
    ?.getByRole('heading', { name: strings.prejoin.title })
    .count()
    .catch(() => 0)
  expect(heading ?? 0).toBe(0)
})

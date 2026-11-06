import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, preview, type PreviewServer } from 'vite'
import { joinRoom, newRoom, strings } from './helpers.ts'

// L4 in a real Chromium, without a deployment: 背景模糊 loads from our own /assets/ under the real
// CSP and keeps the video alive, the simulcast layers go on with the processed track, the slider
// changes what plays, and the self view stays inside the stage. Going through the SFU is the
// interop test's (e2e/interop.spec.ts). This machine's fake camera shows no person: the mask's
// quality and a real laptop's CPU are the owner's check (DEPLOY.md §5).

/** What e2e/local/harness-media/main.tsx puts on the page */
declare global {
  interface Window {
    media: {
      publishCamera(): Promise<void>
      blurOn(): Promise<string>
      blurOff(): Promise<void>
      sentTrackIsCamera(): boolean
      renegotiations(): number
      lastReport(): unknown
      layers(): Promise<{ rid: string; frames: number; width: number }[]>
      startTone(): Promise<void>
      setVolume(percent: number): void
      playing(): Promise<{ volume: number; peak: number; paused: boolean }>
    }
  }
}

const toolbarOf = (page: Page) => page.getByRole('toolbar', { name: strings.devices.controls })

async function openVideoSettings(page: Page) {
  await toolbarOf(page).getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await page.getByRole('menuitem', { name: strings.settings.menu }).click()
  const settings = page.getByRole('dialog', { name: strings.settings.title })
  await settings.getByRole('tab', { name: strings.settings.video }).click()
  return settings
}

/** New frames of a <video> in a second */
const framesInASecond = (page: Page, name: string) =>
  page.getByRole('figure', { name }).locator('video').evaluate(async (video: HTMLVideoElement) => {
    let frames = 0
    const end = performance.now() + 1000
    await new Promise<void>((resolve) => {
      const next = () => {
        frames += 1
        if (performance.now() < end) video.requestVideoFrameCallback(next)
        else resolve()
      }
      video.requestVideoFrameCallback(next)
    })
    return frames
  })

test('背景模糊 loads only when turned on, from our own assets, and the video goes on', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const requests: string[] = []
  context.on('request', (request) => requests.push(request.url()))
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const origin = new URL(page.url()).origin
  const blurFiles = () => requests.filter((url) => /blur|vision_wasm|selfie_segmenter/.test(url))
  // Nothing of it in the room until it is turned on
  expect(blurFiles()).toEqual([])
  const tileName = strings.room.tileYou('Ada')
  await expect.poll(() => framesInASecond(page, tileName)).toBeGreaterThan(5)

  const settings = await openVideoSettings(page)
  const toggle = settings.getByRole('switch', { name: strings.settings.blur })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(settings.getByText(strings.settings.blurLoading)).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByText(strings.settings.blurFailed)).toHaveCount(0)
  const files = blurFiles()
  for (const name of [
    /\/assets\/blurWorker-.*\.js$/,
    /\/assets\/vision_wasm_internal-.*\.js$/,
    /\/assets\/vision_wasm_internal-.*\.wasm$/,
    /\/assets\/selfie_segmenter-.*\.tflite$/,
  ]) {
    expect(files.some((url) => name.test(url)), String(name)).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect.poll(() => framesInASecond(page, tileName)).toBeGreaterThan(5)
  await page.waitForTimeout(8_000)
  // Past the warm-up, still on: this machine keeps up, and no failure was reported
  await expect(page.getByText(strings.settings.blurOverloaded)).toHaveCount(0)
  await expect(page.getByText(strings.settings.blurFailed)).toHaveCount(0)
  expect(await framesInASecond(page, tileName)).toBeGreaterThan(5)

  // 省電模式 holds it off and keeps the choice; the picture is the camera's again
  const again = await openVideoSettings(page)
  await again.getByRole('tab', { name: strings.settings.performance }).click()
  await again.getByRole('switch', { name: strings.settings.powerSaving }).check()
  await again.getByRole('tab', { name: strings.settings.video }).click()
  await expect(toggle).toBeChecked()
  await expect(again.getByText(strings.settings.blurPowerSaving)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(() => framesInASecond(page, tileName)).toBeGreaterThan(5)

  // Nothing from anywhere else, and nothing the CSP had to stop
  expect(requests.filter((url) => /^https?:/.test(url) && !url.startsWith(origin))).toEqual([])
  expect(requests.filter((url) => url.includes('/api/csp-report'))).toEqual([])
})

test('the self view floats, drags, moves by keyboard, stays in the stage, and is remembered', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const other = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const bob = await other.newPage()
  await joinRoom(bob, path, 'Bob')

  const settings = await openVideoSettings(page)
  await settings.getByRole('switch', { name: strings.settings.selfView }).check()
  await page.keyboard.press('Escape')
  const selfView = page.getByRole('group', { name: strings.selfView.label })
  await expect(selfView).toBeVisible()
  await expect(selfView.getByRole('figure', { name: strings.room.tileYou('Ada') })).toBeVisible()
  // One place fewer in the layout: only Bob is left in the grid
  await expect(page.locator('[data-mode="grid"]')).toHaveAttribute('data-cols', '1')

  const stage = page.locator('[data-self-view]').locator('..')
  const inStage = async () => {
    const tile = (await page.locator('[data-self-view]').boundingBox())!
    const box = (await stage.boundingBox())!
    expect(tile.x).toBeGreaterThanOrEqual(box.x - 1)
    expect(tile.y).toBeGreaterThanOrEqual(box.y - 1)
    expect(tile.x + tile.width).toBeLessThanOrEqual(box.x + box.width + 1)
    expect(tile.y + tile.height).toBeLessThanOrEqual(box.y + box.height + 1)
    return { tile, box }
  }
  // It starts in the bottom right
  const start = await inStage()
  expect(start.tile.x + start.tile.width).toBeCloseTo(start.box.x + start.box.width, -1)
  expect(start.tile.y + start.tile.height).toBeCloseTo(start.box.y + start.box.height, -1)

  // Dragged far past the top left corner: it stops at the edge
  const from = {
    x: start.tile.x + start.tile.width / 2,
    y: start.tile.y + start.tile.height / 2,
  }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(-500, -500, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await page.locator('[data-self-view]').boundingBox())!.x)
    .toBeCloseTo(start.box.x, 0)
  await inStage()

  // The arrow keys, from its handle
  const handle = page.getByRole('button', { name: strings.selfView.move })
  await handle.focus()
  const before = (await page.locator('[data-self-view]').boundingBox())!
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  await expect
    .poll(async () => (await page.locator('[data-self-view]').boundingBox())!.x)
    .toBeGreaterThan(before.x + 10)
  await inStage()

  await expect(async () => {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    expect(results.violations.map((violation) => violation.id)).toEqual([])
  }).toPass()

  // A smaller window: still inside, without anything moving it
  await page.setViewportSize({ width: 800, height: 500 })
  await expect.poll(async () => (await inStage()).tile.width).toBeGreaterThan(0)

  // Remembered
  const remembered = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('longtalk.media') ?? '{}'),
  )
  expect(remembered.selfView).toBe(true)
  expect(remembered.selfViewAt.x).toBeLessThan(0.5)
  await other.close()
})

test('the participants panel has a meter and a slider for each person, with no axe violations', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000)
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const other = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const bob = await other.newPage()
  await joinRoom(bob, path, 'Bob')
  await toolbarOf(page).getByRole('button', { name: /^參與者/ }).click()
  const slider = page.getByRole('slider', { name: strings.participants.volumeOf('Bob') })
  await expect(slider).toHaveValue('100')
  await expect(page.locator('[data-level-meter]')).toHaveCount(2)
  await slider.focus()
  await page.keyboard.press('ArrowRight')
  await expect(slider).toHaveValue('105')
  await expect(slider).toHaveAttribute('aria-valuetext', '105%')
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(results.violations.map((violation) => violation.id)).toEqual([])
  // Kept for this tab's session
  await page.reload()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  await toolbarOf(page).getByRole('button', { name: /^參與者/ }).click()
  await expect(page.getByRole('slider', { name: strings.participants.volumeOf('Bob') })).toHaveValue(
    '105',
  )
  await other.close()
})

test.describe('over a real PeerConnection', () => {
  let server: PreviewServer | undefined
  let outDir: string
  let origin: string
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    outDir = mkdtempSync(join(tmpdir(), 'longtalk-media-harness-'))
    const root = 'e2e/local/harness-media'
    await build({
      configFile: false,
      logLevel: 'silent',
      root,
      base: '/',
      plugins: [react()],
      build: { outDir, emptyOutDir: true },
    })
    server = await preview({
      configFile: false,
      logLevel: 'silent',
      root,
      build: { outDir },
      preview: { port: 0, host: '127.0.0.1' },
    })
    const { port } = server.httpServer.address() as AddressInfo
    origin = `http://127.0.0.1:${port}`
  })

  test.afterAll(async () => {
    await server?.close()
    if (outDir) rmSync(outDir, { recursive: true, force: true })
  })

  test('the blurred track replaces the camera without renegotiating, in all three layers', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await page.goto(origin)
    await page.evaluate(() => window.media.publishCamera())
    const moving = async () => {
      const before = await page.evaluate(() => window.media.layers())
      await page.waitForTimeout(3_000)
      const after = await page.evaluate(() => window.media.layers())
      return after.map((layer, i) => ({
        rid: layer.rid,
        width: layer.width,
        frames: layer.frames - (before[i]?.frames ?? 0),
      }))
    }
    // The encoder takes a while to bring every layer up
    await expect
      .poll(async () => (await moving()).every((layer) => layer.frames > 5), { timeout: 30_000 })
      .toBe(true)
    const path = await page.evaluate(() => window.media.blurOn())
    expect(path).toBe('insertable')
    expect(await page.evaluate(() => window.media.sentTrackIsCamera())).toBe(false)
    await expect
      .poll(
        async () => {
          const layers = await moving()
          return layers.every((layer) => layer.frames > 5 && layer.width > 0)
        },
        { timeout: 45_000, message: 'all three layers carry the processed track' },
      )
      .toBe(true)
    const layers = await moving()
    // Each layer half as wide as the one above it
    expect(layers[0].width).toBeGreaterThan(layers[1].width)
    expect(layers[1].width).toBeGreaterThan(layers[2].width)
    expect(await page.evaluate(() => window.media.renegotiations())).toBe(0)

    // Off: the original track, still no renegotiation
    await page.evaluate(() => window.media.blurOff())
    expect(await page.evaluate(() => window.media.sentTrackIsCamera())).toBe(true)
    await expect
      .poll(async () => (await moving()).every((layer) => layer.frames > 5), { timeout: 30_000 })
      .toBe(true)
    expect(await page.evaluate(() => window.media.renegotiations())).toBe(0)
  })

  // Not in CI: what ADR-001 quotes. BLUR_MEASURE=1 npx playwright test -c
  // playwright.local.config.ts blur.spec.ts -g measure --project=chromium
  test('measure: CPU and frame rate with the camera and with the blur, encoding three layers', async ({
    page,
    browser,
  }) => {
    test.skip(!process.env.BLUR_MEASURE, 'only when asked for')
    test.setTimeout(180_000)
    await page.goto(origin)
    await page.evaluate(() => window.media.publishCamera())
    const cdp = await browser.newBrowserCDPSession()
    const cpu = async () => {
      const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
        processInfo: { cpuTime: number }[]
      }
      return processInfo.reduce((sum, process) => sum + process.cpuTime, 0)
    }
    const measure = async (label: string) => {
      await page.waitForTimeout(10_000)
      const before = { cpu: await cpu(), layers: await page.evaluate(() => window.media.layers()) }
      await page.waitForTimeout(20_000)
      const seconds = 20
      const layers = await page.evaluate(() => window.media.layers())
      console.log(
        label,
        `${Math.round(((await cpu()) - before.cpu) / seconds * 100)}% of a core,`,
        layers.map((l, i) => `${l.rid} ${l.width}px ${(l.frames - before.layers[i].frames) / seconds} fps`).join(', '),
        JSON.stringify(await page.evaluate(() => window.media.lastReport())),
      )
    }
    await measure('camera')
    await page.evaluate(() => window.media.blurOn())
    await measure('blur')
  })

  test('the volume changes what plays: the element below 100%, a gain above it', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto(origin)
    // Autoplay: a click, as joining the room is
    await page.mouse.click(1, 1)
    await page.evaluate(() => window.media.startTone())
    await expect.poll(() => page.locator('audio').count()).toBe(1)
    const playing = () => page.evaluate(() => window.media.playing())
    await expect.poll(async () => (await playing()).peak, { timeout: 15_000 }).toBeGreaterThan(0.05)
    const normal = await playing()
    expect(normal.volume).toBe(1)
    expect(normal.paused).toBe(false)

    await page.evaluate(() => window.media.setVolume(40))
    await expect.poll(async () => (await playing()).volume).toBeCloseTo(0.4)

    await page.evaluate(() => window.media.setVolume(200))
    // The element plays the gain's output now, about twice as loud
    await expect
      .poll(async () => (await playing()).peak / normal.peak, { timeout: 15_000 })
      .toBeGreaterThan(1.6)
    const boosted = await playing()
    expect(boosted.volume).toBe(1)
    expect(boosted.paused).toBe(false)

    await page.evaluate(() => window.media.setVolume(100))
    await expect
      .poll(async () => (await playing()).peak / normal.peak, { timeout: 15_000 })
      .toBeLessThan(1.3)
    expect((await playing()).paused).toBe(false)
  })
})

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { build, preview, type PreviewServer } from 'vite'
import { strings } from './helpers.ts'

// Share zoom and the annotation overlay (J1: e3-t11, e7-t02) in a real browser: the real ShareTile
// and its real lazy chunk, showing a real <video> of a canvas with known marks (harness/main.tsx),
// built on its own because `vite preview` of the app has no SFU to bring a share into a room.
// Everything is checked in screen pixels of the composited page, with the expected position worked
// out here, independently of shared/shareGeometry.ts.

const ANNOTATION_RED = { r: 244, g: 63, b: 94 } // tokens.ts annotation.colors.rose
const MARK_GREEN = { r: 0, g: 255, b: 0 }

let server: PreviewServer
let origin: string
let outDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  outDir = mkdtempSync(join(tmpdir(), 'longtalk-share-harness-'))
  const root = 'e2e/local/harness'
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

const tile = (page: Page) => page.getByRole('figure', { name: strings.screenShare.region('Bob') })
const controls = (page: Page) => page.getByRole('group', { name: strings.screenShare.viewControls })
const canvas = (page: Page) => page.getByRole('img', { name: strings.screenShare.annotationCanvas })

/** The tile with frames arriving, the pointer over it (the controls show) */
async function open(page: Page, query = '') {
  await page.goto(`${origin}/${query}`)
  await expect(controls(page)).toBeAttached()
  await tile(page).hover()
  await expect(controls(page)).toBeVisible()
}

/**
 * Where a content point should be on the page: the tile's box, the picture letterboxed in it, the
 * zoom and centre as asked. Written out again here rather than imported, on purpose.
 */
async function expectedAt(
  page: Page,
  point: { x: number; y: number },
  source: { width: number; height: number },
  view: { zoom: number; cx: number; cy: number } = { zoom: 1, cx: 0.5, cy: 0.5 },
) {
  const box = (await tile(page).boundingBox())!
  const scale = Math.min(box.width / source.width, box.height / source.height) * view.zoom
  return {
    x: box.x + box.width / 2 + (point.x - view.cx) * source.width * scale,
    y: box.y + box.height / 2 + (point.y - view.cy) * source.height * scale,
  }
}

/** The colour on screen at a page position, from a screenshot of that pixel */
async function pixel(page: Page, at: { x: number; y: number }) {
  const shot = await page.screenshot({
    clip: { x: Math.round(at.x), y: Math.round(at.y), width: 1, height: 1 },
  })
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const context = new OffscreenCanvas(1, 1).getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return { r, g, b }
  }, shot.toString('base64'))
}

const near = (
  actual: { r: number; g: number; b: number },
  wanted: { r: number; g: number; b: number },
  slack = 48,
) =>
  Math.abs(actual.r - wanted.r) <= slack &&
  Math.abs(actual.g - wanted.g) <= slack &&
  Math.abs(actual.b - wanted.b) <= slack

async function expectPixel(
  page: Page,
  at: { x: number; y: number },
  wanted: { r: number; g: number; b: number },
) {
  await expect.poll(async () => near(await pixel(page, at), wanted), { timeout: 5_000 }).toBe(true)
}

/** Press-drag-release in a few steps */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
}

const WIDE = { width: 1600, height: 900 }
const MARK = { x: 0.25, y: 0.25 }

test('the mark on the shared picture is where the mapping says, letterboxed and zoomed', async ({
  page,
}) => {
  // A tall viewport, a wide picture: bars above and below
  await page.setViewportSize({ width: 800, height: 900 })
  await open(page)
  await expectPixel(page, await expectedAt(page, MARK, WIDE), MARK_GREEN)
  // Off the picture: the tile's background, not the picture's
  const box = (await tile(page).boundingBox())!
  expect(near(await pixel(page, { x: box.x + 20, y: box.y + 200 }), { r: 0, g: 0, b: 60 }, 8)).toBe(
    false,
  )

  // + zooms in around the centre: 125%
  await controls(page).getByRole('button', { name: strings.screenShare.zoomIn }).click()
  await expect(tile(page)).toHaveAttribute('data-zoom', '1.25')
  await expectPixel(
    page,
    await expectedAt(page, MARK, WIDE, { zoom: 1.25, cx: 0.5, cy: 0.5 }),
    MARK_GREEN,
  )
  // Its button says the zoom and resets it
  await controls(page)
    .getByRole('button', { name: strings.screenShare.zoomReset(125) })
    .click()
  await expect(tile(page)).toHaveAttribute('data-zoom', '1')
})

test('wheel zoom holds the point under the pointer; dragging moves the picture', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await open(page)
  const under = await expectedAt(page, MARK, WIDE)
  await page.mouse.move(under.x, under.y)
  await page.mouse.wheel(0, -300)
  await expect
    .poll(async () => Number(await tile(page).getAttribute('data-zoom')))
    .toBeGreaterThan(1.5)
  // Still under the pointer
  await expectPixel(page, under, MARK_GREEN)

  // Dragging by 60 px carries the mark along
  const box = (await tile(page).boundingBox())!
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 + 100 }
  await page.mouse.move(under.x, under.y)
  await drag(page, start, { x: start.x + 60, y: start.y + 40 })
  await expectPixel(page, { x: under.x + 60, y: under.y + 40 }, MARK_GREEN)
})

test('the picker on the tile still gets its clicks, fitted and zoomed', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await open(page)
  const carol = tile(page)
    .getByRole('group', { name: strings.screenShare.picker })
    .getByRole('button', { name: strings.screenShare.label('Carol') })
  const picked = () => page.evaluate(() => (window as unknown as { picked: string[] }).picked)
  await carol.click()
  await expect.poll(picked).toEqual(['c'])
  await controls(page).getByRole('button', { name: strings.screenShare.zoomIn }).click()
  await expect(tile(page)).toHaveAttribute('data-zoom', '1.25')
  await carol.click()
  await expect.poll(picked).toEqual(['c', 'c'])
  // Double-clicking it is two picks, not fullscreen
  await carol.dblclick()
  await expect.poll(picked).toEqual(['c', 'c', 'c', 'c'])
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  // The controls' clicks too: the zoom went up and comes back
  await controls(page).getByRole('button', { name: strings.screenShare.zoomOut }).click()
  await expect(tile(page)).toHaveAttribute('data-zoom', '1')
})

test('the keyboard zooms, pans and resets with focus on the tile', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await open(page)
  await tile(page).focus()
  await page.keyboard.press('+')
  await expect(tile(page)).toHaveAttribute('data-zoom', '1.25')
  await page.keyboard.press('=')
  await expect(tile(page)).toHaveAttribute('data-zoom', '1.5625')
  const before = await page.locator('video').evaluate((video) => video.style.transform)
  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.style.transform))
    .not.toBe(before)
  await page.keyboard.press('0')
  await expect(tile(page)).toHaveAttribute('data-zoom', '1')
  await expect(page.locator('video')).toHaveJSProperty('style.transform', 'none')
})

test('zooming asks for more of the picture: the reported size follows', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await open(page)
  const reported = () =>
    page.evaluate(() =>
      (window as unknown as { shareDemand: () => { width: number } }).shareDemand(),
    )
  await expect.poll(async () => (await reported()).width).toBeGreaterThan(0)
  const fit = (await reported()).width
  await tile(page).focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('+')
  await expect.poll(async () => (await reported()).width).toBe(Math.round(fit * 1.953125))
})

test('a stroke loads the lazy chunk, lands on the picture, and stays on it through zoom and resize', async ({
  page,
}) => {
  // The canvas's chunk is its own file, fetched on the first press and not before
  const chunks = readdirSync(join(outDir, 'assets')).filter((file) =>
    file.startsWith('AnnotationCanvas'),
  )
  expect(chunks).toHaveLength(1)
  const fetched: string[] = []
  page.on('request', (request) => fetched.push(request.url()))

  await page.setViewportSize({ width: 1200, height: 800 })
  await open(page)
  expect(fetched.some((url) => url.includes('AnnotationCanvas'))).toBe(false)
  const pen = controls(page).getByRole('button', { name: strings.screenShare.annotate })
  await pen.click()
  await expect(pen).toHaveAttribute('aria-pressed', 'true')
  await expect(canvas(page)).toBeVisible()
  expect(fetched.some((url) => url.includes('AnnotationCanvas'))).toBe(true)

  // Across the picture, from the first mark's level, through content (0.25, 0.5)–(0.75, 0.5)
  const y = 0.5
  const from = await expectedAt(page, { x: 0.25, y }, WIDE)
  const to = await expectedAt(page, { x: 0.75, y }, WIDE)
  await drag(page, from, to)
  const expectStroke = async (view?: { zoom: number; cx: number; cy: number }) => {
    for (const x of [0.3, 0.5, 0.7]) {
      await expectPixel(page, await expectedAt(page, { x, y }, WIDE, view), ANNOTATION_RED)
    }
    await expectPixel(page, await expectedAt(page, { x: 0.5, y: 0.6 }, WIDE, view), {
      r: 0,
      g: 0,
      b: 60,
    })
  }
  await expectStroke()

  // A narrower window: bigger bars, the same place on the picture
  await page.setViewportSize({ width: 700, height: 800 })
  await expectStroke()
  // Wider than the picture's shape: bars at the sides
  await page.setViewportSize({ width: 1400, height: 500 })
  await expectStroke()

  // Zoomed in, around the centre: still on the same part of the picture
  await tile(page).focus()
  await page.keyboard.press('+')
  await expect(tile(page)).toHaveAttribute('data-zoom', '1.25')
  await expectStroke({ zoom: 1.25, cx: 0.5, cy: 0.5 })

  // Turning it off clears the sketch and gives the pointer back
  await tile(page).hover()
  await pen.click()
  await expect(canvas(page)).toHaveCount(0)
  await expectPixel(
    page,
    await expectedAt(page, { x: 0.5, y }, WIDE, { zoom: 1.25, cx: 0.5, cy: 0.5 }),
    { r: 0, g: 0, b: 60 },
  )
})

test('the overlay is sharp and lined up at a high pixel ratio', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: 2,
    locale: 'zh-TW',
  })
  const page = await context.newPage()
  await open(page)
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).click()
  await expect(canvas(page)).toBeVisible()
  const box = (await tile(page).boundingBox())!
  const backing = await canvas(page).evaluate((element: HTMLCanvasElement) => ({
    width: element.width,
    height: element.height,
  }))
  expect(backing).toEqual({ width: Math.round(box.width * 2), height: Math.round(box.height * 2) })
  const from = await expectedAt(page, { x: 0.25, y: 0.5 }, WIDE)
  const to = await expectedAt(page, { x: 0.75, y: 0.5 }, WIDE)
  await drag(page, from, to)
  await expectPixel(page, await expectedAt(page, { x: 0.5, y: 0.5 }, WIDE), ANNOTATION_RED)
  await context.close()
})

test('fullscreen fills the screen, keeps the overlay, and shows the recording notice', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await open(page)
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).click()
  await expect(canvas(page)).toBeVisible()
  await expect(page.getByText('Gene 正在錄影')).toHaveCount(0)
  await controls(page).getByRole('button', { name: strings.screenShare.fullscreen }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('FIGURE')
  await expect(page.getByText('Gene 正在錄影')).toBeVisible()
  await expect(canvas(page)).toBeVisible()
  const from = await expectedAt(page, { x: 0.25, y: 0.5 }, WIDE)
  const to = await expectedAt(page, { x: 0.75, y: 0.5 }, WIDE)
  await drag(page, from, to)
  await expectPixel(page, await expectedAt(page, { x: 0.5, y: 0.5 }, WIDE), ANNOTATION_RED)
  await controls(page).getByRole('button', { name: strings.screenShare.exitFullscreen }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull()
})

test('the tile and its controls have no axe violations', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await open(page)
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).click()
  await expect(canvas(page)).toBeVisible()
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    // The harness page itself has no landmarks or heading: the room does
    .disableRules(['region', 'landmark-one-main', 'page-has-heading-one'])
    .include('[data-share-tile]')
    .analyze()
  expect(results.violations).toEqual([])
})

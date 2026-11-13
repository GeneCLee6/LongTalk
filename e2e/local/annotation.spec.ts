import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
const BLUE = { r: 59, g: 130, b: 246 } // tokens.ts annotation.colors.blue
const BACKGROUND = { r: 0, g: 0, b: 60 } // the harness's picture

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
const toolbar = (page: Page) => page.getByRole('toolbar', { name: strings.annotation.toolbar })

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
    file.startsWith('AnnotationLayer'),
  )
  expect(chunks).toHaveLength(1)
  const fetched: string[] = []
  page.on('request', (request) => fetched.push(request.url()))

  await page.setViewportSize({ width: 1200, height: 800 })
  await open(page)
  expect(fetched.some((url) => url.includes('AnnotationLayer'))).toBe(false)
  const pen = controls(page).getByRole('button', { name: strings.screenShare.annotate })
  await pen.click()
  await expect(pen).toHaveAttribute('aria-pressed', 'true')
  await expect(canvas(page)).toBeVisible()
  expect(fetched.some((url) => url.includes('AnnotationLayer'))).toBe(true)

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

  // Turning it off puts the tools away; the mark stays, and the pointer is the tile's again
  await tile(page).hover()
  await pen.click()
  await expect(toolbar(page)).toHaveCount(0)
  await expectStroke({ zoom: 1.25, cx: 0.5, cy: 0.5 })
  const before = await page.locator('video').evaluate((video) => video.style.transform)
  const mid = await expectedAt(page, { x: 0.5, y: 0.8 }, WIDE, { zoom: 1.25, cx: 0.5, cy: 0.5 })
  await drag(page, mid, { x: mid.x, y: mid.y - 40 })
  await expect
    .poll(() => page.locator('video').evaluate((video) => video.style.transform))
    .not.toBe(before)
})

test('the tools on the picture: colour, undo, redo, clear, highlighter, rectangle, text', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await open(page)
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).click()
  await expect(toolbar(page)).toBeVisible()
  const tool = (name: string) => toolbar(page).getByRole('button', { name, exact: true })

  // A blue line
  await tool(strings.annotation.colors.blue).click()
  const y = 0.5
  await drag(
    page,
    await expectedAt(page, { x: 0.3, y }, WIDE),
    await expectedAt(page, { x: 0.7, y }, WIDE),
  )
  const middle = await expectedAt(page, { x: 0.5, y }, WIDE)
  await expectPixel(page, middle, BLUE)
  // Undo, redo, from the bar and from the keyboard
  await tool(strings.annotation.undo).click()
  await expectPixel(page, middle, BACKGROUND)
  await tool(strings.annotation.redo).click()
  await expectPixel(page, middle, BLUE)
  await page.keyboard.press('Control+z')
  await expectPixel(page, middle, BACKGROUND)
  await page.keyboard.press('Control+y')
  await expectPixel(page, middle, BLUE)

  // The eraser takes it
  await tool(strings.annotation.modes.eraser).click()
  await page.mouse.move(middle.x, middle.y)
  await page.mouse.down()
  await page.mouse.up()
  await expectPixel(page, middle, BACKGROUND)
  await page.keyboard.press('Control+z')
  await expectPixel(page, middle, BLUE)

  // A rectangle's outline: on it, and not inside it
  await tool(strings.annotation.modes.rect).click()
  await drag(
    page,
    await expectedAt(page, { x: 0.1, y: 0.6 }, WIDE),
    await expectedAt(page, { x: 0.3, y: 0.9 }, WIDE),
  )
  await expectPixel(page, await expectedAt(page, { x: 0.2, y: 0.6 }, WIDE), BLUE)
  await expectPixel(page, await expectedAt(page, { x: 0.2, y: 0.75 }, WIDE), BACKGROUND)

  // The highlighter lets the picture through
  await tool(strings.annotation.modes.highlighter).click()
  const mark = { x: 0.75, y: 0.75 }
  await drag(
    page,
    await expectedAt(page, { x: 0.65, y: mark.y }, WIDE),
    await expectedAt(page, { x: 0.85, y: mark.y }, WIDE),
  )
  await expect
    .poll(async () => {
      const { r, g, b } = await pixel(page, await expectedAt(page, mark, WIDE))
      // Green below, blue over it at 0.4: both still in there
      return g > 150 && b > 60 && r < 70
    })
    .toBe(true)

  // Text: a click, typing, Enter
  await tool(strings.annotation.modes.text).click()
  const place = await expectedAt(page, { x: 0.6, y: 0.1 }, WIDE)
  await page.mouse.click(place.x, place.y)
  const box = page.getByRole('textbox', { name: strings.annotation.textLabel })
  await expect(box).toBeFocused()
  await box.fill('WWWW')
  await page.keyboard.press('Enter')
  await expect(box).toHaveCount(0)
  // Its ink on the canvas, right where the click was
  const tileBox = (await tile(page).boundingBox())!
  await expect
    .poll(() =>
      canvas(page).evaluate(
        (element: HTMLCanvasElement, { x, y }) =>
          element
            .getContext('2d')!
            .getImageData(x, y, 80, 30)
            .data.some((value) => value !== 0),
        { x: Math.round(place.x - tileBox.x), y: Math.round(place.y - tileBox.y) },
      ),
    )
    .toBe(true)

  // Enter kept that one exactly once (taking the box away also blurs it), and Esc keeps nothing
  const adds = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            annotateFrames: { ops: { op: string; stroke?: { tool: string } }[] }[]
          }
        ).annotateFrames
          .flatMap((frame) => frame.ops)
          .filter((op) => op.op === 'add' && op.stroke?.tool === 'text').length,
    )
  await expect.poll(adds).toBe(1)
  await page.mouse.click(place.x, place.y + 40)
  await box.fill('no')
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(await adds()).toBe(1)

  // What went out: frames in the shape the room takes, ending in the text mark
  const frames = await page.evaluate(
    () => (window as unknown as { annotateFrames: { t: string; share: string }[] }).annotateFrames,
  )
  expect(frames.length).toBeGreaterThan(5)
  expect(frames.every((frame) => frame.t === 'annotate' && frame.share === 'b')).toBe(true)

  // Clear takes all of ours, and the line again
  await tool(strings.annotation.clear).click()
  await expectPixel(page, middle, BACKGROUND)
  await expect(tool(strings.annotation.undo)).toBeDisabled()
})

test('the laser pointer shows, leaves nothing, and fades within three seconds', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await open(page)
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).click()
  await toolbar(page)
    .getByRole('button', { name: strings.annotation.modes.laser, exact: true })
    .click()
  const at = await expectedAt(page, { x: 0.5, y: 0.5 }, WIDE)
  await page.mouse.move(at.x, at.y)
  await expectPixel(page, at, ANNOTATION_RED)
  const started = Date.now()
  await expect.poll(async () => near(await pixel(page, at), BACKGROUND, 8), { timeout: 6_000 }).toBe(true)
  expect(Date.now() - started).toBeLessThan(4_500)
})

test('the toolbar works in fullscreen, and by keyboard alone', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await open(page)
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).click()
  await expect(toolbar(page)).toBeVisible()
  await controls(page).getByRole('button', { name: strings.screenShare.fullscreen }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('FIGURE')
  await expect(toolbar(page)).toBeVisible()

  // Tab to the text tool: its box opens in the middle, typing and Enter make a mark
  const text = toolbar(page).getByRole('button', { name: strings.annotation.modes.text, exact: true })
  await text.focus()
  await page.keyboard.press('Enter')
  const box = page.getByRole('textbox', { name: strings.annotation.textLabel })
  await expect(box).toBeFocused()
  await page.keyboard.type('OK')
  await page.keyboard.press('Enter')
  await expect(box).toHaveCount(0)
  // Undo from the bar, by keyboard too: the arrow keys and Enter
  const undo = toolbar(page).getByRole('button', { name: strings.annotation.undo })
  await expect(undo).toBeEnabled()
  await undo.focus()
  await page.keyboard.press('Enter')
  await expect(undo).toBeDisabled()
  // Folded and back
  const fold = toolbar(page).getByRole('button', { name: strings.annotation.fold })
  await fold.focus()
  await page.keyboard.press('Enter')
  await expect(text).toHaveCount(0)
  await toolbar(page).getByRole('button', { name: strings.annotation.unfold }).click()
  await expect(text).toBeVisible()
  await controls(page).getByRole('button', { name: strings.screenShare.exitFullscreen }).click()
})

test('on a phone-sized tile the toolbar stays inside it, and its parts are big enough', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 500 },
    hasTouch: true,
    isMobile: true,
    locale: 'zh-TW',
  })
  const page = await context.newPage()
  await page.goto(`${origin}/`)
  await expect(controls(page)).toBeAttached()
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).tap()
  await expect(toolbar(page)).toBeVisible()
  const bar = (await toolbar(page).boundingBox())!
  const frame = (await tile(page).boundingBox())!
  expect(bar.x).toBeGreaterThanOrEqual(frame.x)
  expect(bar.x + bar.width).toBeLessThanOrEqual(frame.x + frame.width)
  const pen = (await toolbar(page)
    .getByRole('button', { name: strings.annotation.modes.pen, exact: true })
    .boundingBox())!
  expect(Math.round(pen.width)).toBeGreaterThanOrEqual(44)
  // Colours are behind one button here
  await toolbar(page).getByRole('button', { name: strings.annotation.style }).tap()
  await expect(
    toolbar(page).getByRole('button', { name: strings.annotation.colors.teal, exact: true }),
  ).toBeVisible()
  // It folds out of the way
  await toolbar(page).getByRole('button', { name: strings.annotation.fold }).tap()
  const folded = (await toolbar(page).boundingBox())!
  expect(folded.height).toBeLessThan(bar.height + 1)
  await context.close()
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

test('exporting a share: the frame and the marks, in a real PNG and a real PDF (AC-7.5)', async ({
  page,
}) => {
  await open(page, '?w=1600&h=900')
  // A stroke along the top: the tools out, then a line
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).click()
  await expect(canvas(page)).toBeVisible()
  const from = await expectedAt(page, { x: 0.4, y: 0.5 }, { width: 1600, height: 900 })
  const to = await expectedAt(page, { x: 0.6, y: 0.5 }, { width: 1600, height: 900 })
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
  // Zoomed in: the file still has the whole picture
  await tile(page).focus()
  await page.keyboard.press('+')

  const save = async (choice: string) => {
    await controls(page).getByRole('button', { name: strings.annotation.exportButton }).click()
    const dialog = page.getByRole('dialog', { name: strings.annotation.exporting.shareTitle })
    await expect(dialog).toBeVisible()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: choice }).click(),
    ])
    await expect(dialog).toBeHidden()
    return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) }
  }

  const png = await save(strings.annotation.exporting.framePng)
  expect(png.name).toContain('週會')
  expect(png.name).toMatch(/\d{4}-\d{2}-\d{2} \d{2}-\d{2}\.png$/)
  expect([...png.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect([png.bytes.readUInt32BE(16), png.bytes.readUInt32BE(20)]).toEqual([1600, 900])
  // Decoded by the browser, as anything opening it would: the picture's square and the line
  const colours = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const at = (x: number, y: number) => {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data
      return { r, g, b }
    }
    return { square: at(400, 225), line: at(800, 450), plain: at(800, 200) }
  }, png.bytes.toString('base64'))
  expect(near(colours.square, MARK_GREEN)).toBe(true)
  expect(colours.line.r).toBeGreaterThan(colours.line.g)
  expect(near(colours.plain, BACKGROUND)).toBe(true)

  const pdf = await save(strings.annotation.exporting.framePdf)
  expect(pdf.name).toMatch(/\.pdf$/)
  const text = pdf.bytes.toString('latin1')
  expect(text.startsWith('%PDF-1.4\n')).toBe(true)
  expect(text.endsWith('%%EOF\n')).toBe(true)
  expect(text).toContain('/Count 1')
  expect(text).toContain('/Width 1600 /Height 900')
  const xref = Number(/startxref\n(\d+)\n/.exec(text)![1])
  expect(text.slice(xref, xref + 5)).toBe('xref\n')
})

test('the tile and its controls have no axe violations', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await open(page)
  await controls(page).getByRole('button', { name: strings.screenShare.annotate }).click()
  await expect(canvas(page)).toBeVisible()
  await expect(toolbar(page)).toBeVisible()
  // The text box and the compact toolbar's colours are checked too
  await toolbar(page)
    .getByRole('button', { name: strings.annotation.modes.text, exact: true })
    .focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: strings.annotation.textLabel })).toBeVisible()
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    // The harness page itself has no landmarks or heading: the room does
    .disableRules(['region', 'landmark-one-main', 'page-has-heading-one'])
    .include('[data-share-tile]')
    .analyze()
  expect(results.violations).toEqual([])
})

// The sharer's own share (J3): the real tile, a real <video> of the local capture. What a viewer's
// stroke looks like there, through the real room, is in e2e/annotation.spec.ts.
test.describe("the sharer's own view", () => {
  const ownTile = (page: Page) => page.getByRole('figure', { name: strings.screenShare.ownRegion })
  const ownVideo = (page: Page) => ownTile(page).locator('video')

  const ownCanvas = (page: Page) =>
    ownTile(page).getByRole('img', { name: strings.screenShare.annotationCanvas })

  test('a window: the picture and the marks, and the limit said in words', async ({ page }) => {
    await page.goto(`${origin}/?own=window`)
    await expect(ownTile(page)).toBeVisible()
    await expect(ownTile(page).getByText(strings.screenShare.ownLimit)).toBeVisible()
    await expect(ownVideo(page)).toBeVisible()
    await expect
      .poll(() => ownVideo(page).evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0)
    // Nothing to choose: no mirror to fear
    await expect(ownTile(page).getByRole('button', { name: strings.screenShare.ownShowPicture })).toHaveCount(0)
    const axe = await new AxeBuilder({ page }).include('figure').analyze()
    expect(axe.violations.map((v) => v.id)).toEqual([])
  })

  test('a whole screen: no picture until asked, the marks all the same', async ({ page }) => {
    await page.goto(`${origin}/?own=screen`)
    await expect(ownTile(page)).toBeVisible()
    // Playing, so the marks know the picture's shape, and never painted
    await expect
      .poll(() => ownVideo(page).evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0)
    await expect(ownVideo(page)).toBeHidden()
    await expect(ownTile(page).getByText(strings.screenShare.ownHidden)).toBeVisible()
    const axe = await new AxeBuilder({ page }).include('figure').analyze()
    expect(axe.violations.map((v) => v.id)).toEqual([])

    // The sharer can draw here too
    await ownTile(page).hover()
    await ownTile(page).getByRole('button', { name: strings.screenShare.annotate, exact: true }).click()
    await expect(toolbar(page)).toBeVisible()
    const box = (await ownTile(page).boundingBox())!
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { annotateFrames: unknown[] }).annotateFrames.length))
      .toBeGreaterThan(0)
    const painted = await ownCanvas(page).evaluate((element: HTMLCanvasElement) => {
      const { width, height } = element
      const data = element.getContext('2d')!.getImageData(0, Math.round(height * 0.6) - 3, width, 7).data
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
      return false
    })
    expect(painted).toBe(true)

    // Showing the picture is the sharer's call (a second screen has no mirror)
    await ownTile(page).getByRole('button', { name: strings.screenShare.ownShowPicture }).click()
    await expect(ownVideo(page)).toBeVisible()
    await expect(ownTile(page).getByText(strings.screenShare.ownHidden)).toHaveCount(0)
  })
})

// The sharer's floating window (Document Picture-in-Picture): the sharing bar's real button opens
// a real window in Chromium, which Playwright sees as a page of its own. Someone else's stroke
// reaches it and lands where it belongs on the picture; with a whole screen shared it starts with
// the marks only (the window is in the share too).
test.describe("the sharer's floating window", () => {
  const openPip = async (page: Page) => {
    const bar = page.getByRole('region', { name: strings.screenShare.youAreSharing })
    const [pip] = await Promise.all([
      page.context().waitForEvent('page'),
      bar.getByRole('button', { name: strings.screenShare.pipOpen }).click(),
    ])
    return { bar, pip }
  }
  const view = (pip: Page) => pip.getByRole('figure', { name: strings.screenShare.ownRegion })
  /** Whether the middle row of the window's marks has the annotation red in it */
  const redAcrossMiddle = (pip: Page) =>
    view(pip)
      .getByRole('img', { name: strings.screenShare.annotationCanvas })
      .evaluate((element: HTMLCanvasElement, red) => {
        const { width, height } = element
        const data = element.getContext('2d')!.getImageData(0, Math.round(height / 2) - 2, width, 5).data
        let hits = 0
        for (let i = 0; i < data.length; i += 4) {
          const near = Math.abs(data[i] - red.r) < 40 && Math.abs(data[i + 1] - red.g) < 40
          if (data[i + 3] > 200 && near) hits++
        }
        return hits
      }, ANNOTATION_RED)

  test("a window: the picture, and Bob's stroke as it arrives", async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Document Picture-in-Picture is Chrome and Edge only')
    await page.goto(`${origin}/?pip=window`)
    const { bar, pip } = await openPip(page)
    await expect(view(pip)).toBeVisible()
    await expect(view(pip).getByText(strings.screenShare.pipEmpty)).toBeVisible()
    await expect
      .poll(() => view(pip).locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0)
    await expect(view(pip).locator('video')).toBeVisible()
    await expect(bar.getByRole('button', { name: strings.screenShare.pipClose })).toBeVisible()

    await page.evaluate(() =>
      (window as unknown as { drawOnShare: (id: string) => void }).drawOnShare('b1'),
    )
    await expect(view(pip).getByText(strings.screenShare.pipEmpty)).toHaveCount(0)
    await expect.poll(() => redAcrossMiddle(pip)).toBeGreaterThan(50)

    // Closed from the bar, the window goes
    const closed = pip.waitForEvent('close')
    await bar.getByRole('button', { name: strings.screenShare.pipClose }).click()
    await closed
    await expect(bar.getByRole('button', { name: strings.screenShare.pipOpen })).toBeVisible()
  })

  test('a whole screen: the marks only, until the picture is asked for', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Document Picture-in-Picture is Chrome and Edge only')
    await page.goto(`${origin}/?pip=screen`)
    await page.evaluate(() =>
      (window as unknown as { drawOnShare: (id: string) => void }).drawOnShare('b1'),
    )
    const { pip } = await openPip(page)
    await expect(view(pip).getByText(strings.screenShare.ownHidden)).toBeVisible()
    await expect
      .poll(() => view(pip).locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0)
    await expect(view(pip).locator('video')).toBeHidden()
    await expect.poll(() => redAcrossMiddle(pip)).toBeGreaterThan(50)
    await view(pip).getByRole('button', { name: strings.screenShare.ownShowPicture }).click()
    await expect(view(pip).locator('video')).toBeVisible()
  })
})

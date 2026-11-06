import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
// The browsers run in zh-TW (playwright.config.ts): the Chinese dictionary
import { zhTW as strings } from '../src/i18n/zh-TW.ts'

// J4 (e7-t07, e7-t08, e7-t09; AC-7.4, AC-7.5) on the deployed Worker, with real R2 behind it: a
// persistent room's whiteboard outlives its meeting and goes with the room; exports are valid files,
// read back here byte by byte; a phone-sized browser draws and pinches with touch events (a real
// finger is DEPLOY.md §5 step 32). Every preview shares one D1 and one bucket: the slug is unique
// per run and the account deletes itself.

const OWNER = `Board ${Date.now() % 100_000}`
const SLUG = `e2e-b-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
const ROOM_NAME = 'J4 白板房'

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

const toolbarButton = (page: Page, name: string) =>
  page.getByRole('toolbar', { name: strings.devices.controls }).getByRole('button', { name, exact: true })

const board = (page: Page) => page.getByRole('figure', { name: strings.whiteboard.region })
const canvas = (page: Page) =>
  board(page).getByRole('img', { name: strings.screenShare.annotationCanvas })

async function joinFromPreJoin(page: Page) {
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
}

async function openBoard(page: Page) {
  await toolbarButton(page, strings.toolbar.more).click()
  await page.getByRole('menuitem', { name: strings.whiteboard.open, exact: true }).click()
  await expect(canvas(page)).toBeVisible()
}

/** Alone in the room, so the leave button would only leave: the participants panel ends it */
async function endMeeting(page: Page) {
  await toolbarButton(page, strings.toolbar.participantsCount(1)).click()
  await page
    .getByRole('complementary', { name: strings.participants.title })
    .getByRole('button', { name: strings.participants.endMeeting })
    .click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: strings.participants.endConfirm })
    .click()
  await expect(page.getByRole('heading', { name: strings.left.endedSelfTitle })).toBeVisible()
}

/** Whether the canvas has anything painted around a point given in fractions of the board's size */
const paintedAt = (page: Page, fx: number, fy: number) =>
  canvas(page).evaluate(
    (element: HTMLCanvasElement, { fx, fy }) => {
      const x = Math.round(element.width * fx)
      const y = Math.round(element.height * fy)
      const { data } = element.getContext('2d')!.getImageData(x - 3, y - 3, 7, 7)
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
      return false
    },
    { fx, fy },
  )

async function drawAcross(page: Page, fy: number) {
  const box = (await board(page).boundingBox())!
  const y = box.y + box.height * fy
  await page.mouse.move(box.x + box.width * 0.3, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 10 })
  await page.mouse.up()
}

/** Clicks an export choice and gives the file that comes down */
async function exportFile(page: Page, choice: string) {
  await board(page).getByRole('button', { name: strings.annotation.exportButton }).click()
  const dialog = page.getByRole('dialog', { name: strings.annotation.exporting.boardTitle })
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: choice }).click(),
  ])
  await expect(dialog).toBeHidden()
  return {
    name: download.suggestedFilename(),
    bytes: new Uint8Array(readFileSync(await download.path())),
  }
}

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('')

/** A PNG's signature, IHDR and size, as anything opening it would read them */
function pngSize(bytes: Uint8Array) {
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(latin1(bytes.slice(12, 16))).toBe('IHDR')
  expect(latin1(bytes.slice(-8, -4))).toBe('IEND')
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** The JPEG inside a PDF's image object, and the size it says it has */
function jpegSize(bytes: Uint8Array) {
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8])
  let at = 2
  while (at < bytes.length) {
    const marker = bytes[at + 1]
    const length = (bytes[at + 2] << 8) | bytes[at + 3]
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] }
    }
    at += 2 + length
  }
  throw new Error('no size in the JPEG')
}

function checkPdf(bytes: Uint8Array) {
  const text = latin1(bytes)
  expect(text.startsWith('%PDF-1.4\n')).toBe(true)
  expect(text.endsWith('%%EOF\n')).toBe(true)
  const xref = Number(/startxref\n(\d+)\n/.exec(text)![1])
  expect(text.slice(xref, xref + 5)).toBe('xref\n')
  const images = [
    ...text.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)[^>]*\/Length (\d+) >>\nstream\n/g),
  ]
  expect(images.length).toBeGreaterThan(0)
  for (const match of images) {
    const start = match.index + match[0].length
    const jpeg = bytes.slice(start, start + Number(match[3]))
    expect(jpegSize(jpeg)).toEqual({ width: Number(match[1]), height: Number(match[2]) })
  }
  return { pages: Number(/\/Count (\d+)/.exec(text)![1]) }
}

/** Touches through the browser's own input pipeline, so they become real touch pointer events */
async function touchscreen(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  const send = (type: string, points: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: type as 'touchStart',
      touchPoints: points.map(({ x, y }, id) => ({ x, y, id })),
    })
  return send
}

async function phonePage(browser: Browser) {
  const context = await browser.newContext({
    locale: 'zh-TW',
    permissions: ['camera', 'microphone'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()
  return { context, page }
}

/**
 * One finger draws, two zoom and leave no mark, the page does not move. In the room the test already
 * has: the runner's network has used up its rooms by now (I1's limit), and the board is open and empty
 */
async function phoneOnTheBoard(browser: Browser, path: string) {
  const { context, page } = await phonePage(browser)
  await page.goto(path)
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Phone')
  await joinFromPreJoin(page)
  await expect(canvas(page)).toBeVisible()
  // The stage eases into its layout as a member arrives: a finger aimed before that lands elsewhere
  let last = ''
  await expect
    .poll(async () => {
      const now = JSON.stringify(await board(page).boundingBox())
      const settled = now === last
      last = now
      return settled
    })
    .toBe(true)
  const touch = await touchscreen(context, page)
  const box = (await board(page).boundingBox())!
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })

  // The tools fit: one row, every one within the screen by sliding
  const tools = page.getByRole('toolbar', { name: strings.annotation.toolbar })
  const row = (await tools.boundingBox())!
  expect(row.height).toBeLessThan(90)
  expect(row.x).toBeGreaterThanOrEqual(0)
  expect(row.x + row.width).toBeLessThanOrEqual(390)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  // One finger draws
  await touch('touchStart', [at(0.3, 0.35)])
  for (let i = 1; i <= 8; i += 1) await touch('touchMove', [at(0.3 + i * 0.05, 0.35)])
  await touch('touchEnd', [])
  await expect.poll(() => paintedAt(page, 0.5, 0.35)).toBe(true)
  await expect(board(page)).toHaveAttribute('data-zoom', '1')

  // Two fingers zoom, without a mark and without moving the page
  await touch('touchStart', [at(0.4, 0.6)])
  await touch('touchStart', [at(0.4, 0.6), at(0.6, 0.6)])
  for (let i = 1; i <= 6; i += 1) {
    await touch('touchMove', [at(0.4 - i * 0.03, 0.6), at(0.6 + i * 0.03, 0.6)])
  }
  await touch('touchEnd', [])
  await expect
    .poll(async () => Number(await board(page).getAttribute('data-zoom')))
    .toBeGreaterThan(1.2)
  const moved = await page.evaluate(() => ({
    scroll: window.scrollY,
    scale: window.visualViewport?.scale ?? 1,
  }))
  expect(moved).toEqual({ scroll: 0, scale: 1 })
  expect(await paintedAt(page, 0.5, 0.6)).toBe(false)

  await page.getByRole('button', { name: strings.toolbar.leave, exact: true }).click()
  await context.close()
}

test('a persistent room\'s board: draw, export, end, come back, it is there, delete', async ({ browser }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext({
    locale: 'zh-TW',
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  await virtualAuthenticator(page)

  await test.step('an account and a persistent room', async () => {
    await page.goto('/me')
    await page.getByRole('textbox', { name: strings.account.nameLabel }).fill(OWNER)
    await page.getByRole('button', { name: strings.account.signUp }).click()
    await expect(page.getByText(strings.account.signedInAs(OWNER))).toBeVisible()
    await page.getByRole('textbox', { name: strings.account.slugLabel }).fill(SLUG)
    await page.getByRole('textbox', { name: strings.account.roomNameLabel }).fill(ROOM_NAME)
    await page.getByRole('button', { name: strings.account.createRoom }).click()
    await expect(page.getByRole('button', { name: strings.account.editRoomLabel(SLUG) })).toBeVisible()
  })

  await test.step('draw on the whiteboard', async () => {
    await page.goto(`/r/${SLUG}`)
    await joinFromPreJoin(page)
    await openBoard(page)
    await drawAcross(page, 0.5)
    await expect.poll(() => paintedAt(page, 0.5, 0.5)).toBe(true)
  })

  await test.step('export: PNGs with the right size, a valid PDF, names with the room and date', async () => {
    const today = /\d{4}-\d{2}-\d{2} \d{2}-\d{2}/
    const box = (await board(page).boundingBox())!
    const view = await exportFile(page, strings.annotation.exporting.viewPng)
    expect(view.name).toContain(ROOM_NAME)
    expect(view.name).toMatch(today)
    expect(view.name).toMatch(/\.png$/)
    expect(pngSize(view.bytes)).toEqual({
      width: Math.round(box.width),
      height: Math.round(box.height),
    })
    const whole = await exportFile(page, strings.annotation.exporting.wholePng)
    const size = pngSize(whole.bytes)
    // About the line and its margin: 40% of the board's width, not the board
    expect(size.width).toBeLessThan(box.width * 0.6)
    expect(size.height).toBeLessThan(box.height * 0.3)
    const pdf = await exportFile(page, strings.annotation.exporting.wholePdf)
    expect(pdf.name).toContain(ROOM_NAME)
    expect(pdf.name).toMatch(/\.pdf$/)
    expect(checkPdf(pdf.bytes).pages).toBe(1)
  })

  await test.step('end the meeting, come back: it is there', async () => {
    await endMeeting(page)
    await page.goto(`/r/${SLUG}`)
    await joinFromPreJoin(page)
    await openBoard(page)
    await expect.poll(() => paintedAt(page, 0.5, 0.5), { timeout: 15_000 }).toBe(true)
    // Nothing was added where nothing was drawn
    expect(await paintedAt(page, 0.5, 0.25)).toBe(false)
  })

  await test.step('clearing it clears the next meeting too', async () => {
    await board(page).getByRole('button', { name: strings.annotation.clearOthers }).click()
    await page
      .getByRole('dialog', { name: strings.annotation.clearOthers })
      .getByRole('button', { name: strings.annotation.clearAll(1) })
      .click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: strings.annotation.clearConfirm })
      .click()
    await expect.poll(() => paintedAt(page, 0.5, 0.5)).toBe(false)
    await endMeeting(page)
    await page.goto(`/r/${SLUG}`)
    await joinFromPreJoin(page)
    await openBoard(page)
    await page.waitForTimeout(1_000)
    expect(await paintedAt(page, 0.5, 0.5)).toBe(false)
  })

  await test.step('a phone-sized browser draws and pinches with touch', () =>
    phoneOnTheBoard(browser, `/r/${SLUG}`),
  )

  await test.step('the room and the account go, the board with them', async () => {
    await endMeeting(page)
    await page.goto('/me')
    await page.getByRole('button', { name: strings.account.deleteAccount }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: strings.account.deleteAccount }).click()
    await expect(page.getByRole('button', { name: strings.account.signUp })).toBeVisible()
    expect((await page.request.get(`/api/rooms/${SLUG}`)).status()).toBe(404)
  })
  await context.close()
})

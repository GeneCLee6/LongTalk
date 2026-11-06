import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { zhTW as strings } from '../src/i18n/zh-TW.ts'

// J2 (e7-t03, e7-t04; AC-7.1, AC-7.2) on the deployed Worker, through the real RoomDO and the real
// Realtime SFU: Alice shares, Bob draws, Carol sees it live and lined up on the picture whatever her
// tile's size, Dave joins late and gets the replay, the share stops and the strokes are gone. Every
// position is worked out here from the tile's box and the picture's shape, independently of
// shared/shareGeometry.ts, and read back from the canvas's real pixels.

/** The stand-in screen's shape (below) */
const SOURCE = { width: 1280, height: 720 }

interface Member {
  name: string
  context: BrowserContext
  page: Page
}

async function openRoom(browser: Browser): Promise<string> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/')
  await page.getByRole('button', { name: strings.home.createRoom }).click()
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{10}$/)
  const url = page.url()
  await context.close()
  return url
}

async function join(browser: Browser, roomUrl: string, name: string): Promise<Member> {
  const context = await browser.newContext({
    locale: 'zh-TW',
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 800 },
  })
  await context.addInitScript(
    ({ width, height }) => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const paint = canvas.getContext('2d')!
        let frame = 0
        const draw = () => {
          frame += 1
          paint.fillStyle = '#ffffff'
          paint.fillRect(0, 0, width, height)
          paint.fillStyle = '#0e7490'
          paint.fillRect((frame * 8) % width, 200, 160, 160)
        }
        draw()
        setInterval(draw, 1000 / 15)
        return canvas.captureStream(15)
      }
    },
    SOURCE,
  )
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[${name}] ${message.text().slice(0, 300)}`)
  })
  await page.goto(roomUrl)
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill(name)
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  return { name, context, page }
}

const toolbarButton = (member: Member, name: string) =>
  member.page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name, exact: true })

const shareTile = (viewer: Member, sharer: Member) =>
  viewer.page.getByRole('figure', { name: strings.screenShare.region(sharer.name) })

const marks = (viewer: Member, sharer: Member) =>
  shareTile(viewer, sharer).getByRole('img', { name: strings.screenShare.annotationCanvas })

/** Where a content point is, CSS px from the tile's corner: the picture letterboxed in the tile */
function contentToTile(box: { width: number; height: number }, x: number, y: number) {
  const scale = Math.min(box.width / SOURCE.width, box.height / SOURCE.height)
  return {
    x: box.width / 2 + (x - 0.5) * SOURCE.width * scale,
    y: box.height / 2 + (y - 0.5) * SOURCE.height * scale,
  }
}

async function contentToPage(viewer: Member, sharer: Member, x: number, y: number) {
  const box = (await shareTile(viewer, sharer).boundingBox())!
  const at = contentToTile(box, x, y)
  return { x: box.x + at.x, y: box.y + at.y }
}

/** Whether the viewer's canvas has anything painted at this content point */
async function paintedAt(viewer: Member, sharer: Member, x: number, y: number): Promise<boolean> {
  const canvas = marks(viewer, sharer)
  if ((await canvas.count()) === 0) return false
  const box = (await shareTile(viewer, sharer).boundingBox())!
  const at = contentToTile(box, x, y)
  return canvas.evaluate(
    (element: HTMLCanvasElement, { px, py, width }) => {
      const ratio = element.width / width
      const data = element
        .getContext('2d')!
        .getImageData(Math.round(px * ratio) - 2, Math.round(py * ratio) - 2, 5, 5).data
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
      return false
    },
    { px: at.x, py: at.y, width: box.width },
  )
}

const LINE_Y = 0.5

/** The tile as the viewer has it now: the pen's line there, and nothing just above or below it */
async function expectLine(viewer: Member, sharer: Member) {
  for (const x of [0.3, 0.5, 0.7]) {
    await expect.poll(() => paintedAt(viewer, sharer, x, LINE_Y)).toBe(true)
  }
  expect(await paintedAt(viewer, sharer, 0.5, LINE_Y + 0.1)).toBe(false)
  expect(await paintedAt(viewer, sharer, 0.5, LINE_Y - 0.1)).toBe(false)
  // Not on the letterbox bars, and not past the line's ends
  expect(await paintedAt(viewer, sharer, 0.05, LINE_Y)).toBe(false)
  expect(await paintedAt(viewer, sharer, 0.95, LINE_Y)).toBe(false)
}

test.describe.configure({ retries: 1 })

test('Alice shares, Bob draws, Carol sees it, Dave replays it, the share stops and it clears', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000)
  const url = await openRoom(browser)
  const alice = await join(browser, url, 'Alice')
  const bob = await join(browser, url, 'Bob')
  const carol = await join(browser, url, 'Carol')

  await test.step('Alice shares; Bob and Carol see the picture', async () => {
    await toolbarButton(alice, strings.toolbar.share).click()
    for (const viewer of [bob, carol]) {
      await expect
        .poll(
          () =>
            shareTile(viewer, alice)
              .locator('video')
              .evaluate((video: HTMLVideoElement) => video.videoWidth),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(0)
    }
  })

  const tools = bob.page.getByRole('toolbar', { name: strings.annotation.toolbar })

  await test.step('Bob brings out the tools; Carol has no canvas until there is a mark', async () => {
    await shareTile(bob, alice).hover()
    await shareTile(bob, alice).getByRole('button', { name: strings.screenShare.annotate }).click()
    await expect(tools).toBeVisible()
    await expect(marks(carol, alice)).toHaveCount(0)
  })

  await test.step('Bob draws a line; Carol sees it where it belongs, whatever her tile', async () => {
    const from = await contentToPage(bob, alice, 0.2, LINE_Y)
    const to = await contentToPage(bob, alice, 0.8, LINE_Y)
    await bob.page.mouse.move(from.x, from.y)
    await bob.page.mouse.down()
    await bob.page.mouse.move(to.x, to.y, { steps: 12 })
    await bob.page.mouse.up()
    await expectLine(carol, alice)
    // A different shape and size of tile: narrow, then wide and short (other letterbox bars)
    await carol.page.setViewportSize({ width: 760, height: 900 })
    await expectLine(carol, alice)
    await carol.page.setViewportSize({ width: 1500, height: 560 })
    await expectLine(carol, alice)
    await carol.page.setViewportSize({ width: 1280, height: 800 })
    await expectLine(carol, alice)
  })

  await test.step('how long a point takes from Bob to Carol (AC-7.2: < 300 ms)', async () => {
    // Same machine, same clock: Bob notes when each pointer position happens, Carol's page looks
    // for it on her canvas every frame
    const steps = Array.from({ length: 16 }, (_, i) => 0.2 + (i * 0.6) / 15)
    const y = 0.3
    const box = (await shareTile(carol, alice).boundingBox())!
    await marks(carol, alice).evaluate(
      (element: HTMLCanvasElement, targets) => {
        const seen: (number | null)[] = targets.map(() => null)
        const paint = element.getContext('2d')!
        const look = () => {
          targets.forEach((target, index) => {
            if (seen[index] !== null) return
            const data = paint.getImageData(target.x - 2, target.y - 2, 5, 5).data
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] > 0) {
                seen[index] = Date.now()
                return
              }
            }
          })
          requestAnimationFrame(look)
        }
        look()
        ;(window as unknown as { seenAt: (number | null)[] }).seenAt = seen
      },
      // A pixel ratio of 1 in these contexts: tile px are canvas pixels
      steps.map((x) => {
        const at = contentToTile(box, x, y)
        return { x: Math.round(at.x), y: Math.round(at.y) }
      }),
    )
    const sent: number[] = []
    const first = await contentToPage(bob, alice, steps[0], y)
    await bob.page.mouse.move(first.x, first.y)
    await bob.page.mouse.down()
    for (const x of steps) {
      const at = await contentToPage(bob, alice, x, y)
      // Right before and after the move: the middle is when the page got it, within a few ms
      const before = Date.now()
      await bob.page.mouse.move(at.x, at.y)
      sent.push((before + Date.now()) / 2)
      await bob.page.waitForTimeout(150)
    }
    await bob.page.mouse.up()
    await carol.page.waitForTimeout(1000)
    const seen = await carol.page.evaluate(
      () => (window as unknown as { seenAt: (number | null)[] }).seenAt,
    )
    const latencies = seen
      .map((at, index) => (at === null ? null : at - sent[index]))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)
    const report = {
      points: steps.length,
      seen: latencies.length,
      p50: latencies[Math.floor(latencies.length / 2)],
      p90: latencies[Math.floor(latencies.length * 0.9)],
      max: latencies.at(-1),
    }
    console.log(`[annotation latency, ms] ${JSON.stringify(report)}`)
    testInfo.annotations.push({ type: 'stroke latency', description: JSON.stringify(report) })
    expect(latencies.length).toBe(steps.length)
    expect(report.p50).toBeLessThan(300)
    // The test line goes again, so the rest of the test sees only the first
    await bob.page.keyboard.press('Control+z')
    await expect.poll(() => paintedAt(carol, alice, 0.5, 0.3)).toBe(false)
  })

  await test.step('undo and redo reach Carol; the other tools too', async () => {
    await tools.getByRole('button', { name: strings.annotation.undo }).click()
    await expect.poll(() => paintedAt(carol, alice, 0.5, LINE_Y)).toBe(false)
    await tools.getByRole('button', { name: strings.annotation.redo }).click()
    await expectLine(carol, alice)
  })

  await test.step('the laser pointer shows on Carol\'s tile and fades away', async () => {
    await tools.getByRole('button', { name: strings.annotation.modes.laser }).click()
    const at = await contentToPage(bob, alice, 0.5, 0.2)
    await bob.page.mouse.move(at.x, at.y)
    await bob.page.mouse.move(at.x + 1, at.y)
    await expect.poll(() => paintedAt(carol, alice, 0.5, 0.2)).toBe(true)
    await expect.poll(() => paintedAt(carol, alice, 0.5, 0.2), { timeout: 6_000 }).toBe(false)
    await tools.getByRole('button', { name: strings.annotation.modes.pen }).click()
  })

  const dave = await test.step('Dave joins late and gets the replay', async () => {
    const late = await join(browser, url, 'Dave')
    await expect(marks(late, alice)).toBeVisible({ timeout: 60_000 })
    await expectLine(late, alice)
    return late
  })

  await test.step('Carol reloads: the same member, the same strokes (a reconnect)', async () => {
    await carol.page.reload()
    await expect(marks(carol, alice)).toBeVisible({ timeout: 60_000 })
    await expectLine(carol, alice)
  })

  await test.step('Alice stops sharing: the strokes are gone for everyone', async () => {
    await alice.page
      .getByRole('region', { name: strings.screenShare.youAreSharing })
      .getByRole('button', { name: strings.screenShare.stop })
      .click()
    for (const viewer of [bob, carol, dave]) {
      await expect(shareTile(viewer, alice)).toHaveCount(0)
    }
    // And they do not come back with the next share
    await toolbarButton(alice, strings.toolbar.share).click()
    for (const viewer of [carol, dave]) {
      await expect
        .poll(
          () =>
            shareTile(viewer, alice)
              .locator('video')
              .evaluate((video: HTMLVideoElement) => video.videoWidth),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(0)
      await expect(marks(viewer, alice)).toHaveCount(0)
    }
  })

  for (const member of [alice, bob, carol, dave]) await member.context.close()
})

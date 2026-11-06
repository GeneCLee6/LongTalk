import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { PROTOCOL_VERSION } from '../shared/protocol.ts'
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
    await shareTile(bob, alice)
      .getByRole('button', { name: strings.screenShare.annotate, exact: true })
      .click()
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
    // Worked out on every frame from the canvas as it is then: Carol's tile may still be settling
    // from the resizes above (its size has a 200 ms transition), and a position measured once
    // would miss the line altogether
    await marks(carol, alice).evaluate(
      (element: HTMLCanvasElement, { xs, y, source }) => {
        const seen: (number | null)[] = xs.map(() => null)
        const paint = element.getContext('2d')!
        const look = () => {
          const { clientWidth: width, clientHeight: height } = element
          const fit = Math.min(width / source.width, height / source.height)
          const ratio = element.width / width
          xs.forEach((x, index) => {
            if (seen[index] !== null) return
            const px = (width / 2 + (x - 0.5) * source.width * fit) * ratio
            const py = (height / 2 + (y - 0.5) * source.height * fit) * ratio
            const data = paint.getImageData(Math.round(px) - 2, Math.round(py) - 2, 5, 5).data
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
      { xs: steps, y, source: SOURCE },
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

// J3 (e7-t05, e7-t06; AC-7.3, AC-7.4) on the deployed Worker. The whiteboard's details are in
// e2e/local/whiteboard.spec.ts; here is what a real share and a real deployment add.

const myShare = (sharer: Member) =>
  sharer.page.getByRole('figure', { name: strings.screenShare.ownRegion })

async function shareAndWait(sharer: Member, viewers: Member[]) {
  await toolbarButton(sharer, strings.toolbar.share).click()
  for (const viewer of viewers) {
    await expect
      .poll(
        () =>
          shareTile(viewer, sharer)
            .locator('video')
            .evaluate((video: HTMLVideoElement) => video.videoWidth),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0)
  }
}

async function drawOnShare(viewer: Member, sharer: Member) {
  const tile = shareTile(viewer, sharer)
  await tile.hover()
  await tile.getByRole('button', { name: strings.screenShare.annotate, exact: true }).click()
  // The canvas is a lazy chunk: a stroke begun before it arrives lands on nothing
  await expect(viewer.page.getByRole('toolbar', { name: strings.annotation.toolbar })).toBeVisible()
  const from = await contentToPage(viewer, sharer, 0.2, LINE_Y)
  const to = await contentToPage(viewer, sharer, 0.8, LINE_Y)
  await viewer.page.mouse.move(from.x, from.y)
  await viewer.page.mouse.down()
  await viewer.page.mouse.move(to.x, to.y, { steps: 12 })
  await viewer.page.mouse.up()
}

const openParticipants = (member: Member) =>
  member.page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name: new RegExp(strings.toolbar.participants) })
    .click()

test('a sharer sees a viewer\'s stroke on their own share, drawn from the local capture', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const url = await openRoom(browser)
  const alice = await join(browser, url, 'Alice')
  const bob = await join(browser, url, 'Bob')
  await shareAndWait(alice, [bob])
  const bar = alice.page.getByRole('region', { name: strings.screenShare.youAreSharing })

  await test.step('Bob draws; Alice\'s bar says so before she opens anything', async () => {
    await expect(myShare(alice)).toHaveCount(0)
    await bar.getByRole('button', { name: strings.screenShare.ownOpen }).waitFor()
    await drawOnShare(bob, alice)
    await expect(bar.getByRole('button', { name: strings.screenShare.ownOpenMarked })).toBeVisible()
  })

  await test.step('Alice opens her own view: the stroke, on her own capture', async () => {
    await bar.getByRole('button', { name: strings.screenShare.ownOpenMarked }).click()
    await expect(myShare(alice)).toBeVisible()
    await expect(myShare(alice).getByText(strings.screenShare.ownLimit)).toBeVisible()
    // Her own track (the stand-in screen is a captured canvas), not one coming back from the SFU
    const local = await myShare(alice)
      .locator('video')
      .evaluate((video: HTMLVideoElement) =>
        'canvas' in (video.srcObject as MediaStream).getVideoTracks()[0],
      )
    expect(local).toBe(true)
    const canvas = myShare(alice).getByRole('img', { name: strings.screenShare.annotationCanvas })
    await expect
      .poll(() =>
        canvas.evaluate((element: HTMLCanvasElement, y) => {
          const { width, height } = element
          const data = element.getContext('2d')!.getImageData(0, Math.round(height * y) - 3, width, 7).data
          for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
          return false
        }, LINE_Y),
      )
      .toBe(true)
  })

  await test.step('Alice clears it, with confirmation; Bob is told', async () => {
    await myShare(alice).hover()
    await myShare(alice).getByRole('button', { name: strings.annotation.clearOthers }).click()
    await alice.page.getByRole('button', { name: strings.annotation.clearOne('Bob', 1) }).click()
    await alice.page.getByRole('button', { name: strings.annotation.clearConfirm, exact: true }).click()
    await expect(bob.page.getByText(strings.hostNotice.annotationsCleared('Alice', false, false))).toBeVisible()
    await expect.poll(() => paintedAt(bob, alice, 0.5, LINE_Y)).toBe(false)
  })

  for (const member of [alice, bob]) await member.context.close()
})

test('with annotation off the toolbar goes and a forged stroke is refused', async ({ browser }) => {
  test.setTimeout(240_000)
  const url = await openRoom(browser)
  const alice = await join(browser, url, 'Alice')
  const bob = await join(browser, url, 'Bob')
  const carol = await join(browser, url, 'Carol')
  await shareAndWait(carol, [alice, bob])
  await drawOnShare(bob, carol)
  await expectLine(alice, carol)

  await test.step('the host turns it off: Bob\'s toolbar and button go, the line stays', async () => {
    const tools = bob.page.getByRole('toolbar', { name: strings.annotation.toolbar })
    await expect(tools).toBeVisible()
    await openParticipants(alice)
    await alice.page
      .getByRole('combobox', { name: strings.annotation.policy.label })
      .selectOption('off')
    await expect(tools).toHaveCount(0)
    await shareTile(bob, carol).hover()
    await expect(
      shareTile(bob, carol).getByRole('button', { name: strings.screenShare.annotate, exact: true }),
    ).toHaveCount(0)
    await expectLine(alice, carol)
  })

  await test.step('a forged stroke from Bob\'s own socket is refused and reaches nobody', async () => {
    const received = await bob.page.evaluate(
      async ({ path, name }) => {
        // Someone new in the meeting who skips the interface: exactly what a forged client is
        const socket = new WebSocket(
          `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`,
        )
        const received: { t: string; code?: string; ops?: unknown[] }[] = []
        socket.addEventListener('message', (event) => {
          if (String(event.data).startsWith('{')) received.push(JSON.parse(String(event.data)))
        })
        await new Promise((resolve) => socket.addEventListener('open', resolve))
        socket.send(JSON.stringify({ t: 'join', name, token: null, client: null }))
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const welcome = received.find((message) => message.t === 'welcome') as
          | { state: { room: { shares: Record<string, unknown> } } }
          | undefined
        const share = Object.keys(welcome?.state.room.shares ?? {})[0]
        socket.send(
          JSON.stringify({
            t: 'annotate',
            share,
            ops: [
              {
                op: 'add',
                stroke: {
                  id: 'forged',
                  by: '',
                  tool: 'pen',
                  color: 'rose',
                  width: 'thick',
                  points: [
                    [0.2, 0.2],
                    [0.8, 0.2],
                  ],
                },
              },
            ],
          }),
        )
        await new Promise((resolve) => setTimeout(resolve, 1000))
        socket.close()
        return received
      },
      {
        path: new URL(url).pathname.replace(/^\/r\//, '/api/rooms/') + '/ws?v=' + PROTOCOL_VERSION,
        name: 'Forger',
      },
    )
    expect(received.filter((message) => message.t === 'error').map((m) => m.code)).toContain('forbidden')
    expect(await paintedAt(alice, carol, 0.5, 0.2)).toBe(false)
    expect(await paintedAt(bob, carol, 0.5, 0.2)).toBe(false)
  })

  for (const member of [alice, bob, carol]) await member.context.close()
})

test('whiteboard: Alice draws, Bob sees it, late Carol gets the replay', async ({ browser }) => {
  test.setTimeout(180_000)
  const url = await openRoom(browser)
  const alice = await join(browser, url, 'Alice')
  const bob = await join(browser, url, 'Bob')
  const board = (member: Member) =>
    member.page.getByRole('figure', { name: strings.whiteboard.region })
  const paintedOnBoard = (member: Member, x: number, y: number) =>
    board(member)
      .getByRole('img', { name: strings.screenShare.annotationCanvas })
      .evaluate(
        (element: HTMLCanvasElement, { x, y }) => {
          const ratio = element.width / element.clientWidth
          const px = (element.clientWidth / 2 + x * 1000) * ratio
          const py = (element.clientHeight / 2 + y * 1000) * ratio
          const data = element
            .getContext('2d')!
            .getImageData(Math.round(px) - 2, Math.round(py) - 2, 5, 5).data
          for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
          return false
        },
        { x, y },
      )

  await toolbarButton(alice, strings.toolbar.more).click()
  await alice.page.getByRole('menuitem', { name: strings.whiteboard.open, exact: true }).click()
  await expect(board(alice)).toBeVisible()
  await expect(board(bob)).toBeVisible()

  const box = (await board(alice).boundingBox())!
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await alice.page.mouse.move(middle.x - 150, middle.y)
  await alice.page.mouse.down()
  await alice.page.mouse.move(middle.x + 150, middle.y, { steps: 12 })
  await alice.page.mouse.up()
  await expect.poll(() => paintedOnBoard(bob, 0, 0)).toBe(true)
  expect(await paintedOnBoard(bob, 0, 0.1)).toBe(false)

  const carol = await join(browser, url, 'Carol')
  await expect(board(carol)).toBeVisible()
  await expect.poll(() => paintedOnBoard(carol, 0, 0)).toBe(true)
  await expect.poll(() => paintedOnBoard(carol, 0.14, 0)).toBe(true)
  expect(await paintedOnBoard(carol, 0.3, 0)).toBe(false)

  for (const member of [alice, bob, carol]) await member.context.close()
})

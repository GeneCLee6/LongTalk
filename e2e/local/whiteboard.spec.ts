import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { joinRoom, newRoom, strings, viewports } from './helpers.ts'

// The whiteboard and who may annotate (J3: e7-t05, e7-t06; AC-7.3, AC-7.4), in real browsers through
// the real RoomDO (`vite preview` runs the Worker in workerd; only the SFU is missing, which the
// whiteboard does not use). Where a world point should be on screen is worked out here, not with
// shared/boardGeometry.ts, and read back from the canvas's real pixels. The same permissions on a
// real share, through the real SFU, are in e2e/annotation.spec.ts.

interface Member {
  name: string
  context: BrowserContext
  page: Page
}

/** One world unit is this many CSS px at 100% (written out again here, on purpose) */
const UNIT = 1000

async function member(browser: Browser, path: string, name: string): Promise<Member> {
  const context = await browser.newContext(viewports.desktop)
  // The socket, to send what the interface would never let anyone send
  await context.addInitScript(() => {
    const Native = window.WebSocket
    const sockets: WebSocket[] = []
    const received: string[] = []
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
        this.addEventListener('message', (event) => received.push(String(event.data)))
      }
    }
    Object.assign(window, { sockets, received })
  })
  const page = await context.newPage()
  await joinRoom(page, path, name)
  return { name, context, page }
}

const openMenu = async (who: Member) =>
  who.page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name: strings.toolbar.more, exact: true })
    .click()

async function menuItem(who: Member, name: string) {
  await openMenu(who)
  await who.page.getByRole('menuitem', { name, exact: true }).click()
}

const board = (who: Member) => who.page.getByRole('figure', { name: strings.whiteboard.region })
const canvas = (who: Member) =>
  board(who).getByRole('img', { name: strings.screenShare.annotationCanvas })
const tools = (who: Member) => who.page.getByRole('toolbar', { name: strings.annotation.toolbar })

/** Where a world point is on the page: the board's centre plus world × UNIT × zoom */
async function worldToPage(who: Member, x: number, y: number, view = { zoom: 1, cx: 0, cy: 0 }) {
  const box = (await board(who).boundingBox())!
  return {
    x: box.x + box.width / 2 + (x - view.cx) * UNIT * view.zoom,
    y: box.y + box.height / 2 + (y - view.cy) * UNIT * view.zoom,
  }
}

async function paintedAt(
  who: Member,
  x: number,
  y: number,
  view = { zoom: 1, cx: 0, cy: 0 },
): Promise<boolean> {
  const box = (await board(who).boundingBox())!
  const at = await worldToPage(who, x, y, view)
  return canvas(who).evaluate(
    (element: HTMLCanvasElement, { px, py, width }) => {
      const ratio = element.width / width
      const data = element
        .getContext('2d')!
        .getImageData(Math.round(px * ratio) - 2, Math.round(py * ratio) - 2, 5, 5).data
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
      return false
    },
    { px: at.x - box.x, py: at.y - box.y, width: box.width },
  )
}

/** A line across world y, from x1 to x2 */
async function drawLine(who: Member, y: number, x1 = -0.2, x2 = 0.2) {
  const from = await worldToPage(who, x1, y)
  const to = await worldToPage(who, x2, y)
  await who.page.mouse.move(from.x, from.y)
  await who.page.mouse.down()
  await who.page.mouse.move(to.x, to.y, { steps: 10 })
  await who.page.mouse.up()
}

const expectLine = async (who: Member, y: number) => {
  for (const x of [-0.15, 0, 0.15]) await expect.poll(() => paintedAt(who, x, y)).toBe(true)
  // Only the line: nothing a little above it or past its ends
  expect(await paintedAt(who, 0, y + 0.05)).toBe(false)
  expect(await paintedAt(who, 0.3, y)).toBe(false)
}

/** Sends a raw frame on a member's socket */
const forge = (who: Member, message: object) =>
  who.page.evaluate((raw) => {
    const { sockets } = window as unknown as { sockets: WebSocket[] }
    sockets.filter((socket) => socket.readyState === WebSocket.OPEN).at(-1)!.send(raw)
  }, JSON.stringify(message))

/** What the member's socket got with this `t` */
const receivedOf = (who: Member, t: string) =>
  who.page.evaluate((type) => {
    const { received } = window as unknown as { received: string[] }
    return received.flatMap((raw) => {
      if (!raw.startsWith('{')) return []
      const message = JSON.parse(raw) as { t: string; code?: string }
      return message.t === type ? [message] : []
    })
  }, t)

async function expectNoViolations(page: Page, label: string, only?: string) {
  const builder = new AxeBuilder({ page })
  const results = await (only ? builder.include(only) : builder).analyze()
  expect(
    results.violations.map(({ id, nodes }) => `${id}: ${nodes.map((n) => n.html).join()}`),
    label,
  ).toEqual([])
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test('Alice opens the board and draws, Bob sees it, late Carol gets the replay', async ({
  browser,
}) => {
  const path = await newRoom(await browser.newPage())
  const alice = await member(browser, path, 'Alice')
  const bob = await member(browser, path, 'Bob')

  await test.step('the chunk has not loaded before anyone looks at it', async () => {
    const loaded = await alice.page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name),
    )
    expect(loaded.filter((name) => /Whiteboard|AnnotationLayer/.test(name))).toEqual([])
  })

  await test.step('it takes the main area for both', async () => {
    await menuItem(alice, strings.whiteboard.open)
    await expect(board(alice)).toBeVisible()
    await expect(board(bob)).toBeVisible()
    await expect(bob.page.getByText(strings.whiteboard.opened('Alice'))).toBeVisible()
    await expect(tools(alice)).toBeVisible()
    await expect(board(alice)).toHaveAttribute('data-grid', 'on')
  })

  await test.step('Alice draws; Bob sees it where it belongs, off the old 0–1 square', async () => {
    await drawLine(alice, -0.1)
    await expectLine(alice, -0.1)
    await expectLine(bob, -0.1)
  })

  await test.step('they meet at the same world point though their screens differ', async () => {
    await bob.page.setViewportSize({ width: 900, height: 700 })
    await expectLine(bob, -0.1)
    await bob.page.setViewportSize({ width: 1280, height: 800 })
    // The stage eases to its new size: drawing during that would miss where it aims
    let last = ''
    await expect
      .poll(async () => {
        const now = JSON.stringify(await board(bob).boundingBox())
        const settled = now === last
        last = now
        return settled
      })
      .toBe(true)
  })

  await test.step('Bob draws too, and his own zoom and pan are his alone', async () => {
    await drawLine(bob, 0.1)
    await expectLine(alice, 0.1)
    await board(bob).focus()
    await bob.page.keyboard.press('Shift+=')
    await bob.page.keyboard.press('Shift+=')
    await expect
      .poll(async () => Number(await board(bob).getAttribute('data-zoom')))
      .toBeCloseTo(1.5625, 3)
    // Alice's view did not move
    await expect(board(alice)).toHaveAttribute('data-zoom', '1')
    await expectLine(alice, -0.1)
    // At Bob's zoom, the same world point is further from the middle: still on the line
    const zoomed = { zoom: 1.5625, cx: 0, cy: 0 }
    await expect.poll(() => paintedAt(bob, 0.15, -0.1, zoomed)).toBe(true)
    expect(await paintedAt(bob, 0.15, -0.05, zoomed)).toBe(false)
    await bob.page.keyboard.press('0')
    await expect(board(bob)).toHaveAttribute('data-zoom', '1')
  })

  await test.step('with the pen off a drag moves the board, and the world goes with it', async () => {
    await board(alice).getByRole('button', { name: strings.whiteboard.pen }).click()
    await expect(tools(alice)).toHaveCount(0)
    const from = await worldToPage(alice, 0, 0.3)
    await alice.page.mouse.move(from.x, from.y)
    await alice.page.mouse.down()
    await alice.page.mouse.move(from.x + 120, from.y + 60, { steps: 4 })
    await alice.page.mouse.up()
    const panned = { zoom: 1, cx: -0.12, cy: -0.06 }
    await expect.poll(() => paintedAt(alice, 0, -0.1, panned)).toBe(true)
    expect(await paintedAt(alice, 0, -0.1)).toBe(false)
    await board(alice).getByRole('button', { name: strings.whiteboard.home(100) }).click()
    await expect.poll(() => paintedAt(alice, 0, -0.1)).toBe(true)
    await board(alice).getByRole('button', { name: strings.whiteboard.pen }).click()
  })

  await test.step('the grid turns off', async () => {
    await board(alice).getByRole('button', { name: strings.whiteboard.grid }).click()
    await expect(board(alice)).toHaveAttribute('data-grid', 'off')
    // Only for Alice
    await expect(board(bob)).toHaveAttribute('data-grid', 'on')
  })

  const carol = await test.step('Carol joins late and gets all of it', async () => {
    const late = await member(browser, path, 'Carol')
    await expect(board(late)).toBeVisible()
    await expectLine(late, -0.1)
    await expectLine(late, 0.1)
    return late
  })

  await test.step('Bob reloads: the same strokes', async () => {
    await bob.page.reload()
    await expect(board(bob)).toBeVisible()
    await expectLine(bob, -0.1)
  })

  await test.step('nothing on the board breaks accessibility, nor does its dialog', async () => {
    await expectNoViolations(alice.page, 'the whiteboard, with the tools')
    await expectNoViolations(carol.page, 'the whiteboard, a participant')
    await board(alice).getByRole('button', { name: strings.annotation.clearOthers }).click()
    await expect(alice.page.getByRole('dialog')).toBeVisible()
    await expectNoViolations(alice.page, 'the clear dialog')
    await alice.page.keyboard.press('Escape')
    await expect(alice.page.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('closing keeps the strokes; opening again brings them back', async () => {
    await board(alice).getByRole('button', { name: strings.whiteboard.close }).click()
    for (const who of [alice, bob, carol]) await expect(board(who)).toHaveCount(0)
    await menuItem(alice, strings.whiteboard.open)
    for (const who of [alice, bob, carol]) await expect(board(who)).toBeVisible()
    await expectLine(carol, -0.1)
  })

  for (const who of [alice, bob, carol]) await who.context.close()
})

test('who may annotate: the toolbar goes, forged strokes are refused, clearing tells people', async ({
  browser,
}) => {
  const path = await newRoom(await browser.newPage())
  const alice = await member(browser, path, 'Alice')
  const bob = await member(browser, path, 'Bob')
  const carol = await member(browser, path, 'Carol')
  await menuItem(alice, strings.whiteboard.open)
  await expect(board(bob)).toBeVisible()
  await drawLine(alice, -0.1)
  await drawLine(bob, 0.1)
  await expectLine(carol, -0.1)
  await expectLine(carol, 0.1)

  const setPolicy = async (value: 'everyone' | 'sharer' | 'off') => {
    const panel = alice.page.getByRole('combobox', { name: strings.annotation.policy.label })
    if ((await panel.count()) === 0) {
      await alice.page
        .getByRole('toolbar', { name: strings.devices.controls })
        .getByRole('button', { name: new RegExp(strings.toolbar.participants) })
        .click()
    }
    await alice.page
      .getByRole('combobox', { name: strings.annotation.policy.label })
      .selectOption(value)
  }

  await test.step('a participant has no such control', async () => {
    await bob.page
      .getByRole('toolbar', { name: strings.devices.controls })
      .getByRole('button', { name: new RegExp(strings.toolbar.participants) })
      .click()
    await expect(bob.page.getByRole('combobox', { name: strings.annotation.policy.label })).toHaveCount(0)
    await bob.page.keyboard.press('Escape')
  })

  await test.step('host and sharer only: Bob loses the tools and is told', async () => {
    await setPolicy('sharer')
    await expect(tools(bob)).toHaveCount(0)
    await expect(board(bob).getByText(strings.whiteboard.viewOnly)).toBeVisible()
    const label = strings.annotation.policy.options.sharer
    await expect(bob.page.getByText(new RegExp(label)).first()).toBeVisible()
    // The host keeps them
    await expect(tools(alice)).toBeVisible()
    await expectNoViolations(alice.page, 'the policy control in the panel')
  })

  await test.step('off: nobody has them, the host neither; what is drawn stays', async () => {
    await setPolicy('off')
    await expect(tools(alice)).toHaveCount(0)
    await expect(tools(bob)).toHaveCount(0)
    await expectLine(bob, -0.1)
  })

  await test.step('off: a forged stroke is refused, and reaches nobody', async () => {
    const forged = {
      id: 'forged',
      tool: 'pen',
      color: 'rose',
      width: 'thick',
      by: '',
      points: [
        [-0.2, 0.25],
        [0.2, 0.25],
      ],
    }
    await forge(bob, { t: 'annotate', share: 'whiteboard', ops: [{ op: 'add', stroke: forged }] })
    await expect
      .poll(async () => (await receivedOf(bob, 'error')).map((m) => m.code))
      .toContain('forbidden')
    await carol.page.waitForTimeout(300)
    expect(await paintedAt(carol, 0, 0.25)).toBe(false)
    // Nor does a late joiner get it
    const dave = await member(browser, path, 'Dave')
    await expect(board(dave)).toBeVisible()
    await expectLine(dave, -0.1)
    expect(await paintedAt(dave, 0, 0.25)).toBe(false)
    await dave.context.close()
  })

  await test.step('a forged clear from someone who may not is refused too', async () => {
    await forge(bob, { t: 'clearAnnotations', share: 'whiteboard', by: null })
    await expectLine(carol, -0.1)
  })

  await test.step('the host clears one person, with confirmation; that person is told', async () => {
    await board(alice).getByRole('button', { name: strings.annotation.clearOthers }).click()
    await alice.page
      .getByRole('button', { name: strings.annotation.clearOne('Bob', 1) })
      .click()
    // Nothing yet: it asks first
    await expectLine(carol, 0.1)
    // Only the question: Dave's closed browser left a 重新連線中 tile dimmed behind the backdrop
    await expectNoViolations(alice.page, 'the clear confirmation', '[role="alertdialog"]')
    await alice.page.getByRole('button', { name: strings.annotation.clearConfirm, exact: true }).click()
    await expect.poll(() => paintedAt(carol, 0, 0.1)).toBe(false)
    await expectLine(carol, -0.1)
    await expect(
      bob.page.getByText(strings.hostNotice.annotationsCleared('Alice', false, true)),
    ).toBeVisible()
  })

  await test.step('then everything', async () => {
    await board(alice).getByRole('button', { name: strings.annotation.clearOthers }).click()
    await alice.page.getByRole('button', { name: strings.annotation.clearAll(1) }).click()
    await alice.page.getByRole('button', { name: strings.annotation.clearConfirm, exact: true }).click()
    await expect.poll(() => paintedAt(carol, 0, -0.1)).toBe(false)
    await expect(board(alice).getByRole('button', { name: strings.annotation.clearOthers })).toHaveCount(0)
  })

  await test.step('turned back on, everyone draws again', async () => {
    await setPolicy('everyone')
    await expect(tools(bob)).toBeVisible()
    await drawLine(bob, 0.1)
    await expectLine(carol, 0.1)
  })

  for (const who of [alice, bob, carol]) await who.context.close()
})

test('a phone sees the board and its tools fit (the fingers\' details are e7-t09)', async ({ browser }) => {
  const path = await newRoom(await browser.newPage())
  const alice = await member(browser, path, 'Alice')
  await menuItem(alice, strings.whiteboard.open)
  await expect(board(alice)).toBeVisible()
  await drawLine(alice, -0.05, -0.1, 0.1)

  const context = await browser.newContext(viewports.phone)
  const page = await context.newPage()
  await joinRoom(page, path, 'Phone')
  const phone: Member = { name: 'Phone', context, page }
  await expect(board(phone)).toBeVisible()
  await expect(tools(phone)).toBeVisible()
  await expect.poll(() => paintedAt(phone, 0, -0.05)).toBe(true)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await expectNoViolations(page, 'the whiteboard on a phone')
  await context.close()
  await alice.context.close()
})

test('the keyboard draws on the board, and the export dialog and the cursor pass axe (J4, e7-t09)', async ({
  browser,
}) => {
  const path = await newRoom(await browser.newPage())
  const alice = await member(browser, path, 'Alice')
  await menuItem(alice, strings.whiteboard.open)
  await expect(tools(alice)).toBeVisible()

  await tools(alice).getByRole('button', { name: strings.annotation.modes.pen, exact: true }).focus()
  await alice.page.keyboard.press('Enter')
  const cursor = alice.page.getByRole('application', { name: strings.annotation.keyboard.cursor })
  await expect(cursor).toBeFocused()
  await expectNoViolations(alice.page, 'the keyboard pen')
  await alice.page.keyboard.press('Enter')
  for (let i = 0; i < 5; i += 1) await alice.page.keyboard.press('Shift+ArrowRight')
  await alice.page.keyboard.press('Enter')
  // From the centre, 40 px at a time: 0.2 of a world unit along
  for (const x of [0.05, 0.15]) await expect.poll(() => paintedAt(alice, x, 0)).toBe(true)
  expect(await paintedAt(alice, 0, 0.05)).toBe(false)
  await alice.page.keyboard.press('Escape')
  await expect(cursor).toBeHidden()

  await board(alice).getByRole('button', { name: strings.annotation.exportButton }).click()
  await expect(
    alice.page.getByRole('dialog', { name: strings.annotation.exporting.boardTitle }),
  ).toBeVisible()
  await expectNoViolations(alice.page, 'the export dialog')
  await alice.page.keyboard.press('Escape')
  await alice.context.close()
})

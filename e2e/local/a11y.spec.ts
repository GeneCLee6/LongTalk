import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { joinRoom, newRoom, openPreJoin, secondMember, strings, viewports } from './helpers.ts'

// G5 (e4-t14, AC-4.9): axe-core finds nothing on every screen and the open states that matter
// (menus, drawers, dialogs, panels), in both schemes and on a phone; and the room works from the
// keyboard alone. Lighthouse's accessibility score is checked separately (scripts/lighthouse.ts).

/** WCAG 2.2 A and AA, plus axe's best practices (headings, landmarks, regions) */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

async function expectNoViolations(page: Page, what: string) {
  // A drawer or menu still fading in has, for a moment, too little contrast
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  )
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const found = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n` +
      violation.nodes
        .map((node) => `    ${node.target.join(' ')}\n      ${node.failureSummary}`)
        .join('\n'),
  )
  expect(found, `axe on ${what}`).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme })

    test('home, pre-join and admin have no axe violations', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { name: strings.tagline })).toBeVisible()
      await expectNoViolations(page, 'home')
      // An invalid link shows the field's error
      await page.getByRole('textbox', { name: strings.home.joinLabel }).fill('no pe')
      await page.getByRole('button', { name: strings.home.join, exact: true }).click()
      await expect(page.getByText(strings.home.joinInvalid)).toBeVisible()
      await expectNoViolations(page, 'home with an error')

      const path = await newRoom(page)
      await openPreJoin(page, path)
      await expectNoViolations(page, 'pre-join')
      // The pre-join screen's 設定 (H3)
      await page.getByRole('button', { name: strings.settings.open, exact: true }).click()
      await expect(page.getByRole('dialog', { name: strings.settings.title })).toBeVisible()
      await expectNoViolations(page, 'pre-join settings')
      await page.keyboard.press('Escape')

      await page.goto('/admin')
      await expect(page.getByRole('heading', { name: strings.admin.lockedTitle })).toBeVisible()
      await expectNoViolations(page, 'admin')
    })
  })
}

test('/me signed out and signed in (I2) has no axe violations', async ({ page }) => {
  // A passkey for localhost from Chromium's virtual authenticator
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
  await page.goto('/me')
  await expect(page.getByRole('button', { name: strings.account.signIn })).toBeVisible()
  await expectNoViolations(page, '/me signed out')
  await page.getByRole('textbox', { name: strings.account.nameLabel }).fill('Ally')
  await page.getByRole('button', { name: strings.account.signUp }).click()
  await expect(page.getByText(strings.account.signedInAs('Ally'))).toBeVisible()
  await page.getByRole('textbox', { name: strings.account.slugLabel }).fill(`ally-${Date.now()}`)
  await page.getByRole('button', { name: strings.account.createRoom }).click()
  await page.getByRole('button', { name: /^.+ 的設定$/ }).click()
  await expectNoViolations(page, '/me signed in, with a room and its settings')
  await page.getByRole('button', { name: strings.account.deleteAccount }).click()
  await expectNoViolations(page, '/me delete confirmation')
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: strings.account.deleteAccount })
    .click()
  await expect(page.getByRole('button', { name: strings.account.signIn })).toBeVisible()
})

test('the room, its panels, menus and dialogs have no axe violations', async ({
  page,
  browser,
}) => {
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const bob = await secondMember(browser, path, 'Bob')
  await expect(page.getByRole('figure', { name: /Bob/ })).toBeVisible()
  await expectNoViolations(page, 'room')

  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  await toolbar.getByRole('button', { name: /^聊天/ }).click()
  await expect(page.getByRole('textbox', { name: strings.chat.inputLabel })).toBeFocused()
  await expectNoViolations(page, 'chat panel')

  await toolbar.getByRole('button', { name: /^參與者/ }).click()
  await expect(page.getByRole('list', { name: strings.participants.list })).toBeVisible()
  await page.getByRole('button', { name: strings.participants.actions('Bob') }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expectNoViolations(page, 'participants panel with a member menu')
  await page.keyboard.press('Escape')

  await toolbar.getByRole('button', { name: strings.reactions.button, exact: true }).click()
  await expect(page.getByRole('dialog', { name: strings.reactions.picker })).toBeVisible()
  await expectNoViolations(page, 'reactions picker')
  await page.keyboard.press('Escape')

  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expectNoViolations(page, 'more menu')
  // 更多 › 設定 (H3): each of its three tabs
  await page.getByRole('menuitem', { name: strings.settings.menu }).click()
  const settings = page.getByRole('dialog', { name: strings.settings.title })
  await expect(settings).toBeVisible()
  for (const tab of [
    strings.settings.audio,
    strings.settings.video,
    strings.settings.performance,
  ]) {
    await settings.getByRole('tab', { name: tab }).click()
    await expect(settings.getByRole('tabpanel', { name: tab })).toBeVisible()
    await expectNoViolations(page, `settings: ${tab}`)
  }
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  // 更多 › 開始錄影… (I4): 錄影設定, then cancelled (recording itself: recording.spec.ts)
  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await page.getByRole('menuitem', { name: strings.record.start }).click()
  const record = page.getByRole('dialog', { name: strings.record.dialogTitle })
  await expect(record).toBeVisible()
  await expectNoViolations(page, 'recording settings')
  await page.keyboard.press('Escape')
  await expect(record).toHaveCount(0)

  // 更多 › 連線統計 (H2): no Realtime SFU here, so it says it is collecting
  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await page.getByRole('menuitem', { name: strings.stats.menu }).click()
  await expect(page.getByRole('complementary', { name: strings.stats.title })).toBeVisible()
  await expectNoViolations(page, 'stats panel')
  await page.getByRole('button', { name: strings.stats.close }).click()

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Shift+?')
  await expect(page.getByRole('dialog', { name: strings.shortcuts.title })).toBeVisible()
  await expectNoViolations(page, 'shortcuts dialog')
  await page.keyboard.press('Escape')

  await toolbar.getByRole('button', { name: strings.toolbar.leave, exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectNoViolations(page, 'leave question')
  await bob.context.close()
})

/** getDisplayMedia replaced by a moving canvas (headless Chromium has no picker), as a window */
async function stubScreen(context: BrowserContext, displaySurface: string) {
  await context.addInitScript((surface) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 360
      const context = canvas.getContext('2d')!
      let frame = 0
      setInterval(() => {
        frame += 1
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, 640, 360)
        context.fillStyle = '#0e7490'
        context.fillRect((frame * 12) % 640, 120, 120, 120)
      }, 1000 / 15)
      const stream = canvas.captureStream(15)
      const track = stream.getVideoTracks()[0]
      const settings = track.getSettings.bind(track)
      track.getSettings = () => ({ ...settings(), displaySurface: surface })
      return stream
    }
  }, displaySurface)
}

test('sharing: the bar with its preview and warnings, two shares and the picker (H5)', async ({
  browser,
}) => {
  const adaContext = await browser.newContext(viewports.desktop)
  await stubScreen(adaContext, 'monitor')
  const page = await adaContext.newPage()
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const bobContext = await browser.newContext(viewports.desktop)
  await stubScreen(bobContext, 'window')
  const bob = await bobContext.newPage()
  await joinRoom(bob, path, 'Bob')
  const carolContext = await browser.newContext(viewports.desktop)
  await stubScreen(carolContext, 'window')
  const carol = await carolContext.newPage()
  await joinRoom(carol, path, 'Carol')
  const share = (member: Page) =>
    member
      .getByRole('toolbar', { name: strings.devices.controls })
      .getByRole('button', { name: strings.toolbar.share, exact: true })
      .click()

  // Bob shares a window: his bar has the 文字／動態 switch and his own small preview
  await share(bob)
  const bobBar = bob.getByRole('region', { name: strings.screenShare.youAreSharing })
  await expect(bobBar.getByRole('img', { name: strings.screenShare.preview })).toBeVisible()
  await expectNoViolations(bob, 'the sharing bar with its preview')
  // Carol shares too: Ada sees the latest big with the picker, Bob's in the strip
  await share(carol)
  await expect(page.getByRole('group', { name: strings.screenShare.picker })).toBeVisible()
  await expectNoViolations(page, 'two shares and the picker')
  // Ada shares her whole screen with the meeting in front: the warning (e3-t09)
  await page.bringToFront()
  await share(page)
  await expect(
    page.getByRole('alert').filter({ hasText: strings.screenShare.selfCapture.screenWithMeeting }),
  ).toBeVisible({ timeout: 10_000 })
  await expectNoViolations(page, 'the self-capture warning')
  for (const context of [adaContext, bobContext, carolContext]) await context.close()
})

test('the phone room and its drawers have no axe violations', async ({ browser }) => {
  const context = await browser.newContext(viewports.phone)
  const page = await context.newPage()
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  await expectNoViolations(page, 'phone room')
  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectNoViolations(page, 'phone more drawer')
  // 設定 on a phone is a full-screen drawer (H3)
  await page.getByRole('menuitem', { name: strings.settings.menu }).click()
  await expect(page.getByRole('dialog', { name: strings.settings.title })).toBeVisible()
  await expectNoViolations(page, 'phone settings drawer')
  await page.keyboard.press('Escape')
  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await page.getByRole('menuitem', { name: strings.stats.menu }).click()
  await expect(page.getByRole('dialog', { name: strings.stats.title })).toBeVisible()
  await expectNoViolations(page, 'phone stats drawer')
  await page.keyboard.press('Escape')
  await toolbar.getByRole('button', { name: /^聊天/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectNoViolations(page, 'phone chat drawer')
  await context.close()
})

test('the room works from the keyboard alone', async ({ page, browser }) => {
  const path = await newRoom(page)
  await openPreJoin(page, path)
  // The name field has focus first; Enter joins
  await expect(page.getByRole('textbox', { name: strings.prejoin.nameLabel })).toBeFocused()
  await page.keyboard.type('Ada')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  const bob = await secondMember(browser, path, 'Bob')
  const bobTile = page.getByRole('figure', { name: /Bob/ })
  await expect(bobTile).toBeVisible()

  /** Presses Tab until the element has focus (at most `limit` times) */
  async function tabTo(target: ReturnType<Page['getByRole']>, limit = 40) {
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press('Tab')
      if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return
    }
    throw new Error(`Tab never reached ${target}`)
  }

  // Pin Bob's tile: its button shows when it has focus
  const pin = bobTile.getByRole('button', { name: strings.view.pin('Bob') })
  await tabTo(pin)
  await expect(pin).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(bobTile.getByRole('button', { name: strings.view.unpin('Bob') })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // A reaction from the picker, with the arrow keys
  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  const reactions = toolbar.getByRole('button', { name: strings.reactions.button, exact: true })
  await tabTo(reactions)
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog', { name: strings.reactions.picker })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('button').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('img', { name: /^Ada：/ }).first()).toBeAttached()

  // The participants panel and a member's menu
  await page.keyboard.press('Escape')
  const participants = toolbar.getByRole('button', { name: /^參與者/ })
  await tabTo(participants)
  await page.keyboard.press('Enter')
  const actions = page.getByRole('button', { name: strings.participants.actions('Bob') })
  await tabTo(actions)
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(actions).toBeFocused()

  // Every focusable thing shows a focus ring
  const ringless = await page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )) {
      if (el.closest('[inert], [aria-hidden="true"]') || el.offsetParent === null) continue
      el.focus({ focusVisible: true } as FocusOptions)
      if (document.activeElement !== el) continue
      const style = getComputedStyle(el)
      const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2
      if (!ring && !style.boxShadow.includes('px')) out.push(el.outerHTML.slice(0, 120))
    }
    return out
  })
  expect(ringless, 'elements without a visible focus ring').toEqual([])
  await bob.context.close()
})

test('the waiting room, the host’s waiting list and the after-leave screen have no axe violations', async ({
  page,
  browser,
}) => {
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  await toolbar.getByRole('button', { name: /^參與者/ }).click()
  await page.getByRole('switch', { name: strings.participants.waitingRoom }).click()
  await expect(
    page.getByRole('switch', { name: strings.participants.waitingRoom }),
  ).toHaveAttribute('aria-checked', 'true')

  const context = await browser.newContext(viewports.desktop)
  const bob = await context.newPage()
  await openPreJoin(bob, path)
  await bob.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Bob')
  await bob.getByRole('button', { name: strings.prejoin.joinWaiting, exact: true }).click()
  await expect(bob.getByRole('heading', { name: strings.waiting.title })).toBeVisible()
  await expectNoViolations(bob, 'waiting room')

  const admit = page.getByRole('button', { name: strings.participants.admitLabel('Bob') })
  await expect(admit).toBeVisible()
  await expectNoViolations(page, 'participants panel with the waiting list')
  await admit.click()
  await expect(bob.getByRole('region', { name: strings.room.grid })).toBeVisible()

  await bob
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name: strings.toolbar.leave, exact: true })
    .click()
  await expect(bob.getByRole('heading', { name: strings.left.title })).toBeVisible()
  await expectNoViolations(bob, 'after-leave screen')
  await context.close()
})

test('the host’s password and rename dialogs, and English, have no axe violations', async ({
  page,
}) => {
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  await toolbar.getByRole('button', { name: /^參與者/ }).click()
  await page.getByRole('button', { name: strings.password.setTitle }).click()
  await expect(page.getByRole('dialog', { name: strings.password.setTitle })).toBeVisible()
  // A password that is too short shows the field's error
  await page.getByRole('textbox', { name: strings.password.label }).fill('ab')
  await page.getByRole('button', { name: strings.password.save, exact: true }).click()
  await expect(page.getByText(strings.password.invalid)).toBeVisible()
  await expectNoViolations(page, 'password dialog with an error')
  await page.keyboard.press('Escape')

  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await page.getByRole('menuitem', { name: strings.rename.room }).click()
  await expect(page.getByRole('dialog', { name: strings.rename.room })).toBeVisible()
  await expectNoViolations(page, 'rename dialog')
  await page.keyboard.press('Escape')

  // English, through 更多 › 語言
  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'English' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expectNoViolations(page, 'room in English')
})

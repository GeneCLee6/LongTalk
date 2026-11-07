import { expect, test, type Browser, type Page } from '@playwright/test'
// The browsers run in zh-TW (playwright.config.ts): the Chinese dictionary
import { zhTW as strings } from '../src/i18n/zh-TW.ts'

// I2 (e1-t12, e1-t13): passkey accounts and a personal persistent room on the deployed preview,
// with Chromium's virtual authenticator (CDP WebAuthn: a platform authenticator with user
// verification, discoverable credentials). The owner signs up on /me, signs out, signs in again
// without a user name, makes a persistent room with a password and opens it: the name is the
// account's, no password is asked and they are the host. An anonymous browser joins with the
// password and is a participant. The owner ends the meeting; the room is still there with its
// settings (the password is asked again, the name kept), the owner comes back as host, deletes
// the room (404 from then on) and the account. Every preview shares one D1 database, so the slug
// is unique per run and the account deletes itself.
//
// L5 (e1-t18, e5-t07, e5-t08; AC-5.5) uses this same room, so the suite makes no room more than it
// did (ROOM_CREATE_LIMITS): the owner's settings hold in the room, and a poll, the countdown and the
// agenda go through the real RoomDO, survive the guest reloading, and end up in the chat.

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

const OWNER = `E2E Owner ${Date.now() % 100_000}`
const SLUG = `e2e-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
const PASSWORD = 'e2e4321'

async function newMember(browser: Browser) {
  const context = await browser.newContext({ locale: 'zh-TW', permissions: ['camera', 'microphone'] })
  return { context, page: await context.newPage() }
}

const toolbarButton = (page: Page, name: string) =>
  page.getByRole('toolbar', { name: strings.devices.controls }).getByRole('button', { name, exact: true })

/** The participants panel's row of `name` says `role` (opens the panel first) */
async function expectRole(page: Page, count: number, name: string, role: string) {
  const panel = page.getByRole('complementary', { name: strings.participants.title })
  if (!(await panel.isVisible())) await toolbarButton(page, strings.toolbar.participantsCount(count)).click()
  const row = panel
    .getByRole('list', { name: strings.participants.list })
    .getByRole('listitem', { name, exact: true })
  await expect(row).toContainText(role)
}

test('a passkey account, its persistent room and the owner as host (I2)', async ({ browser }) => {
  test.setTimeout(180_000)
  const owner = await newMember(browser)
  const page = owner.page
  await virtualAuthenticator(page)

  await test.step('sign up with a passkey on /me', async () => {
    await page.goto('/')
    await page.getByRole('link', { name: strings.account.homeLink }).click()
    await page.getByRole('textbox', { name: strings.account.nameLabel }).fill(OWNER)
    await page.getByRole('button', { name: strings.account.signUp }).click()
    await expect(page.getByText(strings.account.signedInAs(OWNER))).toBeVisible()
    const cookie = (await owner.context.cookies()).find((c) => c.name === '__Host-lt_session')
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' })
  })

  await test.step('sign out, and back in with no user name', async () => {
    await page.getByRole('button', { name: strings.account.signOut, exact: true }).click()
    await page.getByRole('button', { name: strings.account.signIn }).click()
    await expect(page.getByText(strings.account.signedInAs(OWNER))).toBeVisible()
  })

  await test.step('make a persistent room with a name and a password', async () => {
    await page.getByRole('textbox', { name: strings.account.slugLabel }).fill(SLUG)
    await page.getByRole('textbox', { name: strings.account.roomNameLabel }).fill('E2E 固定房')
    await page.getByRole('button', { name: strings.account.createRoom }).click()
    await page.getByRole('button', { name: strings.account.editRoomLabel(SLUG) }).click()
    await page.getByLabel(strings.account.newPassword).fill(PASSWORD)
    await page.getByRole('button', { name: strings.account.saveRoom }).click()
    await expect(page.getByText(strings.account.passwordSet)).toBeVisible()
  })

  await test.step('set the room to start muted, with no annotation and no recording (L5)', async () => {
    await page.getByRole('button', { name: strings.account.editRoomLabel(SLUG) }).click()
    await page.getByRole('checkbox', { name: strings.account.startMuted }).check()
    await page.getByRole('checkbox', { name: strings.account.allowAnnotation }).uncheck()
    await page.getByRole('checkbox', { name: strings.account.allowRecording }).uncheck()
    await page.getByRole('button', { name: strings.account.saveRoom }).click()
    await expect(page.getByText(strings.account.noRecording)).toBeVisible()
    await page.reload()
    await expect(page.getByText(strings.account.noAnnotation)).toBeVisible()
    await expect(page.getByText(strings.account.startMuted)).toBeVisible()
  })

  await test.step('the owner joins without the password and is the host', async () => {
    await page.goto(`/r/${SLUG}`)
    await expect(page.getByRole('textbox', { name: strings.prejoin.nameLabel })).toHaveValue(OWNER)
    await expect(page.getByLabel(strings.prejoin.passwordLabel, { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
    await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
    await expectRole(page, 1, OWNER, strings.participants.host)
  })

  const guest = await newMember(browser)
  await test.step('an anonymous browser joins with the password as a participant', async () => {
    await guest.page.goto(`/r/${SLUG}`)
    await guest.page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Guest')
    await guest.page.getByLabel(strings.prejoin.passwordLabel, { exact: true }).fill(PASSWORD)
    await guest.page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
    await expect(guest.page.getByRole('region', { name: strings.room.grid })).toBeVisible()
    await expectRole(guest.page, 2, OWNER, strings.participants.host)
    const panel = guest.page.getByRole('complementary', { name: strings.participants.title })
    await expect(panel.getByRole('listitem', { name: 'Guest', exact: true })).not.toContainText(
      strings.participants.host,
    )
  })

  await test.step('the owner’s settings hold in the room (L5, e1-t18)', async () => {
    // The guest came in muted, told why; the owner, the host, did not
    await expect(guest.page.getByText(strings.hostNotice.startMuted)).toBeVisible()
    await expect(toolbarButton(guest.page, strings.toolbar.micOff)).toBeVisible()
    await expect(toolbarButton(page, strings.toolbar.micOn)).toBeVisible()
    // Not even the host may turn annotation on, or record
    await expect(
      page.getByRole('combobox', { name: strings.annotation.policy.label }),
    ).toBeDisabled()
    await expect(page.getByText(strings.annotation.policy.lockedByOwner)).toBeVisible()
    await toolbarButton(page, strings.toolbar.more).click()
    await expect(page.getByRole('menuitem', { name: strings.interact.menu })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: strings.record.start })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  await test.step('a poll, the countdown and the agenda, live for both (L5, e5-t07, e5-t08)', async () => {
    await toolbarButton(page, strings.toolbar.more).click()
    await page.getByRole('menuitem', { name: strings.interact.menu }).click()
    const form = page.getByRole('form', { name: strings.poll.formLabel })
    await form.getByRole('textbox', { name: strings.poll.question }).fill('午餐吃什麼')
    await form.getByRole('textbox', { name: strings.poll.option(1) }).fill('麵')
    await form.getByRole('textbox', { name: strings.poll.option(2) }).fill('飯')
    await form.getByRole('checkbox', { name: strings.poll.anonymous }).check()
    await form.getByRole('button', { name: strings.poll.start }).click()

    await page.getByRole('spinbutton', { name: strings.timer.minutes, exact: true }).fill('10')
    await page.getByRole('button', { name: strings.timer.start }).click()
    await page.getByRole('textbox', { name: strings.agenda.item(1) }).fill('開場')
    await page.getByRole('button', { name: strings.agenda.add }).click()
    await page.getByRole('textbox', { name: strings.agenda.item(2) }).fill('討論')
    await page.getByRole('button', { name: strings.agenda.save }).click()

    // The guest is asked on the stage, sees the countdown and the agenda, and answers
    const agenda = guest.page.getByRole('navigation', { name: strings.agenda.label })
    await expect(agenda.getByRole('listitem').first()).toHaveAttribute('aria-current', 'step')
    await expect(agenda).toContainText('討論')
    await expect(agenda.getByRole('button')).toHaveCount(0)
    const countdown = guest.page.getByRole('timer', { name: strings.timer.label })
    await expect(countdown).toContainText(/^00:(10:00|09:\d\d)$/)
    await expect(guest.page.getByText(strings.poll.asked('午餐吃什麼'))).toBeVisible()
    await guest.page.getByRole('button', { name: strings.poll.answerNow }).click()
    await guest.page.getByRole('radio', { name: '飯' }).check()
    await guest.page.getByRole('button', { name: strings.poll.vote, exact: true }).click()
    await expect(guest.page.getByRole('button', { name: strings.poll.change })).toBeVisible()

    // Live for the host, who sees the numbers and, this being anonymous, no name
    const results = page.getByRole('list', { name: strings.poll.results })
    await expect(results.getByRole('listitem').nth(1)).toContainText(strings.poll.count(1, 100))
    await expect(results).not.toContainText('Guest')

    // The host moves the agenda along, for both
    await page
      .getByRole('navigation', { name: strings.agenda.label })
      .getByRole('button', { name: strings.agenda.next })
      .click()
    await expect(agenda.getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step')
  })

  await test.step('the guest reloads: everything is back, with their own answer (L5)', async () => {
    await guest.page.reload()
    await expect(guest.page.getByRole('region', { name: strings.room.grid })).toBeVisible()
    await expect(guest.page.getByRole('timer', { name: strings.timer.label })).toBeVisible()
    const agenda = guest.page.getByRole('navigation', { name: strings.agenda.label })
    await expect(agenda.getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step')
    // Answered already: not asked again, and still theirs although the poll is anonymous
    await expect(guest.page.getByText(strings.poll.asked('午餐吃什麼'))).toHaveCount(0)
    await toolbarButton(guest.page, strings.toolbar.more).click()
    await guest.page.getByRole('menuitem', { name: strings.interact.menu }).click()
    await expect(guest.page.getByRole('radio', { name: '飯' })).toBeChecked()
    await expect(guest.page.getByRole('button', { name: strings.poll.change })).toBeVisible()
    // Counted once
    await expect(page.getByText(strings.poll.voters(1), { exact: true })).toBeVisible()
  })

  await test.step('the host ends the poll: its results are in everyone’s chat (L5)', async () => {
    await page.getByRole('button', { name: strings.poll.end }).click()
    await expect(page.getByRole('form', { name: strings.poll.formLabel })).toBeVisible()
    await expect(guest.page.getByText(strings.poll.none)).toBeVisible()
    await guest.page
      .getByRole('tablist', { name: strings.participants.tabs })
      .getByRole('tab', { name: /^聊天/ })
      .click()
    const log = guest.page.getByRole('log', { name: strings.chat.messages })
    await expect(log.getByText(strings.poll.resultTitle('午餐吃什麼'))).toBeVisible()
    await expect(log.getByText(strings.poll.count(1, 100))).toBeVisible()
    await expect(log).not.toContainText('Guest')
    // Back to the panel the next steps start from
    await guest.page
      .getByRole('tablist', { name: strings.participants.tabs })
      .getByRole('tab', { name: /^參與者/ })
      .click()
    await page
      .getByRole('tablist', { name: strings.participants.tabs })
      .getByRole('tab', { name: /^參與者/ })
      .click()
  })

  await test.step('the owner ends the meeting; the room stays with its settings', async () => {
    await toolbarButton(page, strings.toolbar.leave).click()
    await page
      .getByRole('dialog', { name: strings.leave.title })
      .getByRole('button', { name: strings.leave.endForAll })
      .click()
    await expect(page.getByRole('heading', { name: strings.left.endedSelfTitle })).toBeVisible()
    await expect(guest.page.getByRole('heading', { name: strings.left.endedTitle })).toBeVisible()
    // A persistent room can be joined again: the guest is asked for the password once more
    await guest.page.getByRole('button', { name: strings.left.rejoin }).click()
    await expect(guest.page.getByLabel(strings.prejoin.passwordLabel, { exact: true })).toBeVisible()
    const summary = await guest.page.request.get(`/api/rooms/${SLUG}`)
    expect(await summary.json()).toMatchObject({
      name: 'E2E 固定房',
      persistent: true,
      memberCount: 0,
      viewer: null,
    })
    expect((await summary.json()).passwordSetAt).not.toBeNull()
    // The settings too (L5), and none of the meeting's poll, countdown or agenda
    const kept = await summary.json()
    expect(kept).toMatchObject({
      startMuted: true,
      allowAnnotation: false,
      allowRecording: false,
      annotationPolicy: 'off',
    })
    expect(JSON.stringify(kept)).not.toContain('午餐')
  })

  await test.step('the owner comes back as host, then deletes the room and the account', async () => {
    await page.getByRole('button', { name: strings.left.rejoin }).click()
    await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
    await expectRole(page, 1, OWNER, strings.participants.host)
    await toolbarButton(page, strings.toolbar.leave).click()
    await page.goto('/me')
    await page.getByRole('button', { name: strings.account.deleteRoomLabel(SLUG) }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: strings.account.deleteRoom }).click()
    await expect(page.getByText(strings.account.noRooms)).toBeVisible()
    expect((await guest.page.request.get(`/api/rooms/${SLUG}`)).status()).toBe(404)
    await page.getByRole('button', { name: strings.account.deleteAccount }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: strings.account.deleteAccount }).click()
    await expect(page.getByRole('button', { name: strings.account.signIn })).toBeVisible()
    expect((await page.request.get('/api/account')).status()).toBe(401)
  })

  await guest.context.close()
  await owner.context.close()
})

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

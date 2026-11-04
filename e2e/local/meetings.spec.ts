import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { strings } from './helpers.ts'

// I3 (e1-t14, AC-1.7): a scheduled meeting from start to finish against vite preview with the
// local D1 database (npx wrangler d1 migrations apply longtalk --local first). The owner signs up
// with Chromium's virtual authenticator, makes a persistent room and schedules a meeting in it
// starting in a few minutes (the browser is in Asia/Taipei). Someone with no account, in another
// zone, opens /m/<id>: the title, the organizer's name and both times, the .ics (downloaded and
// read back: UTC times, the UID, the page as URL) and the calendar links; then joins the room.

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

/** The date and time inputs' values for `at` in Asia/Taipei (the owner's browser) */
function taipeiInputs(at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

/** RFC 5545: unfolded content lines as NAME → VALUE */
function readIcs(text: string): Map<string, string> {
  const props = new Map<string, string>()
  for (const line of text.replace(/\r\n /g, '').split('\r\n')) {
    const at = line.indexOf(':')
    if (at > 0 && !props.has(line.slice(0, at))) props.set(line.slice(0, at), line.slice(at + 1))
  }
  return props
}

const SLUG = `meet-${Date.now().toString(36)}`
const TITLE = 'E2E 預定會議'

test('schedule a meeting, open its page anonymously, download the .ics and join (I3)', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)
  await virtualAuthenticator(page)
  // Five minutes from now, on a whole minute: inside the join window already
  const start = Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000

  await test.step('sign up, make a persistent room, schedule a meeting in it', async () => {
    await page.goto('/me')
    await page.getByRole('textbox', { name: strings.account.nameLabel }).fill('Organizer Olive')
    await page.getByRole('button', { name: strings.account.signUp }).click()
    await expect(page.getByText(strings.account.signedInAs('Organizer Olive'))).toBeVisible()
    await page.getByRole('textbox', { name: strings.account.slugLabel }).fill(SLUG)
    await page.getByRole('button', { name: strings.account.createRoom }).click()
    const section = page.getByRole('region', { name: strings.meetings.title })
    await section.getByRole('button', { name: strings.meetings.create }).click()
    const form = section.getByRole('form', { name: strings.meetings.newTitle })
    await expect(form.getByText(/Asia\/Taipei/)).toBeVisible()
    await form.getByRole('textbox', { name: strings.meetings.titleLabel }).fill(TITLE)
    await form.getByLabel(strings.meetings.descriptionLabel).fill('議程：一、進度；二、計畫')
    const { date, time } = taipeiInputs(start)
    await form.getByLabel(strings.meetings.dateLabel).fill(date)
    await form.getByLabel(strings.meetings.timeLabel).fill(time)
    await form.getByRole('combobox', { name: strings.meetings.durationLabel }).selectOption('30')
    await form.getByRole('button', { name: strings.meetings.save }).click()
    await expect(page.getByText(strings.meetings.saved)).toBeVisible()
    await expect(section.getByText(TITLE)).toBeVisible()
  })

  const pageLink = await page.getByRole('link', { name: strings.meetings.openPage }).getAttribute('href')
  expect(pageLink).toMatch(/^\/m\/[A-Za-z0-9_-]{22}$/)
  const id = pageLink!.slice(3)

  const guest = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Europe/London' })
  const visitor = await guest.newPage()

  await test.step('anyone with the link sees the meeting, the organizer’s name and both times', async () => {
    await visitor.goto(pageLink!)
    await expect(visitor.getByRole('heading', { level: 1, name: TITLE })).toBeVisible()
    await expect(visitor.getByText(strings.meetings.page.organizer('Organizer Olive'))).toBeVisible()
    await expect(visitor.getByText(/GMT\+8/)).toBeVisible()
    await expect(visitor.getByRole('heading', { name: /^你的時間：.*GMT/ })).toBeVisible()
    await expect(visitor.getByText(/後開始$/)).toBeVisible()
    // Only the display name: the account's id is nowhere in the answer
    const body = await (await visitor.request.get(`/api/meetings/${id}`)).json()
    expect(Object.keys(body).sort()).toEqual(
      ['description', 'durationMin', 'id', 'joinFrom', 'organizer', 'room', 'sequence', 'startsAt', 'timeZone', 'title', 'updatedAt'].sort(),
    )
    const google = visitor.getByRole('link', { name: strings.meetings.newTab(strings.meetings.google) })
    await expect(google).toHaveAttribute('target', '_blank')
    await expect(google).toHaveAttribute('rel', 'noopener noreferrer')
    expect(new URL((await google.getAttribute('href'))!).searchParams.get('text')).toBe(TITLE)
  })

  await test.step('the .ics downloads and reads back', async () => {
    const [download] = await Promise.all([
      visitor.waitForEvent('download'),
      visitor.getByRole('button', { name: strings.meetings.downloadIcs }).click(),
    ])
    expect(download.suggestedFilename()).toBe(`${TITLE}.ics`)
    const text = await readFile((await download.path())!, 'utf8')
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    const ics = readIcs(text)
    expect(ics.get('UID')).toBe(`${id}@${new URL(visitor.url()).host}`)
    expect(ics.get('DTSTART')).toBe(new Date(start).toISOString().replace(/[-:]/g, '').replace('.000', ''))
    expect(ics.get('DTEND')).toBe(
      new Date(start + 30 * 60_000).toISOString().replace(/[-:]/g, '').replace('.000', ''),
    )
    expect(ics.get('SUMMARY')).toBe(TITLE)
    expect(ics.get('URL')).toBe(new URL(pageLink!, visitor.url()).href)
    expect(ics.get('DESCRIPTION')).toContain('議程：一、進度；二、計畫')
  })

  await test.step('joins the room from the page', async () => {
    await visitor.getByRole('link', { name: strings.meetings.page.join }).click()
    await expect(visitor).toHaveURL(new RegExp(`/r/${SLUG}$`))
    await visitor.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Guest Gus')
    await visitor.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
    await expect(visitor.getByRole('region', { name: strings.room.grid })).toBeVisible()
  })

  await test.step('deleting the account takes the meeting with it', async () => {
    await page.getByRole('button', { name: strings.account.deleteAccount }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: strings.account.deleteAccount }).click()
    await expect(page.getByRole('button', { name: strings.account.signIn })).toBeVisible()
    expect((await visitor.request.get(`/api/meetings/${id}`)).status()).toBe(404)
  })
  await guest.close()
})

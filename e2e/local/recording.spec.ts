import { readFileSync, statSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Download, type Page } from '@playwright/test'
import { joinRoom, newRoom, openPreJoin, secondMember, strings } from './helpers.ts'

// Local recording (I4: e8-t01 – e8-t03, AC-8.1, AC-8.2) against the built app in `vite preview`
// with headless Chromium's fake camera and microphone (no Realtime SFU here: the recording has
// our own camera and the others' initials). The host records; everyone else sees the red light
// and the notice; someone about to join sees the pre-join notice; stopping downloads a non-empty
// WebM; a member the host allowed records and the host stops it (their file downloads); a
// recording cut off by a reload is offered again (下載上次未完成的錄影).

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const more = (page: Page) =>
  page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name: strings.toolbar.more, exact: true })

/** 更多 › 開始錄影… › 開始錄影 */
async function startRecording(page: Page) {
  await more(page).click()
  await page.getByRole('menuitem', { name: strings.record.start }).click()
  const dialog = page.getByRole('dialog', { name: strings.record.dialogTitle })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(strings.record.format('video/webm'))).toBeVisible()
  await dialog.getByRole('button', { name: strings.record.confirm }).click()
  await expect(
    page.getByRole('button', { name: strings.record.stopLabel(strings.record.byYou) }),
  ).toBeVisible()
}

/**
 * The downloaded file is a WebM with something in it that a browser plays: 1280 × 720, with a
 * length (MediaRecorder leaves it out; src/record/webmDuration.ts adds it) of at least `seconds`
 */
async function expectRecording(page: Page, download: Download, seconds: number) {
  expect(download.suggestedFilename()).toMatch(/^LongTalk .+ \d{4}-\d\d-\d\d \d\d-\d\d\.webm$/)
  const path = await download.path()
  expect(statSync(path).size).toBeGreaterThan(10_000)
  const file = readFileSync(path)
  // WebM starts with the EBML magic number
  expect(file.subarray(0, 4).toString('hex')).toBe('1a45dfa3')
  if (process.env.RECORDING_SAVE_TO) await download.saveAs(process.env.RECORDING_SAVE_TO)
  // Played in a blank page of its own (no CSP there)
  const viewer = await page.context().newPage()
  await viewer.setContent('<video muted></video>')
  const played = await viewer.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const video = document.querySelector('video')!
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }))
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = reject
    })
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration }
  }, file.toString('base64'))
  await viewer.close()
  expect(played).toMatchObject({ width: 1280, height: 720 })
  expect(Number.isFinite(played.duration)).toBe(true)
  expect(played.duration).toBeGreaterThan(seconds)
}

test('the host records; everyone is told; stopping downloads the file', async ({
  page,
  browser,
}) => {
  const path = await newRoom(page)
  await joinRoom(page, path, 'Gene')
  const bob = await secondMember(browser, path, 'Bob')
  await expect(bob.page.getByRole('figure', { name: /Gene/ })).toBeVisible()

  await startRecording(page)
  // Bob: the red light with who records, and the notice with 離開會議
  await expect(bob.page.getByRole('img', { name: strings.record.byOne('Gene') })).toBeVisible()
  const notice = bob.page.getByRole('alert').filter({ hasText: strings.record.consent('Gene') })
  await expect(notice).toBeVisible()
  await expect(notice.getByRole('button', { name: strings.record.consentLeave })).toBeVisible()
  // The light and the notice pass axe (WCAG 2.2 AA), like every other screen (a11y.spec.ts)
  const axe = await new AxeBuilder({ page: bob.page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  expect(axe.violations.map((violation) => violation.id)).toEqual([])
  await notice.getByRole('button', { name: strings.record.consentOk }).click()
  await expect(notice).toHaveCount(0)

  // Someone about to join is told before joining
  const cleo = await browser.newContext()
  const cleoPage = await cleo.newPage()
  await openPreJoin(cleoPage, path)
  await expect(cleoPage.getByText(strings.record.prejoinTitle)).toBeVisible()
  await expect(cleoPage.getByRole('button', { name: strings.record.prejoinLeave })).toBeVisible()
  await cleo.close()

  // A few chunks (RECORDER_TIMESLICE_MS is 4 s), then stop: the file downloads
  await page.waitForTimeout(9_000)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: strings.record.stopLabel(strings.record.byYou) }).click()
  await expectRecording(page, await download, 8)
  await expect(page.getByText(/^錄影已停止，已下載「LongTalk /)).toBeVisible()
  // The light goes out for everyone
  await expect(bob.page.getByRole('img', { name: strings.record.byOne('Gene') })).toHaveCount(0)
  await expect(bob.page.getByText(strings.record.othersStopped('Gene'))).toBeVisible()
  await bob.context.close()
})

test('a member the host allowed records, and the host stops it: their file downloads', async ({
  page,
  browser,
}) => {
  const path = await newRoom(page)
  await joinRoom(page, path, 'Gene')
  const bob = await secondMember(browser, path, 'Bob')
  // Bob may not record yet: no 開始錄影 in his 更多
  await more(bob.page).click()
  await expect(bob.page.getByRole('menuitem', { name: strings.record.start })).toHaveCount(0)
  await bob.page.keyboard.press('Escape')

  await page.getByRole('button', { name: /^參與者/ }).click()
  await page.getByRole('button', { name: strings.participants.actions('Bob') }).click()
  await page.getByRole('menuitem', { name: strings.record.allow }).click()
  await expect(bob.page.getByText(/允許你錄影/)).toBeVisible()

  await startRecording(bob.page)
  await expect(page.getByRole('img', { name: strings.record.byOne('Bob') })).toBeVisible()
  await bob.page.waitForTimeout(5_000)
  const download = bob.page.waitForEvent('download')
  await page.getByRole('button', { name: strings.participants.actions('Bob') }).click()
  await page.getByRole('menuitem', { name: strings.record.stopTheirs }).click()
  await expectRecording(bob.page, await download, 4)
  await expect(bob.page.getByText(/停止了你的錄影/)).toBeVisible()
  await expect(page.getByRole('img', { name: strings.record.byOne('Bob') })).toHaveCount(0)
  await bob.context.close()
})

test('a recording cut off by a reload is offered again and downloads', async ({ page }) => {
  const path = await newRoom(page)
  await joinRoom(page, path, 'Gene')
  await startRecording(page)
  await page.waitForTimeout(9_000)
  // Leaving with a recording asks first (beforeunload): yes
  page.on('dialog', (dialog) => void dialog.accept())
  await page.reload()
  // Back in the room as the same member: the room no longer lists us as recording
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  await expect(
    page.getByRole('button', { name: strings.record.stopLabel(strings.record.byYou) }),
  ).toHaveCount(0)
  const offer = page.getByRole('button', { name: strings.record.leftoverDownload })
  await expect(offer).toBeVisible()
  const download = page.waitForEvent('download')
  await offer.click()
  // As long as the chunks it wrote (one every 4 s)
  await expectRecording(page, await download, 3)
  await expect(page.getByText(strings.record.leftoverDownloaded)).toBeVisible()
  await expect(offer).toHaveCount(0)
})

import { expect, type Browser, type Page } from '@playwright/test'
import { zhTW as strings } from '../src/i18n/zh-TW.ts'

// L1 (e2-t18, e10-t01, AC-10.1) through the real Realtime SFU: a member on a phone-sized screen
// (four tiles a page) receives only the cameras of the page in view; the next page's arrive when
// it is turned to, and the ones left behind are unsubscribed after the grace. The other members
// are muted and "in a background tab" (they publish and subscribe to no camera), so that the one
// machine decodes what is being tested and nothing else.

const VIDEO_WAIT_MS = 20_000
/** UNSEEN_GRACE_MS and a margin for a busy CI runner */
const GRACE_WAIT_MS = 25_000

async function join(
  browser: Browser,
  url: string,
  name: string,
  options: { hidden: boolean; viewport?: { width: number; height: number } },
): Promise<Page> {
  const context = await browser.newContext({
    locale: 'zh-TW',
    permissions: ['camera', 'microphone'],
    viewport: options.viewport,
  })
  await context.addInitScript((hidden) => {
    if (hidden) {
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'hidden' })
      Object.defineProperty(Document.prototype, 'hidden', { get: () => true })
    }
    const Native = window.RTCPeerConnection
    const pcs: RTCPeerConnection[] = []
    ;(window as unknown as { pcs: RTCPeerConnection[] }).pcs = pcs
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config)
        pcs.push(this)
      }
    }
  }, options.hidden)
  const page = await context.newPage()
  await page.goto(url)
  await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill(name)
  await page.getByRole('button', { name: strings.prejoin.join, exact: true }).click()
  await expect(page.getByRole('region', { name: strings.room.grid })).toBeVisible()
  return page
}

/** Cameras this browser receives now: the PeerConnection's live video receivers */
const receivedVideos = (page: Page) =>
  page.evaluate(() => {
    const { pcs } = window as unknown as { pcs: RTCPeerConnection[] }
    return pcs
      .at(-1)!
      .getTransceivers()
      .filter((t) => t.currentDirection === 'recvonly' && t.receiver.track.kind === 'video').length
  })

/** Everyone on the page in view shows a decoded picture */
const pageHasPictures = (page: Page, expected: number) =>
  expect
    .poll(
      () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLVideoElement>('[data-visible] video')].filter(
              (video) => video.videoWidth > 0,
            ).length,
        ),
      { timeout: VIDEO_WAIT_MS },
    )
    .toBeGreaterThanOrEqual(expected)

/**
 * Run from a test that already has a room (`url`), left empty: every room made on a preview counts
 * against I1's limit for the network, and the e2e suite is at it (shared/abuse.ts ROOM_CREATE_LIMITS)
 */
export async function receivesOnlyWhatIsInView(browser: Browser, url: string): Promise<void> {
  const phone = await join(browser, url, 'Zoe', {
    hidden: false,
    viewport: { width: 390, height: 844 },
  })
  const members = [phone]
  for (const name of ['B1', 'B2', 'B3', 'B4', 'B5']) {
    const bot = await join(browser, url, name, { hidden: true })
    await bot.keyboard.press('m')
    members.push(bot)
  }
  const pager = phone.getByRole('region', { name: strings.room.grid })
  await expect(pager).toHaveAttribute('data-pages', '2')

  // Page 1: ourselves and three others (our own picture is one of the videos)
  await pageHasPictures(phone, 4)
  await expect.poll(() => receivedVideos(phone), { timeout: GRACE_WAIT_MS }).toBeLessThan(5)

  // Page 2: the other two arrive, and the first page stays for its grace
  await phone.getByRole('button', { name: strings.stage.page(2, 2) }).click()
  await pageHasPictures(phone, 2)
  // (A camera kept as the speaker may be on either page, so not exactly five yet)
  expect(await receivedVideos(phone)).toBeGreaterThanOrEqual(4)

  // After the grace the first page goes, but for whoever is kept as the speaker
  await expect.poll(() => receivedVideos(phone), { timeout: GRACE_WAIT_MS }).toBeLessThan(5)

  // And comes back
  await phone.getByRole('button', { name: strings.stage.page(1, 2) }).click()
  await pageHasPictures(phone, 4)
  await Promise.all(members.map((member) => member.context().close()))
}

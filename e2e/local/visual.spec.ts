import { expect, test, type Page } from '@playwright/test'
import { joinRoom, newRoom, openPreJoin, strings, viewports, type ViewportName } from './helpers.ts'

// G5 (e4-t17, AC-4.10): home, pre-join and room × light / dark × desktop / phone, against the
// baselines in e2e/local/__screenshots__. Made deterministic: the camera is a still frame and the
// microphone silence (fakeMedia.ts), fixed names, animations off, and what changes on its own is
// masked (the room code, the meeting clock). The room is dark in both schemes (DESIGN.md §1.2):
// its light shot checks that it stays dark.
//
// The baselines are Linux ones from the Playwright Docker image (ui.yml, DEPLOY.md §7); other
// systems render text differently, so the tests run only there unless VISUAL=1.
test.skip(
  process.platform !== 'linux' && !process.env.VISUAL,
  'Visual baselines are made on Linux in the Playwright image (DEPLOY.md §7)',
)

/** Waits for fonts, a drawn video frame and the end of every finite animation */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('video')].every((video) => video.readyState >= 2),
  )
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  )
  // The caret and the focus ring are not what is being compared
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

for (const viewport of Object.keys(viewports) as ViewportName[]) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${viewport} ${scheme}`, () => {
      test.use({ ...viewports[viewport], colorScheme: scheme, reducedMotion: 'reduce' })

      test('home', async ({ page }) => {
        await page.goto('/')
        await expect(page.getByRole('heading', { name: strings.tagline })).toBeVisible()
        await settle(page)
        await expect(page).toHaveScreenshot(`home-${viewport}-${scheme}.png`, { fullPage: true })
      })

      test('pre-join', async ({ page }) => {
        const path = await newRoom(page)
        await openPreJoin(page, path)
        await page.getByRole('textbox', { name: strings.prejoin.nameLabel }).fill('Ada')
        // The silent microphone's hint comes after 6 s: wait for it, so it is always there
        await expect(page.getByText(strings.prejoin.micSilent)).toBeVisible({ timeout: 15_000 })
        await settle(page)
        await expect(page).toHaveScreenshot(`prejoin-${viewport}-${scheme}.png`, {
          fullPage: true,
          // The room's code is new every time; the fake camera is named after its file's path
          mask: [
            page.getByText(strings.prejoin.roomCode(path.slice(3))),
            page.getByRole('combobox', { name: strings.prejoin.camLabel }),
          ],
        })
      })

      test('room', async ({ page }) => {
        const path = await newRoom(page)
        await joinRoom(page, path, 'Ada')
        // No Realtime SFU in these runs: the room says so, the same way every time
        await expect(page.getByRole('alert').first()).toBeVisible()
        await settle(page)
        await expect(page).toHaveScreenshot(`room-${viewport}-${scheme}.png`, {
          mask: [page.getByText(/^\d{2}:\d{2}:\d{2}$/)],
        })
      })
    })
  }
}

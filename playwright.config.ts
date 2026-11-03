import { defineConfig } from '@playwright/test'
import { chromiumFakeMedia, firefoxFakeMedia } from './e2e/fakeDevices.ts'

/**
 * End-to-end interop test (e2-t10, AC-2.2): three Chromium browsers with Chrome's fake camera and
 * microphone meet in one room on a deployed Worker, so the media goes through the real Realtime
 * SFU. CI runs it against the pull request's preview Worker (preview.yml, job `e2e`).
 *
 *   BASE_URL=https://longtalk-pr-<n>.genelee-pro.workers.dev npm run test:e2e
 *
 * The deployment needs REALTIME_APP_ID / REALTIME_APP_SECRET (DEPLOY.md §5); without them every
 * SFU call answers 503 and the test fails at "remote video". Locally, `PW_CHANNEL=chrome` uses the
 * installed Chrome instead of Playwright's Chromium (`npx playwright install chromium`).
 *
 * Two projects: `chromium` (the interop test, the language and PWA checks) and `firefox` (H6,
 * e2-t16: e2e/crossbrowser.spec.ts, a Firefox and a Chromium in one room; CI job `e2e-firefox`).
 * `npm run test:e2e` runs both (`npx playwright install chromium firefox`); pick one with
 * `-- --project=chromium`.
 */
const baseURL = process.env.BASE_URL
if (!baseURL) {
  throw new Error('Set BASE_URL to a deployed LongTalk with the Realtime SFU (DEPLOY.md §7)')
}

export default defineConfig({
  testDir: 'e2e',
  // e2e/local runs without a deployment (playwright.local.config.ts)
  testIgnore: 'local/**',
  forbidOnly: !!process.env.CI,
  // One retry absorbs a cold Durable Object or SFU hiccup; a second failure is a real failure
  retries: process.env.CI ? 1 : 0,
  // The members share one room: never run tests side by side against the same preview
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    locale: 'zh-TW',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['local/**', 'crossbrowser.spec.ts'],
      use: {
        browserName: 'chromium',
        channel: process.env.PW_CHANNEL || undefined,
        permissions: ['camera', 'microphone'],
        launchOptions: { args: chromiumFakeMedia },
      },
    },
    {
      name: 'firefox',
      testMatch: 'crossbrowser.spec.ts',
      use: {
        browserName: 'firefox',
        launchOptions: { firefoxUserPrefs: firefoxFakeMedia },
      },
    },
  ],
})

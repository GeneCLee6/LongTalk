import { defineConfig } from '@playwright/test'

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
 */
const baseURL = process.env.BASE_URL
if (!baseURL) {
  throw new Error('Set BASE_URL to a deployed LongTalk with the Realtime SFU (DEPLOY.md §7)')
}

export default defineConfig({
  testDir: 'e2e',
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
    browserName: 'chromium',
    channel: process.env.PW_CHANNEL || undefined,
    locale: 'zh-TW',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
})

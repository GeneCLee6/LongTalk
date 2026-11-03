import { defineConfig, devices } from '@playwright/test'
import { chromiumFakeMedia, firefoxFakeMedia } from './e2e/fakeDevices.ts'
import { fakeMediaFiles } from './e2e/local/fakeMedia.ts'

/**
 * Checks that need no deployment (G5, e4-t14, e4-t17; DEPLOY.md §7): accessibility (axe-core on
 * every screen, keyboard paths) and visual regression (home, pre-join and room × light / dark ×
 * desktop / phone). They run against `vite preview`, which serves the built app with the Worker
 * and its Durable Objects in workerd, so rooms work; there is no Realtime SFU (the room says so),
 * and the camera and microphone are Chrome's fakes fed a still frame and silence (fakeMedia.ts).
 *
 *   npm run build && npm run test:ui
 *
 * CI runs them in the Playwright Docker image (ui.yml), and the visual baselines in
 * e2e/local/__screenshots__ are made there: fonts and rendering differ between systems, so the
 * visual tests are skipped elsewhere unless VISUAL=1 (DEPLOY.md §7 has how to update them).
 *
 * The cross-browser smoke suite (H6, e2-t16; e2e/local/browsers.spec.ts) also runs in Firefox
 * (its fake camera and microphone, from prefs) and WebKit (Playwright's build of Safari's engine;
 * camera and microphone where that build has them):
 *
 *   npx playwright install firefox webkit   # once
 *   npm run build && npm run test:browsers
 */
const media = fakeMediaFiles()
const port = 4173

export default defineConfig({
  testDir: 'e2e/local',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.001 },
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    // No service worker: an update prompt must never appear in a screenshot
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // Everything: accessibility, visual, noise suppression and the cross-browser suite
      name: 'chromium',
      use: {
        browserName: 'chromium',
        permissions: ['camera', 'microphone'],
        launchOptions: {
          args: [
            ...chromiumFakeMedia,
            `--use-file-for-fake-video-capture=${media.video}`,
            `--use-file-for-fake-audio-capture=${media.audio}`,
            // The same text rendering on every machine of one kind
            '--font-render-hinting=none',
            '--disable-lcd-text',
          ],
        },
      },
    },
    {
      name: 'firefox',
      testMatch: 'browsers.spec.ts',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 800 },
        // Playwright cannot grant camera or microphone in Firefox: its prefs do instead
        launchOptions: { firefoxUserPrefs: firefoxFakeMedia },
      },
    },
    {
      name: 'webkit',
      testMatch: 'browsers.spec.ts',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1280, height: 800 },
        permissions: ['camera', 'microphone'],
      },
    },
  ],
})

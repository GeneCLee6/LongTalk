import { expect, test } from '@playwright/test'
import { joinRoom, newRoom, strings } from './helpers.ts'

// 進階噪音抑制 (H4, e6-t02) in a real Chromium, without a deployment: the worklet and RNNoise's
// wasm load only when it is turned on, from our own /assets/, and it runs (no failure notice,
// not stuck loading). That audio still reaches the others through it is the interop test's
// (e2e/interop.spec.ts, needs the SFU).

test('advanced noise suppression loads lazily from our own assets and runs', async ({ page }) => {
  // What the page fetched of it: same-origin paths (the worklet's addModule and the wasm)
  const loaded = () =>
    page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => new URL(entry.name))
        .filter((url) => url.pathname.includes('rnnoise') || url.pathname.includes('noise'))
        .map((url) => `${url.origin === location.origin}:${url.pathname}`),
    )
  const path = await newRoom(page)
  await joinRoom(page, path, 'Ada')
  // Nothing of it in the room until it is turned on
  expect(await loaded()).toEqual([])

  const toolbar = page.getByRole('toolbar', { name: strings.devices.controls })
  await toolbar.getByRole('button', { name: strings.toolbar.more, exact: true }).click()
  await page.getByRole('menuitem', { name: strings.settings.menu }).click()
  const settings = page.getByRole('dialog', { name: strings.settings.title })
  const advanced = settings.getByRole('switch', { name: strings.settings.advancedNoise })
  await expect(advanced).not.toBeChecked()
  const browserNs = settings.getByRole('switch', {
    name: strings.settings.noiseSuppression,
    exact: true,
  })
  await expect(browserNs).toBeEnabled()

  await advanced.check()
  // The browser's own noise suppression pauses while RNNoise handles it
  await expect(browserNs).toBeDisabled()
  await expect(settings.getByText(strings.settings.advancedNoiseHandles)).toBeVisible()
  // Loaded, and running: no loading note left, no failure
  await expect(settings.getByText(strings.settings.advancedNoiseLoading)).toHaveCount(0)
  await expect(settings.getByText(strings.settings.advancedNoisePaused)).toHaveCount(0)
  await page.waitForTimeout(6_000)
  await expect(page.getByText(strings.settings.advancedNoiseFailed)).toHaveCount(0)
  await expect(page.getByText(strings.settings.advancedNoiseOverloaded)).toHaveCount(0)
  await expect(advanced).toBeChecked()
  const files = await loaded()
  expect(files.some((entry) => /^true:\/assets\/rnnoise(_simd)?-.*\.wasm$/.test(entry))).toBe(true)
  expect(files.every((entry) => entry.startsWith('true:'))).toBe(true)

  // 省電模式 holds it off (the choice stays) and gives the browser's back
  await settings.getByRole('tab', { name: strings.settings.performance }).click()
  await settings.getByRole('switch', { name: strings.settings.powerSaving }).check()
  await settings.getByRole('tab', { name: strings.settings.audio }).click()
  await expect(advanced).toBeChecked()
  await expect(settings.getByText(strings.settings.advancedNoisePowerSaving)).toBeVisible()
  await expect(browserNs).toBeEnabled()
  // and motion is off in the room
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off')
})

import { expect, test } from '@playwright/test'
import { joinRoom, newRoom, secondMember, strings } from './helpers.ts'

// Memory over a long local recording (I4, e8-t01, AC-8.1 「一小時錄影記憶體穩定」): a scripted
// run, not part of CI. Two members in headless Chromium (fake cameras, no SFU), the host records
// for RECORDING_SOAK_MINUTES, and every minute the page's JS heap (after a forced GC), its DOM
// counters and the IndexedDB usage are logged; at the end the heap must not have grown with the
// recording (the chunks go to IndexedDB, nothing piles up in memory).
//
//   npm run build
//   RECORDING_SOAK_MINUTES=15 npx playwright test -c playwright.local.config.ts recording-soak
//
// The full hour on a real computer is the owner's check (DEPLOY.md §5).

const minutes = Number(process.env.RECORDING_SOAK_MINUTES ?? 0)

test.skip(!(minutes > 0), 'set RECORDING_SOAK_MINUTES to run the memory soak')

test('a long recording keeps the heap flat', async ({ page, browser }) => {
  test.setTimeout((minutes + 3) * 60_000)
  const path = await newRoom(page)
  await joinRoom(page, path, 'Gene')
  const bob = await secondMember(browser, path, 'Bob')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.enable')
  const sample = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
    const dom = (await cdp.send('Memory.getDOMCounters')) as {
      documents: number
      nodes: number
      jsEventListeners: number
    }
    const storage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0)
    return { heapMB: heap.usedSize / 2 ** 20, ...dom, storageMB: storage / 2 ** 20 }
  }

  const before = await sample()
  await page
    .getByRole('toolbar', { name: strings.devices.controls })
    .getByRole('button', { name: strings.toolbar.more, exact: true })
    .click()
  await page.getByRole('menuitem', { name: strings.record.start }).click()
  await page
    .getByRole('dialog', { name: strings.record.dialogTitle })
    .getByRole('button', { name: strings.record.confirm })
    .click()
  const stop = page.getByRole('button', { name: strings.record.stopLabel(strings.record.byYou) })
  await expect(stop).toBeVisible()

  const samples = [{ minute: 0, ...(await sample()) }]
  for (let minute = 1; minute <= minutes; minute++) {
    await page.waitForTimeout(60_000)
    samples.push({ minute, ...(await sample()) })
    const last = samples.at(-1)!
    console.log(
      `minute ${minute}: heap ${last.heapMB.toFixed(1)} MB, nodes ${last.nodes}, ` +
        `listeners ${last.jsEventListeners}, IndexedDB ${last.storageMB.toFixed(1)} MB`,
    )
  }
  const download = page.waitForEvent('download')
  await stop.click()
  const file = await download
  const after = await sample()
  console.log(JSON.stringify({ before, samples, after, file: file.suggestedFilename() }, null, 2))
  // After the first minute's warm-up the heap stays within a few MB while the file grows
  const warm = samples[1] ?? samples[0]
  const peak = Math.max(...samples.slice(1).map((s) => s.heapMB))
  expect(peak - warm.heapMB).toBeLessThan(15)
  expect(samples.at(-1)!.nodes - warm.nodes).toBeLessThan(200)
  expect(samples.at(-1)!.storageMB).toBeGreaterThan(samples[1]?.storageMB ?? 0)
  await bob.context.close()
})

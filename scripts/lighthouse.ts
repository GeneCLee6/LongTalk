// Lighthouse's accessibility score on the three screens, desktop and phone (G5, e4-t14, AC-4.9):
// each must be at least 0.95. Runs against a LongTalk that is already up (default: `vite preview`
// on :4173, as the UI job in .github/workflows/ui.yml starts it):
//
//   npm run build && npx vite preview --port 4173 &   then   npm run lighthouse
//   BASE_URL=https://longtalk-pr-<n>.genelee-pro.workers.dev npm run lighthouse
//
// Chromium is Playwright's (`npx playwright install chromium`), driven by puppeteer-core as
// Lighthouse wants, with Chrome's fake camera and microphone. Home and pre-join are Lighthouse
// navigations; the room is a snapshot after joining through the pre-join screen. Reports go to
// lighthouse-report/ (HTML, uploaded by CI); a summary to stdout and $GITHUB_STEP_SUMMARY.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import lighthouse, { generateReport, snapshot } from 'lighthouse'
import puppeteer, { type Page } from 'puppeteer-core'
import { zhTW as strings } from '../src/i18n/zh-TW.ts'

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:4173').replace(/\/$/, '')
const MIN_SCORE = 0.95
const OUT = 'lighthouse-report'

type FormFactor = 'desktop' | 'mobile'

const screens: Record<FormFactor, { mobile: boolean; width: number; height: number }> = {
  desktop: { mobile: false, width: 1350, height: 940 },
  mobile: { mobile: true, width: 390, height: 844 },
}

function flags(formFactor: FormFactor) {
  const screen = screens[formFactor]
  return {
    onlyCategories: ['accessibility'],
    formFactor,
    screenEmulation: { ...screen, deviceScaleFactor: screen.mobile ? 2 : 1, disabled: false },
    // Only accessibility is scored: no throttling to wait through
    throttlingMethod: 'provided' as const,
    locale: 'zh-TW' as const,
  }
}

interface Result {
  name: string
  score: number
  failing: string[]
}

type LighthouseResult = Awaited<ReturnType<typeof snapshot>>

function collect(name: string, result: LighthouseResult): Result {
  if (!result) throw new Error(`Lighthouse returned nothing for ${name}`)
  const { lhr } = result
  const category = lhr.categories.accessibility
  const failing = category.auditRefs
    .filter((ref) => ref.weight > 0 && (lhr.audits[ref.id]?.score ?? 1) < 1)
    .map((ref) => `${ref.id}: ${lhr.audits[ref.id]?.title}`)
  const file = join(OUT, `${name.replace(/[^a-z0-9]+/gi, '-')}.html`)
  writeFileSync(file, generateReport(lhr, 'html'))
  return { name, score: category.score ?? 0, failing }
}

async function newRoom(): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' })
  if (!response.ok) throw new Error(`POST /api/rooms answered ${response.status}`)
  const { id } = (await response.json()) as { id: string }
  return `${BASE_URL}/r/${id}`
}

/** Joins through the pre-join screen, as a person would */
async function enterRoom(page: Page, url: string, name: string) {
  await page.goto(url)
  const field = await page.waitForSelector(
    `::-p-aria([name="${strings.prejoin.nameLabel}"][role="textbox"])`,
  )
  await field?.type(name)
  const button = await page.waitForSelector(
    `::-p-aria([name="${strings.prejoin.join}"][role="button"])`,
  )
  await button?.click()
  await page.waitForSelector(`::-p-aria([name="${strings.room.grid}"][role="region"])`)
  // Let the stage, the toolbar and the first notices settle
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--lang=zh-TW',
      // The CI container runs as root
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
  })
  const results: Result[] = []
  try {
    for (const formFactor of ['desktop', 'mobile'] as const) {
      const page = await browser.newPage()
      // The interface in Traditional Chinese whatever the machine's language (the CI image is
      // English): the dictionary's choice is read from localStorage on every new page
      await page.evaluateOnNewDocument(() => localStorage.setItem('longtalk.locale', 'zh-TW'))
      const options = { flags: flags(formFactor) }
      results.push(
        collect(
          `home ${formFactor}`,
          await lighthouse(`${BASE_URL}/`, options.flags, undefined, page),
        ),
      )
      const room = await newRoom()
      results.push(
        collect(`pre-join ${formFactor}`, await lighthouse(room, options.flags, undefined, page)),
      )
      // The room: the same emulated screen, then a snapshot of the page as it is
      await enterRoom(page, room, 'Ada')
      results.push(collect(`room ${formFactor}`, await snapshot(page, options)))
      await page.close()
    }
  } finally {
    await browser.close()
  }

  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.score.toFixed(2)} | ${r.score >= MIN_SCORE ? 'ok' : 'FAIL'} | ${r.failing.join('<br>') || '—'} |`,
  )
  const summary = [
    `### Lighthouse accessibility (minimum ${MIN_SCORE})`,
    '',
    '| Screen | Score | | Audits not passed |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  const low = results.filter((r) => r.score < MIN_SCORE)
  if (low.length > 0) {
    console.error(`Below ${MIN_SCORE}: ${low.map((r) => r.name).join(', ')}`)
    process.exit(1)
  }
}

await main()

// The cross-browser suite's report (H6, e2-t16): what LongTalk detected in each browser the suite
// ran (browser-report/<project>-capabilities.json, written by e2e/local/browsers.spec.ts), as one
// Markdown table for the CI run's summary (ui.yml, job `browsers`). ✓ detected, ✕ not, and *
// where the suite did not hold it against docs/BROWSER-SUPPORT.md (a known engine difference).
//
//   node --experimental-strip-types scripts/browser-report.ts >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

interface Report {
  project: string
  version: string
  userAgent: string
  column: string
  detected: Record<string, boolean>
  skipped: Record<string, string>
}

const dir = 'browser-report'
const reports: Report[] = existsSync(dir)
  ? readdirSync(dir)
      .filter((name) => name.endsWith('-capabilities.json'))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Report)
  : []

if (reports.length === 0) {
  console.log('No cross-browser report (the suite did not get to detection).')
} else {
  const keys = Object.keys(reports[0].detected)
  const lines = [
    '### What LongTalk detects in each browser (e2e/local/browsers.spec.ts)',
    '',
    `| capability | ${reports.map((r) => `${r.project} ${r.version}`).join(' | ')} |`,
    `| --- | ${reports.map(() => '---').join(' | ')} |`,
    ...keys.map(
      (key) =>
        `| \`${key}\` | ${reports
          .map((r) => `${r.detected[key] ? '✓' : '✕'}${r.skipped[key] ? ' *' : ''}`)
          .join(' | ')} |`,
    ),
    '',
    '\\* not held against `docs/BROWSER-SUPPORT.md`:',
    '',
    ...reports.flatMap((r) =>
      Object.entries(r.skipped).map(([key, why]) => `- ${r.project} \`${key}\`: ${why}`),
    ),
    '',
    ...reports.map((r) => `- ${r.project}: \`${r.userAgent}\``),
  ]
  console.log(lines.join('\n'))
}

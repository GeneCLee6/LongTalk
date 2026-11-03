import { readFileSync } from 'node:fs'
import { build, type Rolldown } from 'vite'
import { CAPABILITIES, type Capabilities, type Capability } from '../../src/media/capabilities.ts'

/**
 * The app's own feature detection (src/media/capabilities.ts), bundled into a script a page can
 * run (H6, e2-t16): the cross-browser suite asks each browser what LongTalk would detect there,
 * with the very code the app runs, not a copy of it. Built once per test worker.
 */
let script: Promise<string> | null = null

export function capabilityScript(): Promise<string> {
  script ??= build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: 'src/media/capabilities.ts',
        formats: ['iife'],
        name: '__longtalkCapabilities',
        fileName: 'capabilities',
      },
    },
  }).then((result) => {
    const output = (Array.isArray(result) ? result[0] : result) as Rolldown.RolldownOutput
    return output.output[0].code
  })
  return script
}

/** The columns of docs/BROWSER-SUPPORT.md's table, in order */
export const DOC_BROWSERS = [
  'Chrome',
  'Edge',
  'Firefox',
  'Safari (macOS)',
  'iOS Safari',
  'Android Chrome',
] as const

export type DocBrowser = (typeof DOC_BROWSERS)[number]

/** One mark of the doc's table: ● tested, ○ supported per the docs, ✕ unsupported, ? unsure */
export type Mark = '●' | '○' | '✕' | '?'

/** docs/BROWSER-SUPPORT.md's feature table: each capability's mark per browser */
export function docMarks(): Record<Capability, Record<DocBrowser, Mark>> {
  const doc = readFileSync('docs/BROWSER-SUPPORT.md', 'utf8')
  const marks = {} as Record<Capability, Record<DocBrowser, Mark>>
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    const key = /^`(\w+)`$/.exec(cells[2] ?? '')?.[1] as Capability | undefined
    if (!key || !CAPABILITIES.includes(key)) continue
    marks[key] = Object.fromEntries(
      DOC_BROWSERS.map((browser, i) => [browser, cells[3 + i]?.charAt(0) as Mark]),
    ) as Record<DocBrowser, Mark>
  }
  return marks
}

export type { Capabilities }

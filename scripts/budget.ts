// JS budget check (CLAUDE.md rule 6): the home page's JS ≤ 150 kB gzip, the room page's ≤ 350 kB.
// A page's JS is every chunk it loads before it can render: the entry chunk and its static
// imports, plus (for the room) the lazy room chunk and its static imports. Features loaded later
// (whiteboard, blur, recording, annotation) are not counted, which is the point of making them lazy.
// A language's dictionary chunk (J4, src/strings.ts) is loaded with the room, so the room counts the
// larger of the two; the home page must not load either (it fails here if it ever does).
// Reads Vite's manifest, so run it after `npm run build`.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

interface Chunk {
  file: string
  imports?: string[]
}

const clientDir = ['dist/client', 'dist'].find((dir) => existsSync(join(dir, '.vite/manifest.json')))
if (!clientDir) {
  console.error('No dist/**/.vite/manifest.json: run `npm run build` first')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(join(clientDir, '.vite/manifest.json'), 'utf8')) as Record<
  string,
  Chunk
>

const KB = 1024
const DICTIONARIES = ['src/i18n/zh-TW.ts', 'src/i18n/en.ts']
const budgets = [
  { page: 'home', roots: ['index.html'], either: [] as string[], limit: 150 * KB },
  { page: 'room', roots: ['index.html', 'src/pages/RoomPage.tsx'], either: DICTIONARIES, limit: 350 * KB },
]

function collect(key: string, seen: Set<string>): void {
  if (seen.has(key)) return
  const chunk = manifest[key]
  if (!chunk) throw new Error(`Manifest has no chunk for ${key}`)
  seen.add(key)
  for (const imported of chunk.imports ?? []) collect(imported, seen)
}

let failed = false
for (const { page, roots, either, limit } of budgets) {
  const measure = (extra: string[]) => {
    const keys = new Set<string>()
    for (const root of [...roots, ...extra]) collect(root, keys)
    const files = [...keys].map((key) => manifest[key].file).filter((file) => file.endsWith('.js'))
    const size = files.reduce((sum, file) => sum + gzipSync(readFileSync(join(clientDir!, file))).length, 0)
    return { keys, files, size }
  }
  const { keys, files, size } = either.length
    ? either.map((key) => measure([key])).reduce((a, b) => (b.size > a.size ? b : a))
    : measure([])
  const stray = page === 'home' ? DICTIONARIES.filter((key) => keys.has(key)) : []
  if (stray.length > 0) console.error(`The home page must not load ${stray.join(', ')}`)
  const ok = size <= limit && stray.length === 0
  if (!ok) failed = true
  const status = ok ? 'ok  ' : 'FAIL'
  console.log(`${status} ${page}: ${(size / KB).toFixed(1)} kB / ${limit / KB} kB gzip (${files.length} chunks)`)
}
process.exit(failed ? 1 : 0)

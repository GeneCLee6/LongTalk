// JS budget check (CLAUDE.md rule 6): the home page's JS ≤ 150 kB gzip, the room page's ≤ 350 kB.
// A page's JS is every chunk it loads before it can render: the entry chunk and its static
// imports, plus (for the room) the lazy room chunk and its static imports. Features loaded later
// (whiteboard, blur, recording, annotation) are not counted, which is the point of making them lazy.
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
const budgets = [
  { page: 'home', roots: ['index.html'], limit: 150 * KB },
  { page: 'room', roots: ['index.html', 'src/pages/RoomPage.tsx'], limit: 350 * KB },
]

function collect(key: string, seen: Set<string>): void {
  if (seen.has(key)) return
  const chunk = manifest[key]
  if (!chunk) throw new Error(`Manifest has no chunk for ${key}`)
  seen.add(key)
  for (const imported of chunk.imports ?? []) collect(imported, seen)
}

let failed = false
for (const { page, roots, limit } of budgets) {
  const keys = new Set<string>()
  for (const root of roots) collect(root, keys)
  const files = [...keys].map((key) => manifest[key].file).filter((file) => file.endsWith('.js'))
  const size = files.reduce((sum, file) => sum + gzipSync(readFileSync(join(clientDir, file))).length, 0)
  const ok = size <= limit
  if (!ok) failed = true
  const status = ok ? 'ok  ' : 'FAIL'
  console.log(`${status} ${page}: ${(size / KB).toFixed(1)} kB / ${limit / KB} kB gzip (${files.length} chunks)`)
}
process.exit(failed ? 1 : 0)

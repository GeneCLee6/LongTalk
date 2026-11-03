// CLAUDE.md rule 3, enforced (I1, e11-t06, AC-11.7): secrets never reach the browser. Part of
// `npm run lint` (the sources) and of `npm run budget` (the built client, after `npm run build`):
//
//   node scripts/secrets.ts           src/, public/ and index.html, comments taken out
//   node scripts/secrets.ts --dist    dist/client/ (what Workers Static Assets serves)
//
// It fails on the names of the Worker's secrets (code that reads one would be in the wrong
// place: only worker/ may) and on anything shaped like a secret value: private keys, cloud and
// AI API keys, GitHub tokens, JWTs, Turnstile secret keys (also the public test ones, which only
// tests and wrangler.jsonc's preview may hold), and long literals assigned to something called a
// secret, token, key or password. Also on .env / .dev.vars files in the built client.
// A line that really needs one says why with `// secret-ok: <reason>` on the same line.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { BINARY, scan, withoutComments, type Finding } from './secretScan.ts'

function files(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function main(): void {
  const dist = process.argv.includes('--dist')
  const roots = dist ? ['dist/client'] : ['src', 'public', 'index.html']
  const found: Finding[] = []
  let checked = 0
  for (const root of roots) {
    const list = root.endsWith('.html') ? [root] : files(root)
    if (dist && list.length === 0) {
      console.error('secrets: dist/client is empty; run `npm run build` first')
      process.exit(1)
    }
    for (const path of list) {
      const file = relative('.', path).split(sep).join('/')
      const base = file.split('/').pop()!
      if (base === '.dev.vars' || base.startsWith('.env')) {
        found.push({ file, line: 0, name: 'environment file', text: base })
        continue
      }
      if (BINARY.has(extname(file).toLowerCase())) continue
      const raw = readFileSync(path, 'utf8')
      const code = /\.(tsx?|jsx?|mjs)$/.test(file) && !dist ? withoutComments(raw) : raw
      found.push(...scan(file, code))
      checked++
    }
  }
  if (found.length > 0) {
    for (const f of found) console.error(`${f.file}:${f.line}: ${f.name} (${f.text})`)
    console.error(
      `secrets: ${found.length} finding(s). Secrets live only in the Worker (CLAUDE.md rule 3); ` +
        'a false alarm takes `// secret-ok: <reason>` on its line.',
    )
    process.exit(1)
  }
  console.log(`secrets: nothing secret in ${checked} ${dist ? 'built client' : 'source'} files`)
}

main()

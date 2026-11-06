// CLAUDE.md rule 5, enforced (G5, AC-4.8): interface text comes only from the dictionaries
// (src/i18n/*.ts, through src/strings.ts) and colours only from src/styles/tokens.ts. Part of
// `npm run lint`. It looks at the code of src/ with comments taken out and reports:
//
//   - Chinese characters or full-width punctuation (the interface's language) in code;
//   - colour literals: #rgb / #rrggbb / #rrggbbaa in a string, rgb(), rgba(), hsl(), hsla();
//   - text between JSX tags, and literal text in aria-label / title / placeholder / alt / label.
//
// A line that really needs one says why with `// literal-ok: <reason>` on the same line.
// The dictionaries (also the privacy policy's, src/privacy/policy.*), the tokens and the brand file
// (src/brand.ts: the PWA's fixed colours) are where these belong and are not checked.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = 'src'
// src/privacy/policy.*: the privacy page's text, a dictionary of its own per language (lazy, so
// it stays out of the home page's JS budget; RULES.md §1)
const ALLOWED = ['src/i18n/', 'src/styles/tokens.ts', 'src/brand.ts', 'src/privacy/policy.']

const checks: { name: string; pattern: RegExp }[] = [
  { name: 'Chinese text', pattern: /[　-〿㐀-鿿＀-￯]/u },
  {
    name: 'colour literal',
    pattern: /['"`][^'"`]*#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/,
  },
  { name: 'JSX text', pattern: />[^<>{}=;()]*\p{L}[^<>{}=;()]*<\/[A-Za-z]/u },
  {
    name: 'literal attribute text',
    pattern: /\b(?:aria-label|title|placeholder|alt|label)="[^"]*\p{L}/u,
  },
]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

/**
 * Blanks out comments, keeping line numbers: block comments (also the JSX kind), then `//` to the
 * end of the line unless it follows a colon (https://). Not a tokenizer: good enough for src/,
 * and a false alarm can be marked literal-ok.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => {
      const comment = line.search(/(?<!:)\/\//)
      if (comment === -1) return line
      const marker = line.slice(comment).includes('literal-ok:') ? ' literal-ok:' : ''
      return line.slice(0, comment) + marker
    })
    .join('\n')
}

const problems: string[] = []
for (const path of files(ROOT)) {
  const file = relative('.', path).split(sep).join('/')
  if (!/\.tsx?$/.test(file) || ALLOWED.some((allowed) => file.startsWith(allowed))) continue
  const lines = withoutComments(readFileSync(path, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    if (line.includes('literal-ok:')) return
    for (const { name, pattern } of checks) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1}: ${name}: ${line.trim()}`)
    }
  })
}

if (problems.length > 0) {
  console.error(
    `Interface text belongs in src/i18n/*.ts and colours in src/styles/tokens.ts (CLAUDE.md rule 5):\n${problems.join('\n')}`,
  )
  process.exit(1)
}
console.log('literals: no interface text or colour literals outside the dictionaries and tokens')

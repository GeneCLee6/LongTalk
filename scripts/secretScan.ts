// The patterns and the scan behind scripts/secrets.ts (I1, e11-t06), apart so tests can use them
// No Node APIs here: the app's tests import it

/** The Worker secrets and CI secrets (DEPLOY.md §5, §8, §11): none of these belongs in src/ */
export const SECRET_NAMES = [
  'REALTIME_APP_SECRET',
  'REALTIME_TURN_KEY_ID',
  'REALTIME_TURN_KEY_API_TOKEN',
  'ADMIN_TOKEN',
  'PREVIEW_ADMIN_TOKEN',
  'TURNSTILE_SECRET_KEY',
  'IP_HASH_PEPPER',
  'CLOUDFLARE_API_TOKEN',
]

export const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'secret name', pattern: new RegExp(`\\b(?:${SECRET_NAMES.join('|')})\\b`) },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'AI API key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  // Turnstile secret keys are 35 characters, `0x4AAAAAAA…` (real) or `1x000…AA` (test); the
  // site keys are 24 and public
  { name: 'Turnstile secret key', pattern: /\b[0-3]x[0-9A-Za-z_-]{33}\b/ },
  {
    name: 'secret-like literal',
    pattern:
      /\b[\w$]*(?:secret|api_?key|apikey|password|passwd|private_?key|auth_?token)[\w$]*["']?\s*[:=]\s*["'`][A-Za-z0-9+/_=-]{24,}["'`]/i,
  },
]

/** Files the browser could get that are not text: skipped */
export const BINARY = new Set(['.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif', '.wasm', '.woff', '.woff2'])


/** Blanks comments out of source code, keeping line numbers (the same rough rule as literals.ts) */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1')
}

export type Finding = { file: string; line: number; name: string; text: string }

/** What `text` holds that looks like a secret, line by line */
export function scan(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  text.split('\n').forEach((line, index) => {
    if (line.includes('secret-ok:')) return
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = pattern.exec(line)
      if (match) {
        findings.push({ file, line: index + 1, name, text: match[0].slice(0, 12) + '…' })
      }
    }
  })
  return findings
}


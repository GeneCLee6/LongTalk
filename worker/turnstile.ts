// Cloudflare Turnstile on room creation (I1, e11-t05). On only when both keys are set: the site
// key (public, a wrangler var) and the secret key (a Worker secret, never in the browser). Until
// the owner sets them up (DEPLOY.md §11) nothing asks for a token.

export interface TurnstileEnv {
  /** The widget's site key: public, `vars` in wrangler.jsonc */
  TURNSTILE_SITE_KEY?: string
  /** The widget's secret key: `wrangler secret put TURNSTILE_SECRET_KEY` only */
  TURNSTILE_SECRET_KEY?: string
}

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Tokens are at most 2048 characters (Cloudflare's documentation) */
const MAX_TOKEN_CHARS = 2048

/** The site key when Turnstile is on (both keys set), else null */
export function turnstileSiteKey(env: TurnstileEnv): string | null {
  return env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null
}

/**
 * Whether `token` is a valid, unspent Turnstile token, asked of siteverify with the secret key
 * and the client's address. A siteverify that cannot be reached fails closed (the browser shows
 * "try again"): a token nobody checked is no token.
 */
export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string | null,
  ip: string | null,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY || !token || token.length > MAX_TOKEN_CHARS) return false
  const form = new FormData()
  form.append('secret', env.TURNSTILE_SECRET_KEY)
  form.append('response', token)
  if (ip) form.append('remoteip', ip)
  try {
    const res = await fetcher(SITEVERIFY_URL, { method: 'POST', body: form })
    if (!res.ok) return false
    const body = (await res.json()) as { success?: unknown }
    return body.success === true
  } catch (error) {
    console.error('turnstile siteverify failed', error)
    return false
  }
}

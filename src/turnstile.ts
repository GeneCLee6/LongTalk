// Cloudflare Turnstile in the browser (I1, e11-t05): loaded only when POST /api/rooms asks for a
// token (the owner turned it on), never on a page view. The widget is `interaction-only`: most
// people see nothing; someone Turnstile is unsure about gets a checkbox in the container.
// The secret key stays in the Worker (CLAUDE.md rule 3); this file only knows the site key the
// server sent. CSP allows the script and iframe origin below (worker/headers.ts).

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** The script must arrive this soon */
const LOAD_TIMEOUT_MS = 15_000

type WidgetId = string

interface TurnstileOptions {
  sitekey: string
  action?: string
  appearance?: 'always' | 'execute' | 'interaction-only'
  language?: string
  callback?: (token: string) => void
  'error-callback'?: (code: string) => boolean | void
  'expired-callback'?: () => void
  'timeout-callback'?: () => void
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): WidgetId | undefined
  remove(id: WidgetId): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let loading: Promise<TurnstileApi> | null = null

/** Turnstile's script, once per page; a failed load may be tried again */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (loading) return loading
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    const timer = setTimeout(() => fail(new Error('turnstile load timeout')), LOAD_TIMEOUT_MS)
    const fail = (error: Error) => {
      clearTimeout(timer)
      script.remove()
      loading = null
      reject(error)
    }
    script.onload = () => {
      clearTimeout(timer)
      if (window.turnstile) resolve(window.turnstile)
      else fail(new Error('turnstile missing'))
    }
    script.onerror = () => fail(new Error('turnstile load failed'))
    doc.head.appendChild(script)
  })
  return loading
}

/**
 * One Turnstile token for creating a room: renders the widget into `container`, waits for its
 * answer and takes the widget away again (a token is good for one request only). Rejects when
 * the script cannot load or the challenge fails or expires.
 */
export async function turnstileToken(
  container: HTMLElement,
  siteKey: string,
  language: string,
): Promise<string> {
  const api = await loadTurnstile()
  return new Promise<string>((resolve, reject) => {
    let id: WidgetId | undefined
    const done = (finish: () => void) => {
      if (id !== undefined) {
        try {
          api.remove(id)
        } catch {
          // Already gone
        }
      }
      finish()
    }
    id = api.render(container, {
      sitekey: siteKey,
      action: 'create-room',
      appearance: 'interaction-only',
      language,
      callback: (token) => done(() => resolve(token)),
      'error-callback': (code) => {
        done(() => reject(new Error(`turnstile error ${code}`)))
        return true
      },
      'expired-callback': () => done(() => reject(new Error('turnstile expired'))),
      'timeout-callback': () => done(() => reject(new Error('turnstile timeout'))),
    })
    if (id === undefined) reject(new Error('turnstile render failed'))
  })
}

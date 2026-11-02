// The browser's end of the minimal telemetry (e11-t03): queues events (shared/telemetry.ts) and
// sends them to POST /api/events in small batches, and reports uncaught errors, sampled and
// capped. Never sends names, room ids, chat text or anything typed; an error's message is
// scrubbed first (and again by the Worker).
import {
  EVENTS_PATH,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_ERROR_NAME_CHARS,
  MAX_ERROR_SOURCE_CHARS,
  MAX_EVENTS_PER_BATCH,
  scrubErrorText,
  type ClientEvent,
} from '../shared/telemetry.ts'

/** Events wait this long for company before a batch goes out */
export const FLUSH_DELAY_MS = 10_000
/** Events kept while sending is not possible; older ones go first */
const MAX_QUEUED = 50
/** Uncaught errors reported per page load, at most */
export const MAX_ERRORS_PER_PAGE = 5
/**
 * The share of uncaught errors reported. 1 while LongTalk is small (every error matters, the
 * per-page cap and the Worker's rate limit bound the volume); lower it when traffic grows.
 */
export const ERROR_SAMPLE_RATE = 1

/** How a batch leaves: sendBeacon when the page goes away, fetch otherwise */
export type Sender = (body: string, leaving: boolean) => void

function defaultSender(body: string, leaving: boolean): void {
  if (leaving && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    if (navigator.sendBeacon(EVENTS_PATH, new Blob([body], { type: 'application/json' }))) return
  }
  if (typeof fetch !== 'function') return
  void fetch(EVENTS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined)
}

export interface TelemetryOptions {
  send?: Sender
  /** Off: events are dropped (local development, tests that do not ask for them) */
  enabled?: boolean
  random?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** A queue of events and the error reporter; `telemetry` below is the page's one instance */
export class Telemetry {
  private queue: ClientEvent[] = []
  private timer: unknown = null
  private errorsReported = 0
  private readonly errorsSeen = new Set<string>()
  private readonly options: Required<TelemetryOptions>

  constructor(options: TelemetryOptions = {}) {
    this.options = {
      send: defaultSender,
      enabled: true,
      random: Math.random,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      ...options,
    }
  }

  /** Queues an event; a full batch goes at once, otherwise after FLUSH_DELAY_MS */
  track(event: ClientEvent): void {
    if (!this.options.enabled) return
    this.queue.push(event)
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED)
    if (this.queue.length >= MAX_EVENTS_PER_BATCH) this.flush()
    else if (this.timer === null) {
      this.timer = this.options.setTimer(() => {
        this.timer = null
        this.flush()
      }, FLUSH_DELAY_MS)
    }
  }

  /** Sends everything queued (`leaving`: the page is going away, so it must not wait) */
  flush(leaving = false): void {
    if (this.timer !== null) {
      this.options.clearTimer(this.timer)
      this.timer = null
    }
    while (this.queue.length > 0) {
      const events = this.queue.splice(0, MAX_EVENTS_PER_BATCH)
      try {
        this.options.send(JSON.stringify({ events }), leaving)
      } catch {
        // Telemetry must never break the page
      }
    }
  }

  /**
   * An uncaught error or rejection: reported once per distinct error, at most
   * MAX_ERRORS_PER_PAGE per page, sampled at ERROR_SAMPLE_RATE, scrubbed of anything personal
   */
  reportError(kind: 'error' | 'rejection', error: unknown, where?: string): void {
    if (this.errorsReported >= MAX_ERRORS_PER_PAGE) return
    const name = error instanceof Error ? error.name : typeof error
    const message = error instanceof Error ? error.message : String(error)
    const event: ClientEvent = {
      type: 'error',
      kind,
      name: scrubErrorText(name, MAX_ERROR_NAME_CHARS),
      message: scrubErrorText(message, MAX_ERROR_MESSAGE_CHARS),
      source: scrubErrorText(sourceOf(error, where), MAX_ERROR_SOURCE_CHARS),
    }
    const key = `${event.name}|${event.message}|${event.source}`
    if (this.errorsSeen.has(key)) return
    this.errorsSeen.add(key)
    if (this.options.random() >= ERROR_SAMPLE_RATE) return
    this.errorsReported++
    this.track(event)
  }
}

/** Where an error came from: the script's file name (no path, no query) and line, if known */
function sourceOf(error: unknown, where?: string): string {
  const fromStack =
    error instanceof Error
      ? /([\w.-]+\.(?:js|ts|tsx))(?:\?[^:)]*)?:(\d+):(\d+)/.exec(error.stack ?? '')
      : null
  if (fromStack) return `${fromStack[1]}:${fromStack[2]}:${fromStack[3]}`
  if (!where) return ''
  return where.replace(/^.*\//, '').replace(/\?[^:]*/, '')
}

const isDev = (): boolean => {
  try {
    return import.meta.env.DEV === true || import.meta.env.MODE === 'test'
  } catch {
    return false
  }
}

/** The page's telemetry: off in development and tests (they pass their own Telemetry) */
export const telemetry = new Telemetry({ enabled: !isDev() })

/**
 * Reports uncaught errors and unhandled rejections, and sends what is queued when the page is
 * hidden or goes away. Called once from main.tsx; returns a function that stops it (tests).
 */
export function installTelemetry(target: Telemetry = telemetry, win: Window = window): () => void {
  const onError = (event: ErrorEvent) =>
    target.reportError(
      'error',
      event.error ?? event.message,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    )
  const onRejection = (event: PromiseRejectionEvent) =>
    target.reportError('rejection', event.reason)
  const onHide = () => {
    if (win.document.visibilityState === 'hidden') target.flush(true)
  }
  const onPageHide = () => target.flush(true)
  win.addEventListener('error', onError)
  win.addEventListener('unhandledrejection', onRejection)
  win.document.addEventListener('visibilitychange', onHide)
  win.addEventListener('pagehide', onPageHide)
  return () => {
    win.removeEventListener('error', onError)
    win.removeEventListener('unhandledrejection', onRejection)
    win.document.removeEventListener('visibilitychange', onHide)
    win.removeEventListener('pagehide', onPageHide)
  }
}

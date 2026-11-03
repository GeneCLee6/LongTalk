// Security headers (I1, e11-t06), shared by the Worker, the tests and the e2e checks. The pages
// and static files get PAGE_HEADERS from public/_headers (Workers Static Assets serves them
// without running the Worker; a test keeps the file equal to this list); the Worker's own answers
// (/api/*) get API_HEADERS (worker/headers.ts). Why each source is allowed: DEPLOY.md §11.

/** Where CSP violation reports go (worker/csp-report.ts) */
export const CSP_REPORT_PATH = '/api/csp-report'

/** Cloudflare Turnstile's script and iframe (only used when the owner configured it) */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/**
 * The page's Content-Security-Policy:
 * - scripts only from this origin (no inline, no eval) plus Turnstile's; `'wasm-unsafe-eval'`
 *   lets RNNoise's WebAssembly compile (e6-t02), and is not eval of JavaScript
 * - styles also inline: styled-components writes <style> elements at run time, and the assets
 *   are static (no per-response nonce without running the Worker for every page)
 * - connections only to this origin (`'self'` covers wss: for the room's socket); media itself is
 *   ICE (UDP / TURN), which CSP does not govern, and the SFU and TURN APIs go through the Worker
 * - images and sound also from data: and blob: (the speaker test tone, the stats export)
 * - workers, worklets and the service worker only from this origin; frames only Turnstile's;
 *   nobody may frame LongTalk
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  `frame-src ${TURNSTILE_ORIGIN}`,
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  `report-uri ${CSP_REPORT_PATH}`,
  'report-to csp',
].join('; ')

/**
 * Powerful features: the camera, the microphone and screen capture for this origin only, and the
 * few others LongTalk uses (clipboard for 複製連結, picture-in-picture, autoplay
 * of remote audio, fullscreen); the rest off for every frame. Features not listed keep the
 * browser's default (e.g. speaker selection, passkeys for I2).
 */
export const PERMISSIONS_POLICY = [
  'camera=(self)',
  'microphone=(self)',
  'display-capture=(self)',
  'autoplay=(self)',
  'clipboard-write=(self)',
  'fullscreen=(self)',
  'picture-in-picture=(self)',
  'accelerometer=()',
  'bluetooth=()',
  'browsing-topics=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'idle-detection=()',
  'local-fonts=()',
  'magnetometer=()',
  'midi=()',
  'otp-credentials=()',
  'payment=()',
  'screen-wake-lock=()',
  'serial=()',
  'usb=()',
  'window-management=()',
  'xr-spatial-tracking=()',
].join(', ')

/** Every page and static file (public/_headers `/*`) */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Reporting-Endpoints': `csp="${CSP_REPORT_PATH}"`,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

/** The Worker's answers (/api/*): JSON, never a page, so nothing may run or frame them */
export const API_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

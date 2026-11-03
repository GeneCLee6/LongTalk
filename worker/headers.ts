import { API_HEADERS } from '../shared/security-headers.ts'

export { CSP_REPORT_PATH } from '../shared/security-headers.ts'

/**
 * `response` with API_HEADERS added (headers it already has win). A WebSocket upgrade (101) is
 * passed through as it is.
 */
export function withApiHeaders(response: Response): Response {
  if (response.status === 101 || response.webSocket) return response
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(API_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

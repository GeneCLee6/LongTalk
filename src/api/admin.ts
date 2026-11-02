import { ADMIN_SUMMARY_PATH, type AdminSummary } from '../../shared/telemetry.ts'

export type AdminResult =
  | { ok: true; summary: AdminSummary }
  | { ok: false; reason: 'unauthorized' | 'notConfigured' | 'failed' }

/**
 * GET /api/admin/summary with the owner's password (e11-t03). The password goes in the
 * Authorization header, never in the URL (address bars, history and logs keep URLs).
 */
export async function fetchAdminSummary(token: string): Promise<AdminResult> {
  let res: Response
  try {
    res = await fetch(ADMIN_SUMMARY_PATH, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (res.status === 401) return { ok: false, reason: 'unauthorized' }
  if (res.status === 503) return { ok: false, reason: 'notConfigured' }
  if (!res.ok) return { ok: false, reason: 'failed' }
  try {
    const summary = (await res.json()) as AdminSummary
    if (typeof summary?.telemetry !== 'object' || summary.telemetry === null) {
      return { ok: false, reason: 'failed' }
    }
    return { ok: true, summary }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

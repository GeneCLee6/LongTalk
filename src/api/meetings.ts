import { MEETINGS_API, type PublicMeeting } from '../../shared/meeting.ts'

// The public meeting page's one call (I3, worker/meetings.ts): no sign-in, nothing of the account
// API (nor its WebAuthn code) in the /m chunk.

/** The meeting, `null` when there is no such meeting (or it is past retention); throws when unreachable */
export async function fetchPublicMeeting(id: string): Promise<PublicMeeting | null> {
  const res = await fetch(`${MEETINGS_API}/${encodeURIComponent(id)}`, { credentials: 'omit' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`meeting ${res.status}`)
  return (await res.json()) as PublicMeeting
}

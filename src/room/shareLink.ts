import { canCopy, canWebShare, type CapabilityEnv } from '../media/capabilities.ts'

/** What became of a copy or share: a toast says so (or nothing, when the person cancelled) */
export type LinkOutcome = 'copied' | 'shared' | 'cancelled' | 'failed'

/** The bits of navigator the link needs, so tests can pass a stand-in */
export interface LinkNavigator {
  clipboard?: { writeText(text: string): Promise<void> } | null
  share?: (data: ShareData) => Promise<void>
}

const env = (nav: LinkNavigator): CapabilityEnv => ({ navigator: nav })

/** The room's link, the one to send to friends */
export function roomUrl(roomId: string, origin: string = location.origin): string {
  return `${origin}/r/${roomId}`
}

async function writeClipboard(url: string, nav: LinkNavigator): Promise<boolean> {
  if (!canCopy(env(nav))) return false
  try {
    await nav.clipboard!.writeText(url)
    return true
  } catch {
    // Not allowed (no focus, a permission policy): the caller falls back
    return false
  }
}

async function openShareSheet(
  url: string,
  title: string,
  text: string,
  nav: LinkNavigator,
): Promise<LinkOutcome | null> {
  if (!canWebShare(env(nav))) return null
  try {
    await nav.share!({ title, text, url })
    return 'shared'
  } catch (error) {
    // The person closed the sheet: nothing to say
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled'
    return null
  }
}

/**
 * The top bar's 複製連結 (e1-t05): the clipboard; where it is missing or refused (an http: page,
 * an old browser) the system share sheet instead; 'failed' when neither works (the caller shows
 * the link to copy by hand).
 */
export async function copyRoomLink(
  url: string,
  title: string,
  text: string,
  nav: LinkNavigator = navigator,
): Promise<LinkOutcome> {
  if (await writeClipboard(url, nav)) return 'copied'
  return (await openShareSheet(url, title, text, nav)) ?? 'failed'
}

/**
 * 更多 › 分享連結 (e1-t05): the system share sheet (Web Share API, mostly phones); without one, or
 * when it fails, the clipboard.
 */
export async function shareRoomLink(
  url: string,
  title: string,
  text: string,
  nav: LinkNavigator = navigator,
): Promise<LinkOutcome> {
  const shared = await openShareSheet(url, title, text, nav)
  if (shared) return shared
  return (await writeClipboard(url, nav)) ? 'copied' : 'failed'
}

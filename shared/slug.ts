// Personal persistent rooms' addresses (I2, e1-t13): /r/<slug>, chosen by their owner. A slug is
// also the name of the room's Durable Object, beside the random ids (shared/room-id.ts): the two
// never overlap, because a slug may not have a random id's shape. Slugs are unique across the
// whole site (`/r/gene` is one room), first come first served.
import { isRoomId } from './room-id.ts'

export const SLUG_MIN_CHARS = 3
export const SLUG_MAX_CHARS = 32

/**
 * Words that are not anyone's room: the site's own paths and names people would mistake for the
 * site's (a room called /r/admin or /r/support could pass for the owner's)
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'about',
  'account',
  'accounts',
  'admin',
  'administrator',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'blog',
  'contact',
  'dashboard',
  'debug',
  'dev',
  'docs',
  'help',
  'home',
  'host',
  'index',
  'info',
  'join',
  'legal',
  'login',
  'logout',
  'longtalk',
  'meet',
  'meeting',
  'meetings',
  'moderator',
  'new',
  'null',
  'official',
  'owner',
  'privacy',
  'register',
  'root',
  'room',
  'rooms',
  'security',
  'settings',
  'signin',
  'signout',
  'signup',
  'staff',
  'static',
  'status',
  'support',
  'system',
  'team',
  'terms',
  'test',
  'undefined',
  'user',
  'users',
  'www',
  'zoom',
])

/** Why a slug cannot be used: the /me form's message for each (both dictionaries) */
export type SlugProblem = 'length' | 'chars' | 'reserved' | 'roomId'

const SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/

/** What someone typed as a slug, as the site would keep it: trimmed, half-width, lower case */
export function normalizeSlug(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase()
}

/**
 * Whether `slug` (already normalized) can name a room: SLUG_MIN_CHARS–SLUG_MAX_CHARS of a–z, 0–9
 * and single hyphens, starting with a letter and not ending with a hyphen; not a reserved word;
 * not shaped like a random room id (10 characters of its alphabet). Null when it can.
 */
export function slugProblem(slug: string): SlugProblem | null {
  if (slug.length < SLUG_MIN_CHARS || slug.length > SLUG_MAX_CHARS) return 'length'
  if (!SLUG_PATTERN.test(slug) || slug.includes('--')) return 'chars'
  if (RESERVED_SLUGS.has(slug)) return 'reserved'
  if (isRoomId(slug)) return 'roomId'
  return null
}

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && slugProblem(value) === null
}

/** A room's address, either kind: a random id or a persistent room's slug */
export function isRoomKey(value: unknown): value is string {
  return isRoomId(value) || isSlug(value)
}

/**
 * The room in what someone pasted into the home page's join box: a bare id or slug, or any link
 * whose path has `/r/<id or slug>`. Null when there is none.
 */
export function parseRoomAddress(input: string): string | null {
  const text = input.trim()
  if (isRoomId(text)) return text
  if (isSlug(normalizeSlug(text))) return normalizeSlug(text)
  const match = /(?:^|\/)r\/([^/?#\s]+)/.exec(text)
  if (!match) return null
  if (isRoomId(match[1])) return match[1]
  const slug = normalizeSlug(match[1])
  return isSlug(slug) ? slug : null
}

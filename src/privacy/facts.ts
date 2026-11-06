import { SESSION_COOKIE, SESSION_IDLE_MS, SESSION_MAX_MS, CHALLENGE_TTL_MS } from '../../shared/account.ts'
import { BLOCK_HOURS, LIMITS, MAX_OFFENDERS } from '../../shared/abuse.ts'
import { CHAT_HISTORY } from '../../shared/chat.ts'
import { BACKUP_RETENTION_DAYS, FILE_TTL_MS } from '../../shared/file-limits.ts'
import { MEETING_RETENTION_MS } from '../../shared/meeting.ts'
import { GUESS_MEMORY_MS } from '../../shared/password.ts'
import {
  BAN_MS,
  CONSENT_TIMEOUT_MS,
  DENY_COOLDOWN_MS,
  EMPTY_ROOM_TTL_MS,
  RECONNECT_GRACE_MS,
  WAIT_TIMEOUT_MS,
} from '../../shared/protocol.ts'
import {
  MAX_ERROR_SAMPLES,
  TELEMETRY_DAYS,
  TELEMETRY_HOURS,
} from '../../shared/telemetry.ts'
import { DOWNLOADED_KEEP_MS } from '../record/store.ts'

// The numbers on /privacy (I6, e11-t07), read from the constants the code runs on, so the page
// cannot drift from them. tests/app/privacy.test.tsx also pins each value: changing a constant
// fails there until someone has reread the page's wording and updated the pin.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Everything the policy's text quotes. Each one is used by both languages (a test checks) */
export const FACTS = {
  chatMessages: CHAT_HISTORY,
  emptyRoomMinutes: EMPTY_ROOM_TTL_MS / MINUTE,
  reconnectSeconds: RECONNECT_GRACE_MS / SECOND,
  banMinutes: BAN_MS / MINUTE,
  denySeconds: DENY_COOLDOWN_MS / SECOND,
  waitingMinutes: WAIT_TIMEOUT_MS / MINUTE,
  guessMinutes: GUESS_MEMORY_MS / MINUTE,
  consentSeconds: CONSENT_TIMEOUT_MS / SECOND,
  fileHours: FILE_TTL_MS / HOUR,
  /** The hourly sweep goes by the hour in a file's key, so at most an hour later */
  fileGoneHours: FILE_TTL_MS / HOUR + 1,
  backupDays: BACKUP_RETENTION_DAYS,
  sessionIdleDays: SESSION_IDLE_MS / DAY,
  sessionMaxDays: SESSION_MAX_MS / DAY,
  challengeMinutes: CHALLENGE_TTL_MS / MINUTE,
  meetingDays: MEETING_RETENTION_MS / DAY,
  telemetryDays: TELEMETRY_DAYS,
  telemetryHours: TELEMETRY_HOURS,
  errorSamples: MAX_ERROR_SAMPLES,
  /** The longest window GuardDO counts in: older times are dropped when the network next acts */
  networkCountHours:
    Math.max(...Object.values(LIMITS).flatMap((windows) => windows.map((w) => w.windowMs))) / HOUR,
  blockMaxDays: Math.max(...BLOCK_HOURS) / 24,
  offenders: MAX_OFFENDERS,
  recordingKeepMinutes: DOWNLOADED_KEEP_MS / MINUTE,
  /**
   * What Cloudflare's own documentation says for this account's plan, not LongTalk's code, so
   * nothing can check these; DEPLOY.md §13 lists them to recheck: Workers Logs on the free plan,
   * D1 Time Travel on the free plan, point-in-time recovery of SQLite-backed Durable Objects.
   */
  cloudflareLogDays: 3,
  cloudflareD1RecoveryDays: 7,
  cloudflareRoomRecoveryDays: 30,
} as const

export type Facts = { readonly [K in keyof typeof FACTS]: number }

export const COOKIE_NAME = SESSION_COOKIE

/**
 * What LongTalk keeps in the browser's localStorage and sessionStorage. A test scans src/ for
 * `longtalk.` keys and fails on one that is not listed here; the policy's two languages must
 * describe each (a type error otherwise). `<room>` stands for the room's address.
 */
export const LOCAL_STORAGE_KEYS = [
  'longtalk.name',
  'longtalk.client',
  'longtalk.devices',
  'longtalk.deviceLabels',
  'longtalk.view',
  'longtalk.prefs',
  'longtalk.media',
  'longtalk.account',
  'longtalk.locale',
  'longtalk.theme',
  'longtalk.installDismissed',
  'longtalk.recording.settings',
  'longtalk.recording.pending',
] as const

export const SESSION_STORAGE_KEYS = [
  'longtalk.session.<room>',
  'longtalk.password.<room>',
  'longtalk:mainShare:<room>',
] as const

export type StorageKey =
  | (typeof LOCAL_STORAGE_KEYS)[number]
  | (typeof SESSION_STORAGE_KEYS)[number]

/** The IndexedDB database (src/record/store.ts) and the service worker's caches (src/pwa/) */
export const RECORDINGS_DATABASE = 'longtalk-recordings'
export const APP_CACHES = 'longtalk-shell-*, longtalk-meta'

// The upload limits (I5, e5-t05, e11-t08), all the numbers in one file (shared/files.ts has the
// rules that use them). Numbers only, so shared/abuse.ts can read one without bringing the file
// rules into the home page's JavaScript.
//
// How they were picked. R2's free tier is 10 GB stored, 1 million Class A and 10 million Class B
// operations a month, and the owner's other projects share that 10 GB, so LongTalk stops well below
// it:
// - a file is at most 25 MB (AC-5.4);
// - everything stored at once is at most 2 GB (a fifth of the free 10 GB). Files live about a day,
//   so that is also about what a day can add;
// - one room at most 500 MB and 100 files: a quarter of the cap, so one meeting cannot fill it;
// - one member at most 150 MB and 30 files: six full-size files, far more than a meeting shares;
// - one network at most 15 uploads in 10 minutes and 40 a day (GuardDO): 40 × 25 MB = 1 GB, so one
//   network alone never reaches the cap. An office behind one address shares these; if that hurts,
//   this is the one line to change.
// Operations stay far below their free allowance: one upload is 1–2 Class A (R2 put), one download
// or thumbnail 1 Class B, the hourly sweep about 720 Class A a month (list) and deleting is free.

const MB = 1024 * 1024
const GB = 1024 * MB

/** The largest file (AC-5.4); the Worker refuses more while the bytes stream through it */
export const MAX_FILE_BYTES = 25 * MB
/** A browser-made thumbnail: a small JPEG, so nobody downloads 25 MB to see a chat message */
export const MAX_THUMB_BYTES = 256 * 1024
/** What one member may have stored in a room (files expire after FILE_TTL_MS, freeing it) */
export const MEMBER_FILE_LIMIT = { files: 30, bytes: 150 * MB } as const
/** What one room may have stored */
export const ROOM_FILE_LIMIT = { files: 100, bytes: 500 * MB } as const
/** Uploads one network may start (GuardDO, shared/abuse.ts `upload`) */
export const NETWORK_UPLOAD_LIMITS = [
  { count: 15, windowMs: 10 * 60_000 },
  { count: 40, windowMs: 24 * 60 * 60_000 },
] as const
/** What LongTalk may keep in its bucket at once; above it uploads are refused (FileLedgerDO) */
export const GLOBAL_FILE_CAP_BYTES = 2 * GB
/** A file can be downloaded for this long after its upload started (AC-5.4) */
export const FILE_TTL_MS = 24 * 60 * 60_000
/** Daily D1 backups are kept this long, so a deleted account leaves them within this many days */
export const BACKUP_RETENTION_DAYS = 7

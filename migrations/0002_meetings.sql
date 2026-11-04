-- Scheduled meetings (I3, e1-t14). What they keep is listed in
-- docs/PRD/e11-platform-security-cost-ops.md 「帳號資料」. Applied with
-- `wrangler d1 migrations apply` (DEPLOY.md §4); never edit a migration that was applied: add one.

-- One meeting, always single (no recurrence: AC-1.7 asks for none). `id` is the public page's
-- address (/m/<id>): 16 random bytes, base64url, unguessable. The meeting happens in one of the
-- owner's persistent rooms (`room_slug`): that room exists before the meeting starts, and its
-- password and waiting room are the room's own settings (RoomDO). Times are epoch milliseconds
-- (UTC); `time_zone` is the organizer's IANA zone, for showing the time as they meant it.
-- `ends_at` (starts_at + duration) is kept for the past/upcoming split and for retention: a
-- meeting goes MEETING_RETENTION_MS after it ended. `sequence` counts edits (the .ics SEQUENCE)
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  room_slug TEXT NOT NULL REFERENCES rooms(slug) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  starts_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX meetings_account ON meetings(account_id, starts_at);
CREATE INDEX meetings_room ON meetings(room_slug);
CREATE INDEX meetings_ends ON meetings(ends_at);

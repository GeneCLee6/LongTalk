-- Accounts (I2, e1-t12): passkeys only (no e-mail, no password). What an account keeps is listed
-- in docs/PRD/e11-platform-security-cost-ops.md 「帳號資料」. Applied with
-- `wrangler d1 migrations apply` (DEPLOY.md §4); never edit a migration that was applied: add one.

-- One person. `id` is also the WebAuthn user handle: 16 random bytes, base64url, nothing personal
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Their passkeys: the public key (COSE, base64url) and what the authenticator said about it
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  aaguid TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX credentials_account ON credentials(account_id);

-- Signed-in browsers. The cookie holds a random token; only its SHA-256 is kept (`token_hash`).
-- `prev_hash` is the token before the last rotation, still good until `prev_until` (requests
-- already on their way). `id` is a public handle for the /me list
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  prev_hash TEXT,
  prev_until INTEGER,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_prev ON sessions(prev_hash);

-- WebAuthn challenges waiting for their answer: single use, a few minutes. A registration's also
-- carries the account it would make (`account_id`, `name`); adding a passkey carries the account
CREATE TABLE challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT,
  name TEXT,
  expires_at INTEGER NOT NULL
);

-- Personal persistent rooms (e1-t13): the slug is the room's address (/r/<slug>) and its Durable
-- Object's name; the settings live in the room's own storage
CREATE TABLE rooms (
  slug TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX rooms_account ON rooms(account_id);

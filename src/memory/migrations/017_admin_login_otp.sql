-- Email one-time-code (OTP) second step for dashboard sign-in.
--   * admin_users.email: where the code is sent. NULL falls back to the username when it is an address.
--   * admin_login_challenges: one row per password-verified sign-in attempt. Stores only hashes:
--     token_hash  = SHA-256 of the random challenge token the browser holds,
--     code_hash   = HMAC-SHA256(key = challenge token, message = code).
--     Neither the code nor the token is ever stored or logged in clear text.
ALTER TABLE admin_users ADD COLUMN email TEXT;

CREATE TABLE IF NOT EXISTS admin_login_challenges (
  id TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_login_challenges_user_created ON admin_login_challenges(admin_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_login_challenges_expires ON admin_login_challenges(expires_at);

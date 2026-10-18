-- Route cooldowns survive a restart (a provider that just reported "quota exhausted" is not hammered again by a freshly started process), and a
-- provider whose pricing cannot be verified from a public catalog stays out of routing until the Super Admin confirms its free tier.
-- Existing providers are grandfathered as confirmed (their free tier was declared when they were saved). Rollback: DROP TABLE ai_route_cooldowns;
-- the free_confirmed column is harmless if left in place.
CREATE TABLE IF NOT EXISTS ai_route_cooldowns (
  key        TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('route', 'provider')),
  until_ms   INTEGER NOT NULL,
  why        TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE ai_providers ADD COLUMN free_confirmed INTEGER NOT NULL DEFAULT 1;

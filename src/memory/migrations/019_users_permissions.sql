-- Dashboard users, roles and per-WhatsApp-account permissions. ADDITIVE ONLY: no existing column, row or table is changed
-- except the new columns below, and every default keeps today's behaviour for the rows that already exist.
--
--   role             super_admin | admin | manager | user | custom.  Existing rows default to 'admin' (today: a full dashboard admin).
--   is_protected     1 = the permanent Super Admin: cannot be disabled, deleted, downgraded, re-assigned or have its password
--                    changed through the Users page. The OLDEST existing admin (the owner who ran first-time setup) is marked below.
--   disabled_at      set = the account cannot sign in and every session is rejected.
--   all_accounts     1 = may work on every current and future WhatsApp account (explicitly granted).
--   can_connection / can_configuration  explicit grants that let an 'admin' manage WhatsApp connections / sensitive configuration.
ALTER TABLE admin_users ADD COLUMN display_name TEXT;
ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE admin_users ADD COLUMN is_protected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN disabled_at TEXT;
ALTER TABLE admin_users ADD COLUMN all_accounts INTEGER NOT NULL DEFAULT 0;
-- Defaults of 1 keep today's behaviour for rows that already exist (every dashboard admin could do everything). Users created
-- from the Users page always write these explicitly (0 unless the Super Admin grants them).
ALTER TABLE admin_users ADD COLUMN can_connection INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admin_users ADD COLUMN can_configuration INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admin_users ADD COLUMN created_by INTEGER;

-- The permanent Super Admin = the account that already exists and was created by first-time setup (the lowest id).
UPDATE admin_users SET role = 'super_admin', is_protected = 1, all_accounts = 1
WHERE id = (SELECT MIN(id) FROM admin_users);

-- What each user may do on each WhatsApp account. A missing row = no access to that feature (deny by default).
-- Which accounts a user may open at all is still admin_account_access (unchanged).
CREATE TABLE IF NOT EXISTS admin_account_permissions (
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  whatsapp_account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('view', 'edit', 'manage')),
  PRIMARY KEY (admin_user_id, whatsapp_account_id, feature)
);

-- Who changed which user, and what (never a password, hash or token).
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_admin_id INTEGER,
  target_admin_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log (created_at DESC);

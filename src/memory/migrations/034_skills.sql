-- Business skills (docs/SKILLS.md). A skill itself is a reviewed Markdown file in the repository (skills/<id>/SKILL.md); nothing about its CONTENT lives in the database.
-- These two tables hold only what a business decides and what happened:
--   account_skills: whether this business switched a skill on (no row = the skill's own default, which is "off" unless its file says otherwise);
--   skill_runs: one audit row each time a skill took part in an AI answer (which skill, how it was chosen, how it ended, which tools it used). It never stores
--               the customer's text, the answer, a prompt or an error message — only short codes.
-- Additive: the previous build ignores both tables. Rollback: leave them in place (an old build never reads them).
CREATE TABLE IF NOT EXISTS account_skills (
  whatsapp_account_id INTEGER NOT NULL,
  skill_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (whatsapp_account_id, skill_id)
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_account_id INTEGER NOT NULL,
  skill_id TEXT NOT NULL,
  conversation_id INTEGER,
  selection TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  tools_used TEXT NOT NULL DEFAULT '',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_account ON skill_runs (whatsapp_account_id, id DESC);

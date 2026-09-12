CREATE TABLE IF NOT EXISTS business_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT,
  business_timezone TEXT,
  business_hours_start TEXT,
  business_hours_end TEXT,
  business_days TEXT,
  booking_duration_minutes INTEGER,
  booking_buffer_minutes INTEGER,
  restart_keywords TEXT,
  conversation_history_limit INTEGER,
  welcome_message TEXT,
  fallback_message TEXT,
  cancellation_policy TEXT,
  human_escalation_info TEXT,
  supported_languages TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO business_settings (id) VALUES (1);

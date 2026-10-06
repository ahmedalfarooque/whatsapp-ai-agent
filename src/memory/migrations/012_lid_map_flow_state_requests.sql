-- Linked-device (Baileys) addressing: WhatsApp increasingly delivers personal
-- chats under an opaque LID ("...@lid") and only sometimes attaches the real
-- phone JID (key.senderPn). Replies must go back to the address the message
-- arrived on, but the CUSTOMER must stay one record whichever address shows
-- up, so we remember every LID -> phone pairing we observe.
CREATE TABLE IF NOT EXISTS whatsapp_lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_lid_map_pn ON whatsapp_lid_map (pn);

-- Guided-menu state machine (main menu / submenus / appointment & quotation
-- steps) and the chat address the customer last wrote from.
ALTER TABLE customers ADD COLUMN menu_state TEXT;
ALTER TABLE customers ADD COLUMN flow_data TEXT;
ALTER TABLE customers ADD COLUMN reply_jid TEXT;

-- Structured requests collected by the WhatsApp menu flows (appointment
-- requests, quotation requests). Staff confirm them from the dashboard;
-- nothing here is a confirmed calendar booking.
CREATE TABLE IF NOT EXISTS customer_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  wa_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_requests_created ON customer_requests (created_at DESC);

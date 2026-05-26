-- schema/d1.sql
-- SIA — Cloudflare D1 Schema
-- Run with: wrangler d1 execute sia-db --file=schema/d1.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Users ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── Admins ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_active   TEXT
);

CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(email);

-- ── Sessions ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  admin_id   TEXT,
  role       TEXT NOT NULL CHECK(role IN ('user','admin')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent TEXT,
  ip_address TEXT,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_admin_id ON sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);

-- ── Conversations ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT 'New conversation',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT,
  expiry_state TEXT NOT NULL DEFAULT 'active' CHECK(expiry_state IN ('active','expiring','expired')),
  preserved    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id    ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
CREATE INDEX IF NOT EXISTS idx_conversations_expires_at ON conversations(expires_at);

-- ── Messages ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('pending','streaming','done','cancelled')),
  image_meta_id   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (image_meta_id)   REFERENCES image_meta(id)   ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_status          ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at      ON messages(created_at);

-- ── Image Metadata ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS image_meta (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  storage_key  TEXT NOT NULL,
  url          TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_image_meta_user_id ON image_meta(user_id);

-- ── Reactions ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('up','down')),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user_id    ON reactions(user_id);

-- ── Memory (user-visible) ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);

-- ── Internal Notes (admin-only) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS internal_notes (
  id              TEXT PRIMARY KEY,
  admin_id        TEXT NOT NULL,
  target_type     TEXT NOT NULL CHECK(target_type IN ('user','conversation','message')),
  target_id       TEXT NOT NULL,
  content         TEXT NOT NULL,
  highlight_text  TEXT,
  tag             TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_target ON internal_notes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_notes_admin  ON internal_notes(admin_id);

-- ── Citations ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS citations (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  title      TEXT,
  url        TEXT NOT NULL,
  domain     TEXT,
  excerpt    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_citations_message_id ON citations(message_id);

-- ── Presence ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS presence (
  user_id         TEXT PRIMARY KEY,
  conversation_id TEXT,
  state           TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','away','offline')),
  is_typing       INTEGER NOT NULL DEFAULT 0,
  tab_visible     INTEGER NOT NULL DEFAULT 1,
  last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent      TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_presence_conversation ON presence(conversation_id);
CREATE INDEX IF NOT EXISTS idx_presence_last_seen    ON presence(last_seen);

-- ── Admin Assignments ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS assignments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  admin_id        TEXT NOT NULL,
  assigned_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id)        REFERENCES admins(id)        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assignments_admin_id ON assignments(admin_id);

-- ── Typing State (streaming buffer) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS typing_state (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  partial_content TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (message_id)      REFERENCES messages(id)       ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)  ON DELETE CASCADE
);

-- ── Share Tokens ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS share_tokens (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  token           TEXT NOT NULL UNIQUE,
  expires_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_token ON share_tokens(token);

-- ── Settings ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('chat_expiry_days',      '30'),
  ('expiry_warning_days',   '3'),
  ('max_message_length',    '32000'),
  ('max_image_size_mb',     '10'),
  ('registration_enabled',  'true');

-- ── Analytics Events ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics (
  id              TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  user_id         TEXT,
  conversation_id TEXT,
  message_id      TEXT,
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_event_type  ON analytics(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_user_id     ON analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_created_at  ON analytics(created_at);

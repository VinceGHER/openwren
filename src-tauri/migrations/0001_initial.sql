-- OpenWren schema, version 1. See PLAN.md section 3.
-- Secrets (passwords, OAuth tokens) are never stored here; they live in the system keyring.
-- Dates are Unix seconds (UTC).

CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  address       TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN ('gmail', 'imap', 'pop3')),
  -- Server hosts, ports and security, and per-account sync settings, as JSON.
  settings      TEXT NOT NULL DEFAULT '{}',
  position      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folders (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'custom'
                CHECK (role IN ('inbox', 'drafts', 'sent', 'trash', 'junk', 'archive', 'custom')),
  favorite      INTEGER NOT NULL DEFAULT 0,
  uid_validity  INTEGER,
  uid_next      INTEGER,
  highest_modseq INTEGER,
  UNIQUE (account_id, path)
);

CREATE TABLE threads (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id     INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  message_id    TEXT,            -- Message-ID header
  in_reply_to   TEXT,
  refs          TEXT,            -- References header
  from_name     TEXT NOT NULL DEFAULT '',
  from_address  TEXT NOT NULL DEFAULT '',
  to_list       TEXT NOT NULL DEFAULT '',
  cc_list       TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  preview       TEXT NOT NULL DEFAULT '',
  date          INTEGER NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  unread        INTEGER NOT NULL DEFAULT 1,
  flagged       INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  focused       INTEGER NOT NULL DEFAULT 1,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  snoozed_until INTEGER,
  categories    TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX messages_by_date ON messages (account_id, date DESC);
CREATE INDEX messages_by_thread ON messages (thread_id);
CREATE INDEX messages_by_message_id ON messages (message_id);

-- A message can sit in several folders (Gmail labels); one row per placement.
CREATE TABLE message_folders (
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  folder_id     INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid           INTEGER,         -- server UID in that folder (IMAP) or NULL (POP3, local)
  PRIMARY KEY (message_id, folder_id)
);
CREATE INDEX message_folders_by_folder ON message_folders (folder_id, uid);

CREATE TABLE bodies (
  message_id    INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  html          TEXT,            -- sanitised
  plain         TEXT
);

CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL DEFAULT 0,
  content_id    TEXT,
  cache_path    TEXT             -- set once downloaded
);
CREATE INDEX attachments_by_message ON attachments (message_id);

CREATE TABLE contacts (
  address       TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used     INTEGER
);

CREATE TABLE signatures (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  html          TEXT NOT NULL DEFAULT '',
  plain         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE signature_defaults (
  account_id    INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  new_id        INTEGER REFERENCES signatures(id) ON DELETE SET NULL,
  reply_id      INTEGER REFERENCES signatures(id) ON DELETE SET NULL
);

CREATE TABLE rules (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0,
  conditions    TEXT NOT NULL DEFAULT '[]',
  actions       TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE outbox (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  raw           BLOB NOT NULL,   -- the complete message, ready to send
  send_after    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

-- Server operations waiting to be replayed (move, flag, delete).
CREATE TABLE pending_ops (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

-- Full-text index; rowid is messages.id. Kept in step by the sync code.
CREATE VIRTUAL TABLE search_index USING fts5 (
  subject, sender, recipients, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_delete_search AFTER DELETE ON messages BEGIN
  DELETE FROM search_index WHERE rowid = old.id;
END;

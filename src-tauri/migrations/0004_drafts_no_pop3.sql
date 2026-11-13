-- Version 4: drafts kept on this computer; POP3 support removed.

-- A message being written. `content` is the composer's state as JSON.
CREATE TABLE drafts (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

DROP TABLE pop3_seen;

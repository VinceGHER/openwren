-- Version 2: sending, queued server operations, conversations, POP3.

-- Conversations: messages that share a key belong to one thread.
ALTER TABLE messages ADD COLUMN thread_key TEXT;
UPDATE messages SET thread_key = CASE
  WHEN refs IS NOT NULL AND refs != '' THEN substr(refs, 1, instr(refs || ' ', ' ') - 1)
  WHEN in_reply_to IS NOT NULL AND in_reply_to != '' THEN in_reply_to
  ELSE message_id END;
CREATE INDEX messages_by_thread_key ON messages (account_id, thread_key);

-- Outbox rows carry what the sender needs besides the raw message.
ALTER TABLE outbox ADD COLUMN mail_from TEXT NOT NULL DEFAULT '';
ALTER TABLE outbox ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbox ADD COLUMN to_list TEXT NOT NULL DEFAULT '';
ALTER TABLE outbox ADD COLUMN subject TEXT NOT NULL DEFAULT '';

-- Queued operations wait a few seconds so they can be undone.
ALTER TABLE pending_ops ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0;

-- POP3 has no folders or flags; remember which messages were already downloaded.
CREATE TABLE pop3_seen (
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uidl          TEXT NOT NULL,
  PRIMARY KEY (account_id, uidl)
);

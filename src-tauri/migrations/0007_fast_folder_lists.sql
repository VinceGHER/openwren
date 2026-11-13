-- Version 7: opening a folder must not get slower as the mailbox grows.

-- A folder's messages in date order, straight from an index: the list reads its
-- first 100 rows and stops, instead of sorting the whole folder.
ALTER TABLE message_folders ADD COLUMN date INTEGER NOT NULL DEFAULT 0;
UPDATE message_folders SET date = (SELECT date FROM messages WHERE messages.id = message_folders.message_id);
CREATE INDEX message_folders_by_date ON message_folders (folder_id, date DESC, message_id DESC);

-- Unread and pinned mail are small sets; find them without walking every message.
CREATE INDEX messages_unread ON messages (id) WHERE unread = 1;
CREATE INDEX messages_pinned ON messages (id) WHERE pinned = 1;

-- Snoozed mail is checked every second to see whether any is due; that must not read the mailbox.
CREATE INDEX messages_snoozed ON messages (snoozed_until) WHERE snoozed_until IS NOT NULL;

-- Version 11: a file with a Content-ID is an attachment unless the message text shows it.
-- Messages stored under the old rule (every part with a Content-ID is hidden) are
-- downloaded again, so their files are listed and counted the new way. Only rows that
-- were hidden under the old rule have a content id; from now on none is stored.

-- A saved forward remembers the files it takes along by their position in the original,
-- and those positions change for such a message. Its files are dropped from the draft
-- rather than sending a different file than the one shown; the text is kept.
UPDATE drafts SET content = json_remove(content, '$.forwarded')
 WHERE json_valid(content)
   AND json_extract(content, '$.forwarded.messageId') IN (SELECT message_id FROM attachments WHERE content_id IS NOT NULL);

DELETE FROM bodies WHERE message_id IN (SELECT message_id FROM attachments WHERE content_id IS NOT NULL);
DELETE FROM attachments WHERE message_id IN (SELECT message_id FROM attachments WHERE content_id IS NOT NULL);

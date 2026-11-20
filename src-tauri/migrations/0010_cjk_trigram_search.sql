-- Version 9: upgrade search_index to trigram tokenizer for CJK full-text search.
--
-- The default unicode61 tokenizer splits words on whitespace, causing continuous
-- CJK characters to be indexed as a single token. Recreate search_index with the
-- native SQLite trigram tokenizer and rebuild indexes from existing messages.

DROP TRIGGER IF EXISTS messages_delete_search;
DROP TABLE IF EXISTS search_index;

CREATE VIRTUAL TABLE search_index USING fts5 (
  subject, sender, recipients, body,
  tokenize = 'trigram'
);

CREATE TRIGGER messages_delete_search AFTER DELETE ON messages BEGIN
  DELETE FROM search_index WHERE rowid = old.id;
END;

INSERT INTO search_index (rowid, subject, sender, recipients, body)
SELECT 
  m.id, 
  m.subject, 
  m.from_name || ' ' || m.from_address, 
  m.to_list || ' ' || m.cc_list, 
  COALESCE(b.plain, '')
FROM messages m
LEFT JOIN bodies b ON b.message_id = m.id;

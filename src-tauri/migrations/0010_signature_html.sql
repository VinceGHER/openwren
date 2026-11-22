-- Version 10: a signature can be written directly as HTML.

-- 1 when the user wrote the signature's HTML by hand. The editor then shows the
-- source, because the rich-text editor would drop what it cannot hold (tables, colours).
ALTER TABLE signatures ADD COLUMN raw_html INTEGER NOT NULL DEFAULT 0;

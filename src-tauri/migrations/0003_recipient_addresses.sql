-- Version 3: keep full recipient addresses, so "Reply all" can address everyone.
ALTER TABLE messages ADD COLUMN to_addresses TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN cc_addresses TEXT NOT NULL DEFAULT '';

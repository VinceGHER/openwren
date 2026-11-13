-- Version 5: sender checks, unsubscribe, drafts on the server, signature images.

-- Results of the receiving server's sender checks, such as "spf=pass;dkim=pass;dmarc=fail".
-- NULL until the message's headers have been read for it.
ALTER TABLE messages ADD COLUMN auth TEXT;
-- How to unsubscribe from a mailing, as JSON; empty when the message offers none.
ALTER TABLE messages ADD COLUMN unsubscribe TEXT NOT NULL DEFAULT '';

-- The Message-ID a draft carries on the server, so its copy there can be replaced.
ALTER TABLE drafts ADD COLUMN message_id TEXT;

-- 'text', 'left' (image left of the text) or 'above'; the image is a data URL.
ALTER TABLE signatures ADD COLUMN layout TEXT NOT NULL DEFAULT 'text';
ALTER TABLE signatures ADD COLUMN image TEXT NOT NULL DEFAULT '';

-- Version 8: sender checks are read more strictly.
--
-- A DKIM signature now counts only when the From domain made it, and text the
-- sender controls (comments, quoted strings) is no longer read as a result.
-- Forget the stored results so they are read again in the background.
UPDATE messages SET auth = NULL;

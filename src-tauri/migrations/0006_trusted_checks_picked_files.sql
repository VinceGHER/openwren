-- Version 6: sender checks are tied to the mail server that made them; files chosen for attaching.

-- Files the user chose in the file dialog. Only these may be attached to a message.
CREATE TABLE picked_files (
  path          TEXT PRIMARY KEY
);

-- Sender checks now record which server made them ("id=mx.example.com;spf=pass;...").
-- Forget the old results so they are read again in the background.
UPDATE messages SET auth = NULL;

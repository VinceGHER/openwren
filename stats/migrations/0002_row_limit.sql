-- How many counter rows each day has, so the Worker can stop creating new ones
-- past a limit without counting the table on every request. Requests beyond the
-- limit are still counted, folded into "other" rows.
CREATE TABLE day_rows (
  day   TEXT    PRIMARY KEY,           -- server UTC date, YYYY-MM-DD
  rows  INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

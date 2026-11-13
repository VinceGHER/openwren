-- One row per combination of coarse facts per day; `n` is how many requests
-- had exactly that combination. No request is stored, and nothing finer than
-- the day is recorded.
CREATE TABLE counters (
  day   TEXT    NOT NULL,              -- server UTC date, YYYY-MM-DD
  v     TEXT    NOT NULL,              -- app version
  pkg   TEXT    NOT NULL,              -- deb | rpm | appimage | flatpak | other
  os    TEXT    NOT NULL,              -- e.g. ubuntu-24.04, or other
  arch  TEXT    NOT NULL,              -- x86_64 | aarch64 | other
  d     INTEGER NOT NULL,              -- 1 = sender's first request today
  w     INTEGER NOT NULL,              -- 1 = first this week
  m     INTEGER NOT NULL,              -- 1 = first this month
  first INTEGER NOT NULL,              -- 1 = first ever
  iw    TEXT    NOT NULL,              -- ISO week of install, e.g. 2026-W46
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, v, pkg, os, arch, d, w, m, first, iw)
) WITHOUT ROWID;

# OpenWren usage counter

A small Cloudflare Worker with a D1 database that answers one question: how
many people use OpenWren each day, without knowing who any of them are. It
works the way the Brave browser counts its users. The app sends at most one
small request a day that carries no identifier, and this service adds one to a
counter. The requests themselves are never kept.

It will run at `https://stats.openwren.app`.

## What is stored, and what is not

The app sends this once a day (`POST /ping`):

```json
{ "v": "0.1.0", "pkg": "deb", "os": "ubuntu-24.04", "arch": "x86_64",
  "d": true, "w": true, "m": false, "first": false, "iw": "2026-W46" }
```

| Field   | Meaning                                                                 |
|---------|-------------------------------------------------------------------------|
| `v`     | App version                                                             |
| `pkg`   | How it was installed: `deb`, `rpm`, `appimage`, `flatpak`, `other`      |
| `os`    | Distribution and version, such as `ubuntu-24.04`                        |
| `arch`  | `x86_64` or `aarch64`                                                   |
| `d`     | This is the sender's first request today                                |
| `w`     | ... its first this week                                                 |
| `m`     | ... its first this month                                                |
| `first` | ... its first ever                                                      |
| `iw`    | The ISO week in which the app was first used                            |

**Stored:** one table, `counters`. Each row is one combination of
`(day, v, pkg, os, arch, d, w, m, first, iw)` and a number `n`: how many
requests had exactly that combination. `day` is the server's UTC date. That is
the whole database (see `migrations/0001_counters.sql`).

**Not stored:** no IP address, no user agent, no request headers, no install
or device id (the app does not have one), no time finer than the day, and no
copy of any request. Values outside the fixed lists are stored as `other`, so
an unusual system cannot stand out. The Worker does not log, and Workers
observability and logs are switched off in `wrangler.toml`; leave them off.

## Endpoints

### `POST /ping`

Answers `204` when counted. Answers `400` when the body is not valid JSON, is
larger than 1 KB, or a field is missing or of the wrong type (`v` must look
like `1.2.3`, `iw` like `2026-W46`, the four flags must be `true`/`false`).
Unknown extra fields are ignored. An unknown `pkg`, `os` or `arch` is counted
as `other`. `os` is accepted when it is one of ubuntu, debian, fedora, arch,
linuxmint, pop, opensuse, opensuse-tumbleweed, opensuse-leap, manjaro, nixos,
rhel, centos, rocky, almalinux, zorin, elementary, endeavouros, kali,
optionally followed by `-` and a version of up to 8 digits and dots.

### `GET /api/daily?days=N`

`days` defaults to 90 and is capped at 365 (a larger number is treated as
365; `0`, negative or non-numeric gives `400`). The period is the last N UTC
days ending today.

```json
{
  "days": [{ "day": "2026-11-13", "daily": 12, "weekly": 40, "monthly": 95, "new": 3 }],
  "byVersion": [{ "name": "0.1.0", "count": 300 }],
  "byPackage": [{ "name": "deb", "count": 200 }],
  "bySystem":  [{ "name": "ubuntu-24.04", "count": 120 }]
}
```

`days` has one entry for every day of the period, oldest first, including days
with no requests (all zeros). **What the numbers mean, for dashboard labels:**

- `daily`: requests that day with `d` true. This is the number of people who
  used the app that day (daily active users).
- `weekly`: requests that day with `w` true, that is, people whose *first use
  of that week* fell on that day. It is **not** a rolling 7-day figure. Add up
  the `weekly` values of one calendar week (ISO week, Monday to Sunday) to get
  that week's users.
- `monthly`: the same with `m`: people whose first use of that calendar month
  fell on that day. Add up a calendar month to get that month's users.
- `new`: requests that day with `first` true: new installations.

Weeks and months are judged by the app from its own clock in UTC, while `day`
is the server's UTC date, so a request sent around midnight can land on the
neighbouring day. Totals are not affected.

`byVersion`, `byPackage` and `bySystem` count `d` requests over the whole
period (so they are user-days, not distinct people), largest first. Any group
with fewer than 5 is added into a single `other` entry, together with what was
already stored as `other`, so small groups cannot be singled out. The `other`
entry is sorted by its count like any other.

The response allows cross-site `GET` from `https://openwren.app` and from
`http://localhost` on any port, and is cacheable for 10 minutes
(`Cache-Control: public, max-age=600`).

Any other path answers `404`; a known path with the wrong method answers `405`.

## Layout

- `src/counting.ts`: validation and aggregation, pure functions with no
  Cloudflare dependency.
- `src/index.ts`: the Worker entry; wires those functions to D1.
- `migrations/0001_counters.sql`: the one table.
- `test/`: vitest. `counting.test.ts` tests the pure functions;
  `worker.test.ts` runs the Worker entry against Node's built-in SQLite, set up
  from the same migration file.

## Run it locally

Needs Node 22.5 or newer (24 recommended) and pnpm. Nothing here contacts
Cloudflare or needs a login. From the repository root:

```sh
pnpm --dir stats install
pnpm --dir stats test

cd stats
pnpm exec wrangler d1 migrations apply openwren-stats --local   # creates the local database in .wrangler/
pnpm exec wrangler dev --local --port 8787
```

In another terminal:

```sh
# Count one request: prints 204
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/ping \
  -H 'Content-Type: application/json' \
  -d '{"v":"0.1.0","pkg":"deb","os":"ubuntu-24.04","arch":"x86_64","d":true,"w":true,"m":false,"first":false,"iw":"2026-W46"}'

# A malformed request: prints 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/ping \
  -H 'Content-Type: application/json' -d '{"v":"0.1.0"}'

# Read the counts back
curl -s 'http://localhost:8787/api/daily?days=7'

# Look at the table itself
pnpm exec wrangler d1 execute openwren-stats --local --command 'SELECT * FROM counters'
```

Delete `stats/.wrangler/` to start again with an empty local database.

## Deploy

The service is live at `stats.openwren.app`; its database id and the route are
in `wrangler.toml`. To deploy a change, from `stats/`:

1. Log in once: `pnpm exec wrangler login`
2. If a migration was added:
   `pnpm exec wrangler d1 migrations apply openwren-stats --remote`
3. Deploy: `pnpm exec wrangler deploy`
4. Check it:
   `curl -s 'https://stats.openwren.app/api/daily?days=1'`

Keep `[observability]` disabled in `wrangler.toml`, and do not add Logpush or
other request logging on the `stats.openwren.app` hostname in the Cloudflare
dashboard: either would keep per-request records that this service promises
not to keep.

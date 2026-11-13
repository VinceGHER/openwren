---
layout: ../layouts/Base.astro
title: Privacy
description: Every network request OpenWren makes, what the daily usage request contains, and what is never collected.
---

# Privacy

OpenWren keeps your mail on your computer. This page lists every network request the app makes.

## Every network request

| Request | When | Goes to |
|---|---|---|
| Mail sync and sending (IMAP and SMTP) | Whenever the app syncs or you send mail | Your mail servers |
| Google sign-in | Only if you choose to sign in with Google | Google |
| Remote images | Only when you click "Show images" on a message | The servers the message points to |
| Unsubscribe | Only when you confirm that you want to unsubscribe from a mailing | The mailing's sender |
| Anonymous usage request | Once a day, unless you switch it off | `stats.openwren.app` |

There are no others. Sender logos for well-known companies are bundled with the app and are not fetched online.

## The anonymous usage request

Once a day the app sends one small request so the project can count how many people use it. It is on by default. To switch it off, open Settings → Privacy.

The request carries:

- the app version
- the package type (for example `deb`)
- the distribution and its version
- the processor type
- whether this is the first request today, this week, this month, and ever
- the week the app was installed

It carries no identifier of any kind, and the IP address is not stored. The server adds one to its counters. The totals are public on the [stats page](/stats/).

This is the whole request body:

```json
{ "v": "0.1.0", "pkg": "deb", "os": "ubuntu-24.04", "arch": "x86_64", "d": true, "w": true, "m": false, "first": false, "iw": "2026-W46" }
```

| Field | Meaning |
|---|---|
| `v` | App version |
| `pkg` | Package type |
| `os` | Distribution and version |
| `arch` | Processor type |
| `d`, `w`, `m` | First request today, this week, this month |
| `first` | First request ever from this installation |
| `iw` | Week of installation |

## Never collected

OpenWren never collects:

- mail addresses
- names
- subjects
- mail text
- contacts
- folder names or server names

## On your computer

- The mail database is encrypted with SQLCipher. Its key is kept in the system keyring.
- Passwords and sign-in tokens are kept in the system keyring.
- Tracking pixels and tracking codes in links are removed from mail before it is shown.

## This website

This site sets no cookies and uses no analytics, no third-party scripts and no third-party fonts. The stats page fetches public totals from `stats.openwren.app`. The home page shows one picture, the chart of GitHub stars, that your browser loads from `api.star-history.com`.

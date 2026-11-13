<p align="center">
  <img src="design/openwren-logo.svg" alt="OpenWren logo" width="96">
</p>

# OpenWren

A free, open-source mail app for Linux that keeps your mail on your computer.
Gmail and any IMAP account, one inbox for all of them, search that reaches
back years, and protection against trackers and phishing built in.

If you like it, please star it.

| Inbox | A suspicious message |
| --- | --- |
| ![The inbox with a message open](docs/inbox.png) | ![A message flagged as suspicious, with the reasons listed](docs/warning.png) |

<p align="center">
  <img src="docs/welcome.png" alt="The welcome screen" width="49%">
  <img src="docs/inbox-dark.png" alt="The inbox in the dark theme" width="49%">
</p>

## Why OpenWren

- **Free.** No price, no account with us, no ads, no upsell.
- **Open source.** Apache-2.0. Every line is public: read it, build it, fork it.
- **Built because I could not find a mail app for Linux that I liked.** I wanted
  something modern, fast and private, so I wrote it.
- **Private.** Mail is stored encrypted on your computer. Trackers are removed
  and suspicious mail is flagged before you click.

## Fast

Measured on this project's own benchmarks, on an encrypted mailbox of 200,000
messages (Intel Core Ultra 7 155H laptop, Ubuntu 26.04):

| | |
| --- | --- |
| Start the app until the inbox is on screen | **0.6 s** |
| Open a folder | **0.1 ms** |
| Open a message | **0.05 ms** |
| Search for a word found in a few hundred messages | **30 ms** |
| Search for a word found in most of the mailbox | 185 ms |
| Sync from a local server | 2,750 headers and 540 message texts per second |
| Processor use while idle in the tray | 0.2% of one core |
| Memory with the inbox open | 288 MB, mostly the system web view |
| Download | 14 MB |

Folder and message times are the database work in the Rust engine; drawing
them on screen comes on top. Start-up, memory and idle use were measured on a
50,000-message mailbox.

Method, all numbers and how to rerun them: [docs/benchmarks.md](docs/benchmarks.md).

## Install

Packages are not published yet. Until the first release, build from source
(below). After it, these will work:

**Debian, Ubuntu and derivatives**

```bash
curl -fsSL https://packages.openwren.org/key.gpg | sudo tee /usr/share/keyrings/openwren.gpg > /dev/null
```

```bash
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/openwren.gpg] https://packages.openwren.org/apt stable main" | sudo tee /etc/apt/sources.list.d/openwren.list
```

```bash
sudo apt update && sudo apt install openwren
```

**Fedora and other dnf systems**

```bash
sudo curl -fsSL -o /etc/yum.repos.d/openwren.repo https://packages.openwren.org/rpm/openwren.repo
```

```bash
sudo dnf install openwren
```

**AppImage:** download it from the [latest release](https://github.com/VinceGHER/openwren/releases/latest), make it executable and run it.

### Build from source

You need Node.js 22 or later with pnpm, Rust 1.77 or later, and Tauri's Linux libraries:

```bash
sudo apt install -y rustc cargo libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev pkg-config
```

```bash
pnpm install
```

```bash
pnpm tauri build --bundles deb
```

The package lands in `src-tauri/target/release/bundle/deb/`. To add the app to
your menu without installing the package, run `sh scripts/install-launcher.sh`.

## Adding your mail

- **Gmail:** choose Google, then follow the three steps to create an app
  password in your Google account (it needs 2-step verification). Advanced:
  sign in with Google using your own OAuth client ID.
- **Any other account:** enter your address and password; the server names are
  guessed from the address and can be corrected.

Passwords are stored in the system keyring, never in OpenWren's files.

## Features

| | |
| --- | --- |
| Accounts | Gmail and IMAP, several at once, "All inboxes", favourites |
| Reading | Three panes, conversations, unread and flagged filters, mailings under "Other" |
| Search | The whole mailbox, with `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `before:2024-01-31`, `in:folder`, and server search for text not downloaded yet |
| Writing | Rich text, quick reply under each message, signatures with a picture, attachments, undo send, send later, drafts kept on the server |
| Organising | Archive, delete, move, drag and drop, snooze, pin, colour categories, rules, mark a folder read, undo |
| Protection | Tracking pixels and tracking link codes removed; warnings for forged senders, look-alike addresses and misleading links; block a sender or a domain; one-click unsubscribe; programs in attachments are never opened |
| Look | Light and dark, three fonts, text size, 24-hour or AM/PM, tray icon with notifications |

## Privacy

OpenWren has no server of its own that sees your mail. It talks to your mail
servers, and to nobody else unless you ask (showing remote images, signing in
with Google, unsubscribing).

One thing is on by default: once a day the app sends an anonymous request so
the project can count how many people use it. It carries the app version, the
kind of package and system, and nothing that identifies you; the server keeps
only totals. Switch it off in Settings → Privacy, where "Show what is sent"
displays the exact request. Details: [PRIVACY.md](PRIVACY.md).

## Built with

| Part | What it does | Why |
| --- | --- | --- |
| **Rust** | The engine: sync, parsing, search, sending, encryption | Memory-safe and fast, with no pauses for garbage collection |
| **Tauri 2** | The window, using the system's WebKitGTK | No bundled browser engine, so the download is about 14 MB |
| **SQLite + SQLCipher + FTS5** | Local storage, encrypted, with full-text search | One file, no database server, search that stays quick on large mailboxes |
| **tokio, async-imap, lettre, mail-parser, ammonia, rustls, keyring** | Mail protocols, parsing, HTML cleaning, TLS, credentials | Small, focused Rust libraries |
| **React 19, TypeScript, Vite, Tailwind CSS 4, zustand, TipTap** | The interface | Quick to build and change |

## How it works

The interface never touches the network or the database. It calls commands in
the Rust engine and listens for events; everything it shows is read from the
local database, which is why lists and messages appear at once.

For each account a background task keeps that database in step with the server:

1. Send the changes you made (moves, flags, drafts), queued if you were offline.
2. Fetch the folder list, then every folder's headers and flags, inbox first.
3. Download the text of the newest messages straight away, the rest in the background.
4. Wait for the server to announce new mail (IMAP IDLE), which arrives within a second or two.

Mail HTML is sanitised in Rust, then shown in a sandboxed frame with scripts off
and network access blocked until you choose "Show images".

```
src/                 interface (React, TypeScript)
  backend/           the only place that calls the engine; sample mail for `pnpm dev`
  features/          screens: folders, list, reading pane, composer, settings, welcome
src-tauri/src/       engine (Rust)
  lib.rs             commands the interface calls, background tasks
  sync.rs imap.rs    keeping the local database in step with the server
  db.rs              all the SQL
  parse.rs           reading and cleaning mail
  smtp.rs oauth.rs   sending, Google sign-in
stats/               the usage counter (Cloudflare Worker)
website/             openwren.org (Astro)
```

## Tests

```bash
pnpm typecheck && pnpm test
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

The end-to-end tests run against a local Dovecot mail server (needs Docker):

```bash
sh tests/mail-server.sh
```

```bash
OPENWREN_TEST_IMAP=127.0.0.1:3143 OPENWREN_TEST_SMTP=127.0.0.1:3025 cargo test --manifest-path src-tauri/Cargo.toml
```

`pnpm dev` runs the interface in a browser on sample mail, with no mail server
and no desktop app. `node scripts/screenshots.mjs` takes the screenshots above
from it.

## Contributing

Bug reports, fixes and ideas are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for how to build, test and send a change, and [SECURITY.md](SECURITY.md) for
reporting a vulnerability privately.

## Known limits

- Linux only.
- One-click "Sign in with Google" for everyone needs Google's approval of the
  app, which has not been requested yet. Until then Gmail uses an app password.
- Categories, pins and snoozes are stored on this computer, not on the server.
- Server-side search understands plain ASCII words only.
- HTML mail is always shown on a white background, also in the dark theme.
- Blocking a sender moves their mail when OpenWren syncs, so it only works while the app runs.
- No Flatpak and no in-app update yet.

## Licence

[Apache-2.0](LICENSE). The name "OpenWren" and the logo are not covered by it;
see [TRADEMARKS.md](TRADEMARKS.md). Third-party components are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

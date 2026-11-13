# OpenWren — project plan

An open-source desktop mail client for Linux. It borrows the familiar three-pane layout of the new Outlook but has its own modern look; it is not a visual copy.
Mail only: no calendar, contacts or to-do modules.

Design reference: [design/mockup.html](design/mockup.html) (open it in a browser).

## 1. Decisions

| Topic | Decision |
|---|---|
| Scope | Mail only. No app rail. |
| Accounts | Gmail (Google sign-in), generic IMAP, POP3 |
| Gmail login | OAuth 2 browser sign-in only (no app passwords) |
| Platform | Linux only for v1 (AppImage and .deb) |
| App shell | Tauri 2: Rust backend, web interface |
| Interface | React + TypeScript + Vite, own design system (Tailwind CSS + Radix UI primitives) |
| Look | OpenWren's own style: soft light-blue header and accents, pill controls, rounded cards. No Outlook ribbon. |
| Licence | Apache-2.0 (first planned as GPL-3.0) |
| Must-haves | Search across the whole mailbox including mail 1–2+ years old; signatures |

## 2. Architecture

```
┌───────────────────────────── Tauri window (WebKitGTK) ─────────────────────────────┐
│  React UI (TypeScript)                                                             │
│  folder pane · message list · reading pane · composer · search · settings          │
└───────────────▲──────────────────────────────────────────────┬─────────────────────┘
                │ events (new-mail, sync-progress, …)          │ invoke (commands)
┌───────────────┴──────────────────────────────────────────────▼─────────────────────┐
│  Rust core                                                                         │
│  commands  →  services (accounts, sync, send, search, signatures, rules)           │
│  protocol adapters: IMAP · POP3 · SMTP · Google OAuth                              │
│  storage: SQLite (+ FTS5 index) · attachment cache on disk · system keyring        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Rules of the design:

- The interface never talks to a mail server. It only calls Rust commands and listens to events.
- The interface always reads from the local database, so it is instant and works offline. Sync runs in the background and emits events when data changes.
- Every user action (move, delete, flag, send) is applied to the local database first, then queued and replayed to the server. Failed operations are retried and surfaced in the UI.

### 2.1 Libraries

Backend (Rust). Versions and APIs are to be confirmed against current documentation at the start of each milestone.

| Purpose | Crate |
|---|---|
| Async runtime | `tokio` |
| IMAP | `async-imap` |
| POP3 | `async-pop3` |
| SMTP | `lettre` |
| Parse / build messages | `mail-parser`, `mail-builder` |
| Database | `rusqlite` (bundled SQLite with FTS5) |
| OAuth 2 | `oauth2` (PKCE, loopback redirect) |
| Secrets | `keyring` (Secret Service: GNOME Keyring / KWallet) |
| HTML sanitising | `ammonia` |
| TLS | `rustls` |
| Shared types Rust → TypeScript | `tauri-specta` (generates typed command bindings) |
| Notifications, tray, open links | Tauri plugins (`notification`, `opener`), built-in tray |

Frontend (TypeScript):

| Purpose | Package |
|---|---|
| Styling | `tailwindcss`, with the tokens from section 6.2 as CSS variables |
| Accessible behaviour (menus, dialogs, tabs, tooltips) | `radix-ui` primitives, styled by us |
| Icons | `@tabler/icons-react` (MIT, the set used in the mockup) |
| State | `zustand` (UI state), `@tanstack/react-query` (data from Rust) |
| Long lists | `@tanstack/react-virtual` |
| Composer and signature editor | `tiptap` |
| Extra sanitising in the reading pane | `dompurify` |
| Tests | `vitest`, `playwright` |

### 2.2 Repository layout

```
openwren/
├── PLAN.md
├── LICENSE                     Apache-2.0
├── design/mockup.html          static design reference
├── src/                        React interface
│   ├── app/                    shell, routing, theme
│   ├── features/
│   │   ├── folders/  messages/  reader/  composer/
│   │   ├── search/   accounts/  settings/
│   ├── components/             shared UI pieces
│   └── bindings.ts             generated from Rust
├── src-tauri/                  Rust core
│   ├── src/
│   │   ├── commands/           functions callable from the UI
│   │   ├── services/           accounts, sync, send, search, rules
│   │   ├── protocols/          imap.rs, pop3.rs, smtp.rs, oauth_google.rs
│   │   ├── store/              schema, migrations, queries
│   │   └── main.rs
│   └── tauri.conf.json
└── tests/                      end-to-end tests, Docker mail server
```

## 3. Data model (SQLite)

| Table | Holds |
|---|---|
| `accounts` | address, display name, type (gmail / imap / pop3), server settings, sync settings. No secrets. |
| `folders` | per account: path, role (inbox, sent, drafts, trash, junk, archive), UIDVALIDITY, sync cursors, unread count, favourite flag |
| `messages` | headers: from, to, cc, subject, date, Message-ID, References, flags, size, preview text, thread id, has-attachment, pinned, snoozed-until, category ids, focused/other |
| `message_folders` | which folder(s) a message is in, with its server UID (a Gmail message can carry several labels) |
| `bodies` | sanitised HTML and plain text, fetched on demand or by background sync |
| `attachments` | name, type, size, content id, path in the on-disk cache when downloaded |
| `threads` | conversation grouping |
| `contacts` | addresses seen in mail, with use counts, for autocomplete |
| `signatures` | name, HTML, plain text |
| `signature_defaults` | per account: signature for new mail, signature for replies and forwards |
| `rules` | conditions and actions |
| `outbox` | messages waiting to be sent, send-later time, attempts, last error |
| `pending_ops` | queued server operations (move, flag, delete) |
| `settings` | key / value |
| `search_index` | FTS5 virtual table over subject, sender, recipients, body text |

Passwords and OAuth tokens are stored only in the system keyring, keyed by account id.

## 4. Mail engine

### 4.1 IMAP

- Discover folders and their roles (SPECIAL-USE, with name-based fallback).
- **Initial sync, in two passes:**
  1. Headers and flags for every message in every folder, newest first, with no age limit. This is what makes old mail searchable by sender and subject straight away.
  2. Bodies, newest first, in the background, until the limit set in "Sync and storage" (default: everything).
- Incremental sync by UID; use CONDSTORE / QRESYNC when the server offers them, otherwise compare flags in windows.
- IDLE on the inbox for push-style delivery; other folders are polled on a timer.
- Handle UIDVALIDITY changes by resyncing the folder.
- Reconnect with back-off; one connection pool per account.

### 4.2 Gmail

- Uses the IMAP and SMTP engine with XOAUTH2 authentication.
- Sign-in: system browser, PKCE, redirect to a temporary `127.0.0.1` port. Scope: `https://mail.google.com/`. Refresh token in the keyring; access tokens refreshed automatically.
- Gmail specifics: labels appear as folders; de-duplicate using `X-GM-MSGID`; conversations from `X-GM-THRID`; server search through `X-GM-RAW`.
- The Google OAuth client ID is entered in settings (see section 9, risk 1).

### 4.3 POP3

- Download new messages using UIDL to track what has been seen.
- Option: leave messages on the server, or delete after N days.
- Folders, flags, categories and search are local only.
- Sending uses a separately configured SMTP server.

### 4.4 Sending

- Build the message (HTML plus plain-text alternative, inline images, attachments), place it in `outbox`, send by SMTP, then save a copy to the Sent folder (skipped for Gmail, which does this itself).
- Undo send: a configurable delay (default 10 seconds) before the message leaves the outbox.
- Send later: the message stays in the outbox until its time. The app must be running at that time; this is stated in the UI.

### 4.5 Search

- Local search uses FTS5 over all indexed headers and all downloaded bodies. Typical response under 100 ms.
- Query language: free text plus `from:`, `to:`, `subject:`, `has:attachment`, `before:`, `after:`, `in:`.
- Filter chips: account, folder, sender, has attachment, and date presets (any time, past year, older than 1 year, older than 2 years, custom range).
- Results grouped by year, matches highlighted.
- "Search the server for more": runs IMAP `SEARCH` (or `X-GM-RAW` on Gmail) for messages whose bodies are not downloaded, and merges the results.
- POP3 accounts: local results only.

### 4.6 Conversations, Focused / Other, rules

- Threading from `References` / `In-Reply-To`, with subject fallback; Gmail thread ids where available.
- Focused / Other is rule-based: mail with `List-Unsubscribe` or bulk headers, and senders you have never written to, go to Other. "Always move to Focused / Other" on a sender is remembered.
- Rules run locally on new mail: conditions (from, to, subject contains, has attachment) → actions (move, categorise, flag, mark read, delete).

### 4.7 Security

- Mail HTML is sanitised in Rust (`ammonia`) and again in the UI, then shown in a sandboxed iframe with scripts disabled.
- Remote images are blocked by default, with "Show images" per message and "Always for this sender".
- Links open in the system browser, with the real address shown on hover.
- TLS required by default for IMAP, POP3 and SMTP; plain connections need an explicit opt-in.
- Tauri's command allow-list restricts what the web side can call.

## 5. Features

### Accounts
- Add account wizard: enter address → choose Google, IMAP or POP3 → auto-detected server settings (editable) → test connection → first sync
- Several accounts, each with its own folder tree; Favorites section across accounts
- Edit, re-authenticate and remove accounts

### Reading
- Three panes: folders, message list, reading pane (right, bottom or hidden)
- Conversation view with expandable messages
- Focused / Other tabs; groups for Pinned, Today, Yesterday, This week, older
- Unread styling, attachment chips, inline images, open and save attachments
- Light and dark themes, including a dark rendering for mail bodies
- Density: roomy, cozy, compact

### Triage
- Delete, archive, move, copy, mark read / unread, flag, pin, snooze, categories
- Junk, block sender, sweep (delete or move everything from a sender)
- Multi-select, drag to folder, right-click menu, hover quick actions
- Quick steps: user-defined one-click combinations
- Undo for the last action

### Compose
- New, reply, reply all, forward; inline in the reading pane or in a separate window
- Rich text (fonts, size, bold, italic, underline, colour, lists, links, inline images)
- Attachments by button, drag and drop, or paste
- To / Cc / Bcc with autocomplete from addresses seen in mail
- Choose the sending account; auto-saved drafts synced to the Drafts folder
- Signatures (below), send later, undo send

### Signatures
- Any number of named signatures, edited as rich text with links and images, with an HTML source view
- Per account: default for new messages, and a separate default (or none) for replies and forwards
- Inserted automatically when composing; switch or remove from the composer toolbar; changing the "From" account swaps the signature

### Folders and search
- Create, rename, move, delete and favourite folders; empty Deleted and Junk
- Search as described in 4.5
- Sort and filter the message list (unread, flagged, has attachment, to me)

### System
- Offline mode with outbox and queued actions
- Desktop notifications, tray icon with unread count, start minimised
- Keyboard shortcuts that follow Outlook's, so habits carry over
- Import and export `.eml` and `.mbox`
- Settings pages: Accounts, Signatures, Sync and storage, Layout, Appearance, Rules, Notifications, Shortcuts

### Out of scope for v1
Calendar, contacts and to-do modules; Exchange / Microsoft 365 native protocols; PGP and S/MIME; Windows and macOS builds; mobile; AI drafting.

## 6. Design

The static mockup in [design/mockup.html](design/mockup.html) is the reference for layout, spacing and colour. The style is OpenWren's own: calm, rounded and light, closer to current web mail apps than to Outlook's ribbon. It shows seven screens: main window, search, compose, signature settings, add account, server settings, and sync and storage.

### 6.1 Window structure

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Header (soft tint): app name · pill search box · settings               │ 52 px
├────────────┬─────────────────────┬───────────────────────────────────────┤
│ New mail   │ Message list        │ Action row: archive · delete · move · │
│ (button)   │ Focused | Other     │ read · flag · pin · snooze · tag      │
│            │                     │ ───────────────────────────────────── │
│ Folder     │                     │ Reading pane / composer               │
│ pane       │                     │                                       │
│ 220 px     │ 340 px              │ fills the rest                        │
│ resizable  │ resizable           │                                       │
└────────────┴─────────────────────┴───────────────────────────────────────┘
```

- There is no ribbon and no Home / View / Help tabs. "New mail" sits at the top of the folder pane; actions on a message sit in a row at the top of the reading pane, and also appear on hover and in the right-click menu in the list. View options live in Settings → Layout.
- When several messages are selected, the reading pane shows the count and the same action row.
- Minimum window size 900 × 600. Below 1100 px wide the folder pane collapses to a toggle.
- The list and the reading pane are white rounded cards on a light grey canvas.

### 6.2 Design tokens

| Token | Light | Dark |
|---|---|---|
| Soft blue fill (header, primary button, active chip) | `#CFE2F9` | `#0C447C` (header `#0F2C4D`) |
| Text on soft blue | `#0C447C` | `#CFE2F9` |
| Accent text and links | `#1A64B0` | `#85B7EB` |
| Accent outline (focused search, active chip) | `#85B7EB` | `#378ADD` |
| Accent dot (unread, progress, tab underline) | `#378ADD` | `#85B7EB` |
| Canvas | `#F6F7F9` | `#111318` |
| Card | `#FFFFFF` | `#1B1E24` |
| Selected row | `#D9E8FA` | `#12355C` |
| Hover row / chip fill | `#EEF0F3` | `#262A31` |
| Text | `#1F2328` | `#ECEEF1` |
| Secondary text | `#5F6772` | `#A0A7B1` |
| Border | `#E3E6EA` | `#2C3038` |
| Search highlight | `#FFE9A8` | `#5C4A00` |
| Danger | `#C62828` | `#FF8A80` |

- The blue is always soft and light. There are no solid deep-blue surfaces: the primary button is a light blue pill with dark blue text.
- The accent colour is one setting, so alternative accents can be offered later under Appearance.
- Font: Inter, bundled; fallback `system-ui`. Sizes: 14 px body, 12 px metadata, 20 px message subject.
- Shape: pill buttons, chips, search box and folder rows (fully rounded); 10 px inputs and list rows; 14 px cards and window. Spacing on a 4 px grid.
- Borders are 1 px hairlines; shadows only on floating things (menus, dialogs).
- The folder pane and the settings navigation use regular weight only: account names, folder names, unread counts and the selected item are never bold. Selection is shown by the soft blue fill; account names are set apart by a muted colour.
- Icons: Tabler outline icons, 20 px.
- Avatars: 32 px circles with initials on a soft colour derived from the address.

### 6.3 Screen notes

- **Message row (three lines):** sender; subject with time on the right; one-line preview. Rows are rounded and inset; the selected row is filled with the selection tint. Unread rows have a bold sender and subject, an accent dot and an accent-coloured time. Hover shows quick actions (archive, delete, flag, pin).
- **Reading pane:** action row, subject, then one block per message in the conversation with sender, recipients, time, and reply / reply all / forward; attachments as rounded chips; Reply and Forward buttons at the bottom.
- **Composer:** replaces the reading pane, or pops out. Send and "Send later" at the top left, fields below, formatting toolbar with the signature picker, body, signature, attachments.
- **Search:** typing in the header search box switches the list to results and shows a row of filter chips under the header. Results are grouped by year with matches highlighted.
- **Settings:** a dialog with a left navigation list and one page per topic.
- **Empty states:** a short line and one action, for example "Nothing in Focused. Check Other".

### 6.4 Keyboard shortcuts

| Action | Keys |
|---|---|
| New mail | Ctrl+N |
| Reply / Reply all / Forward | Ctrl+R / Ctrl+Shift+R / Ctrl+F |
| Send | Ctrl+Enter |
| Search | Ctrl+E |
| Delete / Archive | Delete / Backspace |
| Mark read / unread | Ctrl+Q / Ctrl+U |
| Flag | Insert |
| Move to folder | Ctrl+Shift+V |
| Next / previous message | Down / Up |
| Undo | Ctrl+Z |

## 7. Milestones

Each milestone ends with something you can run and check.

| # | Milestone | Contents | Done when |
|---|---|---|---|
| 0 | Scaffold | Tauri + React + Tailwind project, typed command bindings, SQLite with migrations, theme tokens, CI (lint, tests, build), GPL licence | The app opens an empty themed window on Linux; CI is green |
| 1 | Static shell | Header, three resizable panes, action row, base components (button, chip, input, menu, dialog), light and dark themes, all built from sample data | The app matches the main-window mockup with fake mail |
| 2 | IMAP read | Add-account wizard (IMAP), keyring, folder list, two-pass sync, message list (virtualised), reading pane with sanitised HTML, attachments, IDLE | A real IMAP mailbox with 50,000+ messages can be browsed, including its oldest mail, and new mail appears within seconds |
| 3 | Send and signatures | SMTP, composer, reply / forward, drafts, attachments, autocomplete, signature editor and per-account defaults, outbox, undo send | A message with a signature and an attachment can be written, sent and found in Sent |
| 4 | Gmail | Google sign-in, token refresh, XOAUTH2, label handling, Gmail threading | A Gmail account can be added through the browser, read and sent from |
| 5 | Triage | Move, delete, archive, flag, pin, categories, read / unread, multi-select, drag and drop, right-click menu, undo, conversations, pending-ops queue | Every action works offline and replays to the server on reconnect |
| 6 | Search | FTS5 index, query language, filter chips and date presets, year grouping, highlighting, server fallback | A message from two or more years ago is found by sender, subject or body text in under a second |
| 7 | POP3 | POP3 download, leave-on-server options, local folders | A POP3 account downloads mail and sends through its SMTP server |
| 8 | Outlook polish | Focused / Other, snooze, send later, rules, quick steps, sweep, notifications, tray, shortcuts, remaining settings pages, density options, import / export | The feature list in section 5 is complete |
| 9 | Release | AppImage and .deb builds, auto-update, user documentation, contributor guide, first public release | A fresh Linux machine can install and use v1.0 |

Order matters: milestones 0–3 give a usable IMAP client; 4 and 6 deliver your two stated priorities (Gmail and old-mail search); the rest is breadth.

## 8. Testing

- **Rust unit tests** for parsing, threading, the sync state machine, search query parsing and rules.
- **Integration tests** against a real mail server in Docker (Dovecot or GreenMail), seeded with test mailboxes including a large, old one.
- **UI tests** with Vitest for components and Playwright for flows (add account, read, reply, search) against the Docker server.
- **Fixtures:** a set of awkward real-world messages (odd encodings, nested attachments, malformed HTML).
- Gmail is tested manually with a test account; Google sign-in cannot be automated reliably in CI.

## 9. Risks and open points

1. **Google OAuth client.** Gmail sign-in needs a Google Cloud project with a "Desktop app" OAuth client. Full mail access is a restricted scope:
   - While the project is in Google's "Testing" status, only listed test users can sign in and sign-ins are expected to expire after about 7 days.
   - Setting it to "In production" without verification removes that expiry but shows users an "unverified app" warning and caps the number of users.
   - Shipping one shared client ID to the public requires Google's verification and a security assessment.
   - Plan for v1: a "Google client ID" field in settings, with a setup guide. To be re-checked against Google's current policy in milestone 4.
2. **Because Gmail login is OAuth only**, a user who cannot create a Google Cloud project has no way to add Gmail until a verified shared client exists.
3. **Large mailboxes.** Syncing every header of a 200,000-message mailbox takes time and disk space (estimated a few hundred MB for headers and index; bodies depend on the mailbox). Sync is resumable, shows progress, and the body limit is configurable.
4. **Linux webview.** Tauri uses WebKitGTK on Linux, which lags behind Chrome in some features and performance. The message list is virtualised and tested on WebKitGTK from milestone 1.
5. **Keyring availability.** Minimal desktops may not run a Secret Service. The app detects this and explains how to enable one; it does not fall back to plain-text storage.
6. **IMAP server differences.** Folder naming, missing extensions and quirks vary by provider. Tested against Dovecot, Gmail, and at least two other common providers before release.
7. **Send later and snooze** only fire while the app is running.

## 10. Status

Last updated 12 November 2026. "Tested" means covered by automated tests against local Dovecot (IMAP) and SMTP test servers, or checked in the running app.

| # | Milestone | State |
|---|---|---|
| 0–1 | Scaffold and shell | Done |
| 2 | IMAP read | Done and tested: two-pass sync, push (IDLE), on-demand bodies, sanitised HTML |
| 3 | Send and signatures | Done and tested: SMTP, rich-text composer, attachments, reply / reply all / forward, autocomplete, signatures with defaults, outbox with retry, undo send, send later |
| 4 | Gmail | Built; the OAuth flow is tested against stand-in endpoints only. Not yet tried against Google. |
| 5 | Triage | Done and tested: move, archive, delete, undo, offline queue, multi-select, drag and drop, right-click menu, categories, conversations |
| 6 | Search | Done and tested: full-text index, operators, date chips and custom range, server search |
| 7 | POP3 | Removed on request: POP3 is no longer supported. Accounts are IMAP or Gmail. |
| 8 | Polish | Mostly done: Focused / Other with per-sender override, snooze, rules, sweep, notifications, shortcuts, settings pages, density, save as .eml |
| 9 | Release | .deb build and documentation. No AppImage, auto-update or public release yet. |

### Differences from the plan

- **Message list:** pages of 100 loaded on scroll, not a virtualised list. Not yet measured on a 50,000-message mailbox.
- **Conversations:** the reading pane lists the other messages of a conversation; the message list itself is not collapsed by conversation.
- **Drafts:** saved automatically on this computer and, five seconds after the last change, in the server's Drafts folder (replacing the previous copy). A draft from another device can be continued with "Edit draft"; its attachments are not carried over. Bcc recipients are not stored in the server copy.
- **Categories and pins:** stored locally, not synced to the server.
- **Gmail labels:** shown as folders; "All Mail", "Starred" and "Important" are skipped to avoid duplicates. A message with several labels appears once per label.
- **Server search:** plain ASCII words only.
- **HTML mail:** always shown on a white background, also in the dark theme.
- **Inline images in composed mail:** not supported; attach the file instead.
- **Typed bindings:** written by hand in `src/backend/index.ts` instead of generated with `tauri-specta`.
- **Menus and dialogs:** small own components instead of Radix UI.

### Added after the milestones

- **Encrypted database:** SQLCipher, with a random key kept in the system keyring. A database from before is encrypted in place on first start.
- **All inboxes:** one list of every account's inbox, at the top of Favorites.
- **Favourites:** add or remove a folder with the star that appears on hover, or by right-click.
- **Sync button** in the header, **tray icon** with Open, Sync now and Quit, and an **About** page in Settings.

- **Tray:** closing the window keeps OpenWren running in the tray (can be turned off in Settings, Notifications). Starting it again shows the running window.
- **Privacy:** tracking pixels and tracking link parameters are removed; warnings for failed sender checks (SPF, DKIM, DMARC), company names on foreign addresses and links that show one site but lead to another; unsubscribe from mailings (RFC 8058 one-click, mail or web page).
- **Company logos:** 199 logos from Simple Icons, bundled and matched by the sender's domain. Amazon, Microsoft, LinkedIn, Slack and Adobe are not in that set. Fetching site icons online was decided against.
- **Signatures:** optional picture, left of or above the text, sent inside the message.
- **Launcher:** `scripts/install-launcher.sh` adds the app and its icon to the applications menu.

### Not built

Quick steps, unread count on the tray icon, import of .eml / .mbox, mbox export, account editing after creation (remove and add again), folder create / rename / delete, AppImage, auto-update, STARTTLS and TLS tested against a real provider.

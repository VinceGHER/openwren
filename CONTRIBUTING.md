# Contributing to OpenWren

Thanks for helping. Bug reports, fixes, translations and ideas are all welcome.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened. Settings → About shows the version.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first so we can agree on the approach before you spend time on it.

## Build and run

You need Node.js 22 or later with pnpm, Rust 1.77 or later, and Tauri's Linux libraries:

```bash
sudo apt install -y rustc cargo libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev pkg-config
```

```bash
pnpm install
```

```bash
pnpm tauri dev
```

`pnpm dev` runs the interface alone in a browser on sample mail, which is the quickest way to work on screens.

## Tests

```bash
pnpm typecheck && pnpm test
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

The end-to-end tests talk to a local mail server. Start it with `sh tests/mail-server.sh` (needs Docker), then:

```bash
OPENWREN_TEST_IMAP=127.0.0.1:3143 OPENWREN_TEST_SMTP=127.0.0.1:3025 cargo test --manifest-path src-tauri/Cargo.toml
```

A change to the engine needs a test. A change to a screen needs a before and after screenshot in the pull request.

## How the code is organised

- `src-tauri/src/`: the engine in Rust. `lib.rs` holds the commands the interface calls; `sync.rs`, `imap.rs`, `smtp.rs` talk to mail servers; `db.rs` is all the SQL; `parse.rs` reads and cleans mail.
- `src/`: the interface in React and TypeScript. `store.ts` is the state; `features/` are the screens; `backend/` is the only place that calls the engine.
- The interface never touches the network or the database. It calls engine commands and listens for events.

## Style

- Small, direct code over clever code. Comments say why, not what.
- Wording in the app: sentence case, plain words, no exclamation marks.
- Run `cargo fmt` and keep `pnpm typecheck` clean.

## Sign your work

OpenWren is licensed under Apache-2.0, and contributions are accepted under the same licence. Add a sign-off line to each commit to confirm you wrote the change or have the right to submit it (the [Developer Certificate of Origin](https://developercertificate.org)):

```bash
git commit -s -m "Fix the unread count in All inboxes"
```

## Name and logo

The code is free to use and change. The name "OpenWren" and its logo are not; see [TRADEMARKS.md](TRADEMARKS.md).

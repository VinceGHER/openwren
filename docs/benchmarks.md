# Benchmarks

How fast OpenWren is, measured, with the method and the commands to repeat it. Nothing here is estimated.

**Machine:** Intel Core Ultra 7 155H (22 threads), 32 GB memory, NVMe disk, Ubuntu 26.04, Linux 7.0. **Date:** 13 November 2026. **Version:** 0.1.0, release build.

The mailbox is synthetic and generated from a fixed seed (`src-tauri/src/sample_data.rs`), so every run and every machine measures the same mail: each message has a sender, a subject and about 120 words of text, spread over six years. The database is encrypted with SQLCipher, as in real use.

## The app as a whole

Measured by `scripts/bench.sh` on a mailbox of 50,000 messages.

| What | Result | How it is measured |
|---|---|---|
| Start-up, first start | 0.64 s | From process start until the inbox list is drawn; the app reports it itself when `OPENWREN_TIMING` is set |
| Start-up, later starts | 0.57 s (median of 4) | Same |
| Memory, idle with the inbox open | 288 MB | Proportional memory (PSS) of the app and the two WebKit processes after 60 s |
| Processor time while idle | 0.54 s over 5 minutes (0.2% of one core) | CPU time of the same processes between minute 1 and minute 6 |
| Download size | 14 MB (`.deb` and `.rpm`) | File size |
| Installed size | 37 MB | From the package's own metadata |

Most of the memory is the system web view (WebKitGTK) that draws the window; the Rust engine itself uses a small part of it.

## The engine

Measured by `cargo bench --bench engine`. Each operation is the database work behind something you wait for; the time to draw the result on screen comes on top. Median of 50 to 1,000 runs, with the 95th percentile.

### 50,000 messages (158 MB encrypted database)

| Operation | Median | 95th percentile |
|---|---|---|
| Open the encrypted database | 0.35 ms | 0.51 ms |
| Show a folder (first 100 messages) | 0.12 ms | 0.14 ms |
| Scroll to the 50th page of a folder | 0.70 ms | 0.80 ms |
| Folder list with unread counts | 1.56 ms | 1.67 ms |
| Pinned messages of a folder | 0.01 ms | 0.01 ms |
| Show only unread mail | 0.16 ms | 0.19 ms |
| Open a message | 0.05 ms | 0.07 ms |
| Search: one common word | 45 ms | 51 ms |
| Search: one rare word | 7.30 ms | 7.84 ms |
| Search: two words | 48 ms | 49 ms |
| Search: `from:kane invoice` | 7.60 ms | 7.99 ms |
| Search: a word in mail older than 2 years | 43 ms | 44 ms |

### 200,000 messages (628 MB encrypted database)

| Operation | Median | 95th percentile |
|---|---|---|
| Open the encrypted database | 0.32 ms | 0.49 ms |
| Show a folder (first 100 messages) | 0.12 ms | 0.13 ms |
| Scroll to the 50th page of a folder | 0.70 ms | 0.79 ms |
| Folder list with unread counts | 14 ms | 15 ms |
| Pinned messages of a folder | 0.01 ms | 0.01 ms |
| Show only unread mail | 0.16 ms | 0.17 ms |
| Open a message | 0.05 ms | 0.07 ms |
| Search: one common word | 185 ms | 191 ms |
| Search: one rare word | 29 ms | 30 ms |
| Search: two words | 193 ms | 224 ms |
| Search: `from:kane invoice` | 30 ms | 30 ms |
| Search: a word in mail older than 2 years | 195 ms | 375 ms |

### Reading the numbers

- **Opening a folder and opening a message do not slow down as the mailbox grows.** Both come straight from an index.
- **Search grows with the number of matches.** The "common word" here appears in most of the mailbox, the worst case: every match is found and then sorted by date. A word that appears in a few hundred messages takes 30 ms even among 200,000. Making the worst case faster is known future work.
- **The unread counts** are recomputed for every folder each time, and the synthetic mailbox is 20% unread (40,000 unread messages at the larger size), far more than most real ones.

## Sync

Measured by the same benchmark against a Dovecot mail server on the same computer holding 10,009 messages, so the network costs nothing. A real server over the internet is slower; this shows what the app itself can keep up with.

| Step | Time | Rate |
|---|---|---|
| Headers of every message | 3.6 s | 2,758 messages per second |
| Text of every message | 18.4 s | 541 messages per second |

Headers come first for the whole mailbox, so every message is listed and searchable by sender and subject within seconds; the text follows in the background, newest first.

## What the benchmarks changed

Running these found three slow spots, all fixed before these numbers were taken:

| Problem | Before | After |
|---|---|---|
| Showing a folder sorted the whole folder each time | 47 ms at 50,000 messages, 187 ms at 200,000 | 0.12 ms at both |
| Pinned messages were found by walking the folder | 41 ms at 50,000, 157 ms at 200,000 | 0.01 ms |
| A once-a-second check for snoozed mail read the whole mailbox | 20.6 s of processor time per 5 idle minutes | 0.54 s |

## Running them yourself

The engine benchmark needs only Rust:

```bash
cargo bench --manifest-path src-tauri/Cargo.toml --bench engine
```

For the sync numbers, start the test mail server, fill a mailbox, and pass its address:

```bash
sh tests/mail-server.sh
```

```bash
python3 tests/seed_mail.py 127.0.0.1 3143 bench@work.test pass 10000
```

```bash
OPENWREN_TEST_IMAP=127.0.0.1:3143 cargo bench --manifest-path src-tauri/Cargo.toml --bench engine
```

The whole-app numbers need a release build and a desktop session; the window opens and closes several times. It uses a temporary mailbox and does not touch your own mail:

```bash
pnpm tauri build --bundles deb
```

```bash
scripts/bench.sh 50000
```

No other mail app was measured, so there is no comparison table. A fair one needs the same mailbox loaded into each app on the same machine.

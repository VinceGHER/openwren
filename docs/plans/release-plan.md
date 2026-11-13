# OpenWren: plan for the repository, website, distribution, testing and usage statistics

Written 13 November 2026. Nothing in this plan is done yet unless marked "exists". The product plan and its status are in [PLAN.md](PLAN.md).

## 1. Principles

- **Private until ready.** The repository and site stay private until the "going public" checklist in section 2.4 is complete.
- **Trust is the product.** A mail program sees everything. Every choice below favours what a sceptical user can verify: open code, signed packages, reproducible builds, no hidden network requests.
- **Small surface.** Few channels done well beat many done badly. Start with three ways to install, add more when someone will maintain them.

## 2. GitHub repository

### 2.1 Setup (private)

| Item | Choice |
|---|---|
| Owner | A GitHub organisation named `openwren` (check that the name is free), not a personal account, so maintainers can be added later |
| Repositories | `openwren/openwren` (the app), `openwren/website`, `openwren/stats` (the statistics server, section 6), later `openwren/flathub` |
| Visibility | Private. Organisation members only |
| Default branch | `main`, protected: pull request required, CI must pass, no force push |
| Licence | Apache-2.0 (changed from GPL-3.0-or-later before the first commit) |

First push, from this folder (the folder is still called `openlook`; rename it when convenient):

```bash
gh repo create openwren/openwren --private --source . --remote origin --push
```

### 2.2 Files to add before the first push

| File | Purpose |
|---|---|
| `CONTRIBUTING.md` | How to build, test, and send a change; commit sign-off (DCO) |
| `CODE_OF_CONDUCT.md` | Contributor Covenant |
| `SECURITY.md` | How to report a vulnerability privately; supported versions; response times |
| `PRIVACY.md` | Every network request the app makes, and why (section 6.5) |
| `.github/ISSUE_TEMPLATE/` | Bug report (with the "Copy diagnostics" text, section 5.3), feature request |
| `.github/pull_request_template.md` | Checklist: tests, screenshots for interface changes |
| `CHANGELOG.md` | One entry per release, written for users |
| `.github/CODEOWNERS` | Who reviews what |

### 2.3 Automation (GitHub Actions)

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` (a draft exists, never run) | Every pull request | Typecheck, interface tests, Rust tests against a Dovecot container, `cargo clippy`, `cargo fmt --check` |
| `audit.yml` | Daily and on dependency changes | `cargo audit`, `cargo deny` (licences and advisories), `pnpm audit`, CodeQL |
| `packages.yml` | Every pull request | Build `.deb`, `.rpm`, AppImage; install each in a clean container and start the app under a virtual display (section 5.2) |
| `release.yml` | A version tag (`v0.2.0`) | Build, sign, attach to a GitHub Release, update the APT and RPM repositories, open the Flathub pull request |
| `nightly-providers.yml` | Nightly | The provider tests in section 5.1 |

Also: Dependabot (or Renovate) for dependency updates, secret scanning and push protection switched on.

### 2.4 Checklist before going public

- [ ] No secrets or personal data in the history: Google client secret, real addresses, real mail in test data. The repository has no commits yet, so start from a clean first commit.
- [ ] Remove or generalise developer helpers that open a real user's database (`src-tauri/examples/dev_*.rs`).
- [ ] Name check: search trademark registers and package indexes (Debian, Fedora, Flathub, AUR, crates.io, npm) for "OpenWren" and "Wren". Note that Simple Icons logos are trademarks of their owners; keep the notice in About.
- [ ] Security findings 9 to 12 from the review either fixed or listed as known limits.
- [ ] An independent security review of mail rendering and the unsubscribe request.
- [ ] `SECURITY.md` contact works; a private advisory can be opened.
- [ ] Gmail: Google's verification for the restricted mail scope, or clear instructions that users bring their own client ID (today's behaviour).

## 3. Website

| Item | Choice |
|---|---|
| Address | `openwren.app` (check availability; register `.org` and `.app`) |
| Built with | A static site generator (Astro) in `openwren/website`; plain HTML output, no JavaScript needed to read it |
| Hosted on | Cloudflare Pages or GitHub Pages. While private: Cloudflare Pages with access limited to invited addresses |
| Tracking | None. No cookies, no third-party scripts, fonts served from the site itself |

Pages:

1. **Home:** what it is in one sentence, a screenshot, three reasons (private, open, fast), download button.
2. **Download:** one tab per channel in section 4, with the exact commands and the signing key fingerprint.
3. **Privacy:** the list of network requests, what the statistics ping contains, how to switch it off.
4. **Security:** how to report, past advisories, how packages are signed and how to verify.
5. **Docs:** adding accounts (Gmail client ID guide), shortcuts, search operators, troubleshooting.
6. **Changelog / blog:** release notes; an RSS feed.
7. **Contribute:** links to the repository, good first issues, translation.

Public statistics dashboard (section 6.4) lives at `stats.openwren.app`.

## 4. Getting it to users

### 4.1 Channels

| Channel | Reaches | How updates arrive | Effort | When |
|---|---|---|---|---|
| **Flatpak on Flathub** | Every distribution with Flatpak (Fedora, Mint, Pop!_OS, Steam Deck; Ubuntu after one command) | Automatically, through the software centre | Medium: manifest, sandbox permissions for keyring, tray and notifications | First public release |
| **APT repository** (`.deb`) | Debian, Ubuntu and derivatives | `apt upgrade` | Medium: signed repository built in CI | First public release |
| **RPM repository** (`.rpm`) | Fedora, RHEL, openSUSE | `dnf upgrade` | Medium: same pipeline as APT | First public release |
| **AppImage** on GitHub Releases | Anything | In-app updater | Low | First public release |
| **AUR** (`openwren-bin`) | Arch, Manjaro | AUR helper | Low | Soon after; community can maintain |
| **Nix** (nixpkgs) | NixOS | Channel update | Low to medium | When someone asks |
| **Snap** | Ubuntu | Automatic | Medium; strict confinement is awkward for keyring and tray | Only on demand |
| **Official Debian / Fedora archives** | Their users, without adding a repository | Distribution updates | High: every Rust dependency must be packaged; slow review | Long term |

Recommendation: Flatpak, APT, RPM and AppImage for the first public release. Flatpak gives the widest reach for one piece of work; APT and RPM are what people who distrust Flatpak expect.

### 4.2 How the APT and RPM repositories work

Both are static files, so they need no server of their own. CI builds the packages, signs them, regenerates the index files, and uploads everything to `packages.openwren.app` (object storage behind a CDN).

What a user runs, Debian or Ubuntu:

```bash
curl -fsSL https://packages.openwren.app/key.gpg | sudo tee /usr/share/keyrings/openwren.gpg > /dev/null
```

```bash
echo "deb [signed-by=/usr/share/keyrings/openwren.gpg] https://packages.openwren.app/apt stable main" | sudo tee /etc/apt/sources.list.d/openwren.list
```

```bash
sudo apt update && sudo apt install openwren
```

Fedora:

```bash
sudo dnf config-manager addrepo --from-repofile=https://packages.openwren.app/rpm/openwren.repo
```

```bash
sudo dnf install openwren
```

Tools: `reprepro` or `aptly` for APT, `createrepo_c` for RPM. Tauri already builds `.deb`, `.rpm` and AppImage; only `.deb` is built today.

An alternative that needs less of our own infrastructure: the openSUSE Build Service builds and hosts `.deb` and `.rpm` for many distributions from one description, free for open-source projects. It is worth a trial before building the pipeline above.

### 4.3 Signing and verification

| What | Key | Where the private key lives |
|---|---|---|
| APT and RPM repositories | One GPG key; fingerprint printed on the website | Master key offline; a signing subkey in CI secrets, rotated yearly |
| AppImage updates | The Tauri updater's own key | CI secret |
| Every release file | SHA-256 checksums plus GitHub build attestations (shows which commit and workflow built it) | Generated by CI |

Goal after the first release: reproducible builds, so anyone can rebuild a release and get the same bytes.

### 4.4 Versions and channels

- **Version numbers:** `0.x` until the public release; then semantic versions.
- **Channels:** `stable` and `beta`. Beta is a separate APT/RPM component, a Flathub beta branch and pre-release AppImages.
- **Rhythm:** a beta when there is something to test; stable about monthly; security fixes at once on both.

## 5. Testing

### 5.1 Automated

| Layer | What | Status |
|---|---|---|
| Unit tests | Parsing, search operators, sender checks, tracker removal, blocked senders, encryption | Exists: 31 Rust, 37 interface |
| Mail server tests | Sync, moves, drafts, sending, blocking against a local Dovecot | Exists: 6 end-to-end tests |
| Interface tests | Drive the real interface on sample mail with Playwright: open, reply, search, settings | To add |
| Whole-app smoke test | Start the packaged app with `tauri-driver`, add the test account, open a message | To add |
| Database upgrades | Open a saved database from each released version with the new build | To add (one test exists for the unencrypted-to-encrypted step) |
| Fuzzing | Feed random bytes to the mail parser, header reader and folder-name decoder (`cargo fuzz`) | To add |
| Large mailbox | 50,000 messages: time to first list, memory, scroll | To add |
| Real providers, nightly | Sign in, sync, send, move on dedicated test accounts: Gmail, Outlook.com, Fastmail, Yahoo, iCloud, a Dovecot and a Stalwart server | To add; needs accounts and their secrets in CI |

### 5.2 Packaging tests

For each package, in a clean container: install, check the dependencies resolve, start under a virtual display, confirm the window appears and the process stays up, uninstall cleanly.

| Package | Tested on |
|---|---|
| `.deb` | Ubuntu 22.04, 24.04, 26.04; Debian 12, 13; Linux Mint |
| `.rpm` | Fedora (two latest), openSUSE Tumbleweed |
| Flatpak | Fedora and Ubuntu runners |
| AppImage | Ubuntu 22.04 (oldest supported) |

Also by hand before each stable release: GNOME on Wayland and X11, KDE Plasma, a tiling window manager (tray and notifications differ on each).

### 5.3 People

| Stage | Who | Size | Exit when |
|---|---|---|---|
| Private alpha | Invited, given repository access | 5 to 10 | A week of daily use without data loss or a blocking bug |
| Closed beta | Sign-up form on the site | 50 to 200 | Crash-free rate and sync errors acceptable (section 6.3) |
| Public beta | Anyone; repository public | Open | Two releases with no severe bug |
| Stable | Everyone | | |

To make reports useful:

- **"Copy diagnostics"** in Settings → About: version, distribution, desktop, package type, account types and counts, last sync error. Never addresses, subjects or mail text.
- **A test script** for volunteers: twenty steps covering accounts, sending, search, drafts, attachments, tray.
- **Crash reports:** opt-in only, shown to the user before sending.

### 5.4 Release gate

A stable release needs: all automated tests green, packaging tests green on every listed system, nightly provider tests green for three nights, no open severe bug, changelog written, and the database upgrade test passing from the previous two versions.

## 6. Usage statistics that stay private

### 6.1 How Brave does it, and what to copy

Brave counts users without identifying them. The browser sends one small request a day that carries no identifier. Instead it answers three yes/no questions from state it keeps locally: is this my first ping today, my first this week, my first this month? The server only adds up the answers, which gives daily, weekly and monthly users. Other measurements are sent as coarse buckets ("11 to 50 tabs", not "37"), each in a separate request so they cannot be joined into a profile.

The same design fits OpenWren.

### 6.2 The daily ping

One HTTPS request a day, at a random time, to `stats.openwren.app`.

| Field | Example | Why |
|---|---|---|
| App version and channel | `0.3.1`, `stable` | How fast updates are adopted |
| Package type | `deb`, `rpm`, `flatpak`, `appimage` | Which channels matter |
| System family and major version | `ubuntu-24.04` | What to test on |
| Processor type | `x86_64`, `aarch64` | What to build |
| First ping today / this week / this month | `yes`, `yes`, `no` | Daily, weekly, monthly users |
| First ping ever | `no` | New installs |
| Week of install | `2026-W46` | How many people keep using it |

Rules:

- **No identifier of any kind.** No install ID, no cookie, no account hash.
- **The server keeps counters, not requests.** It adds one to "2026-11-13, 0.3.1, deb, ubuntu-24.04" and forgets the request. No access logs; the IP address is never written anywhere.
- **Missed days are not sent later,** so a ping never reveals when the computer was off.
- **Small groups are hidden.** The dashboard does not show a combination with fewer than 50 users.
- **Later, for stronger guarantees:** send through an Oblivious HTTP relay, so not even the server sees the IP address.

### 6.3 Other measurements worth having

Sent weekly, as buckets, each as its own unlinkable request. I would make these a second, separate choice from the daily ping.

| Question | Buckets | Decision it informs |
|---|---|---|
| How many accounts | 1, 2, 3 or more | Multi-account design |
| Account types | Gmail yes/no, other IMAP yes/no | Where to spend provider testing |
| Largest mailbox | Under 1,000; to 10,000; to 50,000; more | Performance work |
| Features used this week | Yes/no each: search, snooze, rules, block sender, unsubscribe, send later, signature picture | What to polish or remove |
| Settings | Focused inbox on/off, theme, tray on/off, tracker blocking on/off | Defaults |
| Sync trouble this week | None; sign-in; connection; other | Reliability |
| Start-up time | Under 1 s; 1 to 3 s; over 3 s | Performance |
| Did the last session end in a crash | Yes/no | Crash-free rate, the main quality number |
| Suspicious mail warnings shown | 0; 1 to 5; more | Whether the warnings are noisy |

For yes/no feature questions, randomised response adds deniability: the app answers truthfully most of the time and randomly otherwise; totals stay accurate, single answers prove nothing.

Never collected, under any setting: addresses, names, subjects, mail text, contacts, folder names, server names, IP addresses.

### 6.4 The server and dashboard

- **Server:** a very small open-source service (`openwren/stats`), for example a Cloudflare Worker or a single Rust binary, that validates the fields against fixed lists and increments counters in a database.
- **Dashboard:** public at `stats.openwren.app`, so users see exactly what the project sees.

### 6.5 In the app

- **First start:** one screen, two clear buttons, neither pre-selected: "Send anonymous usage statistics" / "Don't send". It shows the exact data of the next ping.
- **Settings → Privacy → Usage statistics:** on/off for the daily ping, separate on/off for the weekly measurements, and "Show what is sent".
- **`PRIVACY.md` and the website** list every request the app can make: mail servers, Google sign-in, unsubscribe requests, remote images on request, update check, statistics.

Recommendation on the default: ask at first start rather than switching it on silently. Fewer people will send data than with Brave's on-by-default approach, but for a mail program the trust is worth more than the larger sample. The yes-rate itself tells you how the request is received.

### 6.6 Numbers that need no telemetry

- Downloads of release files on GitHub.
- Flathub's public install and update counts.
- Fetch counts of the APT and RPM index files (from CDN totals, no per-user logs).
- Website visits with a cookie-less, self-hosted counter (GoatCounter or Plausible).
- Stars, issues, pull requests, translation activity.

## 7. Order of work

| Phase | Contents |
|---|---|
| 1. Private repository | Organisation, first commit, files from 2.2, `ci.yml` and `audit.yml` running |
| 2. Packaging | `.rpm` and AppImage builds, packaging tests, signing keys, APT and RPM repositories on a private address |
| 3. Private alpha | Five to ten testers, "Copy diagnostics", test script |
| 4. Statistics | Server, first-start choice, daily ping; weekly measurements after |
| 5. Website | Private preview, then content complete |
| 6. Going public | Checklist 2.4, Flathub submission, repository and site public, closed then public beta |
| 7. Stable | Release gate 5.4 met |

## 8. Decisions needed from you

1. **Organisation and domain names:** `openwren` on GitHub and `openwren.app`, if free.
2. **Statistics default:** ask at first start (recommended), or on by default with a notice as Brave does.
3. **Gmail for everyone:** apply for Google's verification (months, and a paid security assessment for the mail scope), or keep "bring your own client ID".
4. **Build infrastructure:** our own APT/RPM pipeline, or try the openSUSE Build Service first.
5. **Who else maintains:** a second person with release rights before going public.

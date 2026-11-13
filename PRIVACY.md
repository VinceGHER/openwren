# Privacy

OpenWren keeps your mail on your computer. There is no OpenWren account and no OpenWren server that sees your mail.

## Every network request the app makes

| Request | When | To whom |
|---|---|---|
| Reading and sending mail | Always, for the accounts you add | Your own mail servers (IMAP and SMTP) |
| Google sign-in | Only if you choose "Sign in with Google" | Google |
| Remote images in a message | Only when you click "Show images", or for senders you chose to always allow | The server named in the message |
| Unsubscribe | Only when you confirm "Unsubscribe" on a mailing | The sender's unsubscribe address |
| Opening a link | When you click one | Your browser opens it |
| Anonymous usage count | Once a day, unless switched off | `stats.openwren.org` |

Nothing else. No analytics library, no crash reporter, no update check yet.

## The anonymous usage count

Once a day the app tells the project that one more copy is in use, so we know how many people rely on it. It is on by default. Switch it off in **Settings → Privacy → Anonymous usage count**; "Show what is sent" displays the exact request.

The request looks like this:

```json
{ "v": "0.1.0", "pkg": "deb", "os": "ubuntu-24.04", "arch": "x86_64", "d": true, "w": true, "m": false, "first": false, "iw": "2026-W46" }
```

| Field | Meaning |
|---|---|
| `v` | App version |
| `pkg` | How it was installed: deb, rpm, appimage, flatpak or other |
| `os` | Distribution and version |
| `arch` | Processor type |
| `d`, `w`, `m`, `first` | Whether this is the installation's first request today, this week, this month, ever |
| `iw` | The week the app was first used |

- There is **no identifier**: no install id, no account, no cookie. Two requests from the same computer cannot be linked.
- The server adds one to a counter and keeps nothing else: not the request, not your IP address.
- A day the computer was off is not reported later.
- The totals are public on the project's statistics page.

## Never collected

Email addresses, names, subjects, mail text, attachments, contacts, folder names, mail server names, IP addresses.

## Where your data lives

- Mail, search index, drafts, settings: an encrypted database in `~/.local/share/org.openwren.app/`.
- Passwords, Google tokens and the database key: the system keyring.
- Attachments you open: a temporary folder, emptied after 30 minutes and when OpenWren quits.

Removing an account in Settings deletes its local mail and its saved password. Nothing changes on the server.

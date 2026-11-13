---
layout: ../layouts/Base.astro
title: Docs
description: Adding an account, Gmail with an app password, keyboard shortcuts and search operators.
---

# Docs

Adding an account, keyboard shortcuts and search.

- [Adding an account](#adding-an-account)
- [Gmail with an app password](#gmail-with-an-app-password)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Search](#search)
- [Privacy features](#privacy-features)

## Adding an account

Choose "Add account" and pick the type. OpenWren supports IMAP accounts and Gmail. POP3 is not supported.

### IMAP

Enter your address and password. The server names are guessed from your address (`imap.` and `smtp.` plus your domain). Correct them if your provider uses other names.

Your password is kept in the system keyring.

To change an account's details later, remove the account and add it again.

## Gmail with an app password

Gmail does not accept your normal Google password in a mail app. Use an app password instead.

1. Turn on 2-step verification in your Google account, if it is not on yet.
2. Create an app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). You can name it "OpenWren".
3. In OpenWren, choose "Add account", pick Google, and enter your Gmail address and the 16-letter app password.

The app password is stored in your system keyring. You can remove it at any time in your Google account.

### Sign in with Google instead (advanced)

The add-account dialog also offers "Advanced: sign in with Google instead". This route needs your own Google OAuth client:

1. In the Google Cloud console, create a project and enable the Gmail API.
2. Configure the OAuth consent screen, add the scope `https://mail.google.com/`, and add your address as a test user.
3. Create credentials of type "OAuth client ID", application type "Desktop app".
4. Paste the client ID and secret into Settings, under Accounts.
5. Choose "Add account", Google, and sign in in the browser.

While the Google project is in "Testing" status, Google expires the sign-in after about a week.

### Gmail labels

Gmail labels are shown as folders. "All Mail", "Starred" and "Important" are left out to avoid duplicates, and a message with several labels appears once per label.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Search | <kbd>Ctrl</kbd>+<kbd>K</kbd> |
| New mail | <kbd>Ctrl</kbd>+<kbd>N</kbd> |
| Send | <kbd>Ctrl</kbd>+<kbd>Enter</kbd> |
| Delete | <kbd>Delete</kbd> |
| Archive | <kbd>Backspace</kbd> |
| Reply | <kbd>Ctrl</kbd>+<kbd>R</kbd> |
| Reply all | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> |
| Forward | <kbd>Ctrl</kbd>+<kbd>F</kbd> |
| Mark read | <kbd>Ctrl</kbd>+<kbd>Q</kbd> |
| Mark unread | <kbd>Ctrl</kbd>+<kbd>U</kbd> |
| Flag | <kbd>Insert</kbd> |
| Next or previous message | <kbd>Down</kbd> or <kbd>Up</kbd> |
| Undo the last action | <kbd>Ctrl</kbd>+<kbd>Z</kbd> |
| Add to the selection | <kbd>Ctrl</kbd>+click |
| Select a range | <kbd>Shift</kbd>+click |

## Search

Search covers the whole mailbox, including mail that is many years old. Filters narrow the results by account, attachments, or date: the past year, older than one or two years, or a range you choose.

"Search the server for more" also looks through mail text that has not been downloaded yet.

### Search operators

| Operator | Finds |
|---|---|
| `from:` | Mail from a sender, for example `from:anna` |
| `to:` | Mail sent to a recipient |
| `subject:` | Words in the subject |
| `has:attachment` | Mail with attachments |
| `is:unread` | Unread mail |
| `is:flagged` | Flagged mail |
| `before:2024-01-31` | Mail before a date |
| `after:` | Mail after a date, written the same way as `before:` |
| `in:folder` | Mail in a folder, for example `in:archive` |

## Privacy features

- **Remote images** are blocked until you click "Show images".
- **Trackers:** tracking pixels and tracking codes in links are removed.
- **Warnings:** suspicious mail is flagged.
- **Unsubscribe:** mailings can be unsubscribed from inside the app. The request is sent only after you confirm it.
- **Usage count:** the anonymous daily request can be switched off in Settings → Privacy.

The [privacy page](/privacy/) lists every network request the app makes.

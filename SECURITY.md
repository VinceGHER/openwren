# Security

OpenWren reads untrusted mail and holds your account credentials, so security reports are taken seriously.

## Reporting a problem

Please do **not** open a public issue. Use GitHub's private reporting instead: on the repository page choose **Security → Report a vulnerability**.

Include what you found, how to reproduce it, and the version (Settings → About). You will get a reply within a week. Once a fix is released you will be credited, unless you prefer not to be.

## What counts

- Mail content that runs code, loads remote content without being asked, or escapes the reading pane.
- Anything that exposes passwords, tokens, the database key or mail to another program or to the network.
- A way to make OpenWren send requests or mail the user did not ask for.
- Problems in how packages are built or signed.

## How OpenWren protects you

- Mail is stored in an encrypted database (SQLCipher). Its key, your passwords and tokens are kept in the system keyring, not in files.
- Mail HTML is sanitised, then shown in a sandboxed frame with scripts off and all network access blocked until you choose "Show images".
- Tracking images and tracking link parameters are removed; suspicious senders and links are flagged.
- Connections to mail servers verify TLS certificates.

## Supported versions

Only the latest release receives fixes.

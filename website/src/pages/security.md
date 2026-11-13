---
layout: ../layouts/Base.astro
title: Security
description: How to report a vulnerability in OpenWren and how packages are signed.
---

# Security

How to report a vulnerability, and how packages are signed.

## Report a vulnerability

Report security problems privately through GitHub's private vulnerability reporting on the repository:

[Open a private security advisory](https://github.com/VinceGHER/openwren/security/advisories/new)

Please do not open a public issue for a vulnerability. Include the OpenWren version, your distribution, and the steps to reproduce the problem. If a specific message triggers it, attach a copy with private content removed.

## How packages are signed

- **apt and dnf repositories:** signed with one OpenWren GPG key. The apt setup on the [download page](/download/) limits that key to the OpenWren repository with `signed-by`.
- **Key fingerprint:** published on the [download page](/download/#key). Compare it with the key you downloaded before you trust it.

To show the fingerprint of the key on your computer:

```bash
gpg --show-keys --with-fingerprint /usr/share/keyrings/openwren.gpg
```

## How the app protects your mail

- The mail database is encrypted with SQLCipher. Its key is kept in the system keyring, as are passwords and sign-in tokens.
- HTML mail is sanitised before it is shown. Remote images are blocked until you ask for them.
- Tracking pixels and tracking codes in links are removed.
- Mail gets a warning when its sender checks fail (SPF, DKIM, DMARC), when a company name appears on a foreign address, or when a link shows one site but leads to another.

The code is public in the [repository](https://github.com/VinceGHER/openwren), so these claims can be checked.

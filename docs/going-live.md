# Going live: what is on the internet, and what is left

Status on 13 November 2026: the domain `openwren.app` is on the project's Cloudflare account and three services run under it.

| Name | Serves | Deployed from |
|---|---|---|
| `openwren.app`, `www.openwren.app` | The website | `website/` (static files as a Worker) |
| `stats.openwren.app` | The usage counter, with the D1 database `openwren-stats` | `stats/` |
| `packages.openwren.app` | The apt and rpm repositories, files in the R2 bucket `openwren-packages` | `packages/` (read-only file server) |

The website is public although the repository is still private, so its links to the code do not work for visitors yet.

## Deploying again

Sign in once with `pnpm wrangler login` in `stats/`. Then, from `stats/`:

```bash
pnpm wrangler deploy
```

```bash
pnpm --dir ../website build && pnpm wrangler deploy --cwd ../website
```

```bash
pnpm wrangler deploy --cwd ../packages
```

Nothing deploys automatically yet: a change to the website goes live only when the second command is run.

## Packages

The signing key exists: fingerprint `8991 7136 148C 9676 F3A5 1B21 4B8A FB6E 4238 18E0`, valid until November 2028. Its private part is in the GitHub secret `GPG_PRIVATE_KEY`. Keep one more copy offline, somewhere safe; without it no later release can be signed with the same key.

Version 0.1.0 in the repositories was built by hand on a recent system, so it installs on Ubuntu 24.04 and Fedora but not on Debian 12 or Ubuntu 22.04. The release workflow builds on Ubuntu 22.04 and replaces it.

Still to do before the release workflow can upload:

1. In the Cloudflare dashboard: R2 → Manage API tokens → create a token with "Object Read & Write" on `openwren-packages` only.
2. Add its two values to the repository:

```bash
gh secret set R2_ACCESS_KEY_ID
```

```bash
gh secret set R2_SECRET_ACCESS_KEY
```

3. Cut a release. The workflow has never run; expect to fix small things on its first run.

```bash
git tag v0.1.0 && git push --tags
```

Details: [packaging.md](packaging.md).

## Gmail sign-in for everyone (later)

Today Gmail works for everyone through an app password. One-click "Sign in with Google" needs Google to approve the app for full mail access. When you decide to start:

1. Website live on `openwren.app` with the privacy page, and the domain verified in Google Search Console.
2. In Google Cloud: OAuth consent screen set to External and In production, with app name, logo, home page, privacy policy and the scope `https://mail.google.com/`.
3. Submit for verification: a written justification for the scope and a demo video of the sign-in and of how mail data is used.
4. Pass the yearly security assessment Google requires for restricted scopes (a paid review by an approved lab).
5. Build official packages with the approved client ID set at build time, so forks do not ship it.

Until approval, a project in "Testing" allows at most 100 named test users and their sign-in expires every week.

## Before making the repository public

- Check the name once more: another project uses "openwren" for an AI assistant bot (GitHub `openwrenai/openwren`, npm `openwren`). Consider registering the name as a trademark; see [TRADEMARKS.md](../TRADEMARKS.md).
- Get an outside security review of mail rendering and the unsubscribe request.
- Make sure `SECURITY.md`'s private reporting is switched on in the repository settings.
- Run the release workflow once on a test tag and install each package on a clean system.

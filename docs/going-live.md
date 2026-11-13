# Going live: what is left to do outside the code

Everything in the repository works locally. These steps put it on the internet. Each needs an account or a payment that only the project owner can make.

Status on 13 November 2026: the Cloudflare account has no D1 database and no Worker yet, and R2 storage is not switched on. `openwren.org` is not registered.

## 1. Domain

1. Register `openwren.org` (Cloudflare Registrar keeps the DNS in the same place as everything else). `openwren.app`, `.io` and `.dev` were also free; `.com` is taken.
2. Add the domain to the Cloudflare account, if it was registered elsewhere.

The app, the website and the documentation already point at three names under it:

| Name | Serves |
|---|---|
| `openwren.org` | The website (Cloudflare Pages) |
| `stats.openwren.org` | The usage counter (Cloudflare Worker) |
| `packages.openwren.org` | The apt and rpm repositories (Cloudflare R2) |

Until the domain exists, the app's daily usage request fails silently and nothing is counted.

## 2. Usage counter (`stats/`)

From the `stats/` folder, signed in with `wrangler login`:

```bash
pnpm install
```

```bash
pnpm wrangler d1 create openwren-stats
```

Put the database id it prints into `wrangler.toml` (`database_id`), then:

```bash
pnpm wrangler d1 migrations apply openwren-stats --remote
```

```bash
pnpm wrangler deploy
```

Finally uncomment the `routes` block in `wrangler.toml` (custom domain `stats.openwren.org`) and deploy again. Check it:

```bash
curl -s https://stats.openwren.org/api/daily?days=7
```

Details and what is stored: [stats/README.md](../stats/README.md).

## 3. Website (`website/`)

In the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git → `VinceGHER/openwren`.

| Setting | Value |
|---|---|
| Root directory | `website` |
| Build command | `pnpm install --frozen-lockfile && pnpm build` |
| Output directory | `dist` |
| Environment variable | `NODE_VERSION` = `22` |
| Custom domain | `openwren.org` |

While the project is private, restrict the site with Cloudflare Access (Zero Trust → Access → add an application for `openwren.org`, allow your own address), or simply do not attach the custom domain yet.

## 4. Packages (`scripts/`, `.github/workflows/release.yml`)

1. Switch on R2 in the Cloudflare dashboard (it asks for a payment method; the free allowance covers this use).
2. Create a bucket, for example `openwren-packages`, and connect the custom domain `packages.openwren.org` to it.
3. Create an R2 API token with read and write access to that bucket.
4. Create the signing key and add the secrets to the GitHub repository. The exact commands and secret names are in [packaging.md](packaging.md).
5. Put the key's fingerprint on the website's Download page (it has a marked placeholder).
6. Cut a release:

```bash
git tag v0.1.0 && git push --tags
```

The release workflow has never run. Expect to fix small things on its first run.

## 5. Gmail sign-in for everyone (later)

Today Gmail works for everyone through an app password. One-click "Sign in with Google" needs Google to approve the app for full mail access. When you decide to start:

1. Website live on `openwren.org` with the privacy page, and the domain verified in Google Search Console.
2. In Google Cloud: OAuth consent screen set to External and In production, with app name, logo, home page, privacy policy and the scope `https://mail.google.com/`.
3. Submit for verification: a written justification for the scope and a demo video of the sign-in and of how mail data is used.
4. Pass the yearly security assessment Google requires for restricted scopes (a paid review by an approved lab).
5. Build official packages with the approved client ID set at build time, so forks do not ship it.

Until approval, a project in "Testing" allows at most 100 named test users and their sign-in expires every week.

## 6. Before making the repository public

- Check the name once more: another project uses "openwren" for an AI assistant bot (GitHub `openwrenai/openwren`, npm `openwren`). Consider registering the name as a trademark; see [TRADEMARKS.md](../TRADEMARKS.md).
- Get an outside security review of mail rendering and the unsubscribe request.
- Make sure `SECURITY.md`'s private reporting is switched on in the repository settings.
- Run the release workflow once on a test tag and install each package on a clean system.

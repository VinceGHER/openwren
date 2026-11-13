# OpenWren website

The static site for [openwren.app](https://openwren.app), built with [Astro](https://astro.build). It is plain HTML and CSS; only the Stats page uses JavaScript. No cookies, no analytics, no third-party scripts or fonts (Inter is bundled from `@fontsource-variable/inter`).

## Run and build

Needs Node.js 22 or later and pnpm. From the project root:

| Command | What it does |
|---|---|
| `pnpm --dir website install` | Install dependencies |
| `pnpm --dir website dev` | Run the site with live reload at http://localhost:4321 |
| `pnpm --dir website build` | Build the site into `website/dist/` |
| `pnpm --dir website preview` | Serve the built `dist/` at http://localhost:4321 (add `--port 4400` for another port) |

## Pages

| Address | Source |
|---|---|
| `/` | `src/pages/index.astro` |
| `/download/` | `src/pages/download.astro` |
| `/privacy/` | `src/pages/privacy.md` |
| `/security/` | `src/pages/security.md` |
| `/docs/` | `src/pages/docs.md` |
| `/stats/` | `src/pages/stats.astro` |

The layout, header and footer are in `src/layouts/Base.astro`; colours and type are in `src/styles/global.css`. The repository address is set once in `src/site.ts`.

## Stats page

The page fetches `GET {STATS_URL}/api/daily?days=90` in the browser. `STATS_URL` is `https://stats.openwren.app` unless the environment variable `PUBLIC_STATS_URL` is set at build time. The Worker must allow cross-origin requests from `https://openwren.app` (an `Access-Control-Allow-Origin` header), or the page shows "The numbers could not be loaded".

### Checking it without the Worker

Sample data is in `src/fixtures/daily.json`. When `PUBLIC_STATS_URL` starts with `/fixture`, the build adds two local files that follow the Worker's contract (`src/pages/[...fixture].ts`); a normal build contains neither.

| Command | Shows |
|---|---|
| `pnpm --dir website build:fixture` then `preview` | The dashboard with the sample data, re-dated so its last day is today |
| `PUBLIC_STATS_URL=/fixture-empty pnpm --dir website build` then `preview` | The "No data yet" message |
| `PUBLIC_STATS_URL=/missing pnpm --dir website build` then `preview` | The "could not be loaded" message |

The same values work with `dev`, for example `PUBLIC_STATS_URL=/fixture pnpm --dir website dev`. Run a normal `build` again before deploying.

## Screenshots

The screenshots do not exist yet. Put these files in `website/public/screens/` and rebuild:

| File | Shown on | Suggested size |
|---|---|---|
| `inbox.png` | Home, below the introduction | 1600 × 1000 |
| `warning.png` | Home, next to "Warnings on suspicious mail" | 1200 × 800 |
| `welcome.png` | Home, next to "Add an account and start" | 1200 × 800 |

While a file is missing, the page shows a neutral frame with the logo instead (decided at build time in `src/components/Screenshot.astro`). If a screenshot has other proportions, change the `width` and `height` passed in `src/pages/index.astro`.

The logo `public/openwren-logo.svg` is a copy of `design/openwren-logo.svg` and is also the favicon.

## Placeholders to fill in

- The three screenshots above.

## Deploying

The site is served at `openwren.app` as static files (`wrangler.toml`). After a change:

```bash
pnpm build && pnpm dlx wrangler deploy
```

Leave `PUBLIC_STATS_URL` unset to use `https://stats.openwren.app`.


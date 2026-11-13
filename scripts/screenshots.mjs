// Takes the screenshots used in the README and on the website.
//
//   pnpm dev            (in another terminal: the interface on sample mail)
//   node scripts/screenshots.mjs
//
// Needs a Chromium: set CHROME to its path, or have Playwright's browsers
// installed (`pnpm dlx playwright install chromium`). The sample mail comes
// from src/backend/sample.ts, so the pictures show no real messages.
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const url = process.env.OPENWREN_URL ?? "http://localhost:1420";
const out = new URL("../docs/", import.meta.url).pathname;
const site = new URL("../website/public/screens/", import.meta.url).pathname;

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), ".cache", "ms-playwright");
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse() : []) {
    for (const sub of ["chrome-linux64", "chrome-linux"]) {
      const file = join(cache, dir, sub, "chrome");
      if (existsSync(file)) return file;
    }
  }
  throw new Error("No Chromium found. Set CHROME=/path/to/chrome.");
}

const browser = await chromium.launch({ executablePath: findChrome() });
mkdirSync(out, { recursive: true });

async function shots(scheme) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  const name = (base) => join(out, scheme === "dark" ? `${base}-dark.png` : `${base}.png`);
  const open = async () => {
    await page.goto(url);
    await page.waitForSelector('[aria-label="Message list"] [role=option]');
    await page.evaluate(() => document.fonts.ready);
  };
  const row = (text) => page.locator('[aria-label="Message list"] [role=option]', { hasText: text }).first();

  // The inbox with an ordinary message open.
  await open();
  await row("Mona Kane").click();
  await page.waitForSelector('[aria-label="Reading pane"] h1');
  await page.waitForTimeout(400);
  await page.screenshot({ path: name("inbox") });

  // A suspicious message, with the reasons shown.
  await row("PayPal Security").click();
  await page.locator('[aria-label="Reading pane"] [role=alert] button', { hasText: "Details" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: name("warning") });

  // A mailing: trackers removed, unsubscribe offered.
  await page.locator("[aria-label=Show] button", { hasText: "Other" }).click();
  await row("Spotify").click();
  await page.waitForSelector('[aria-label="Reading pane"] iframe');
  await page.waitForTimeout(400);
  await page.screenshot({ path: name("mailing") });

  // The welcome screen.
  await page.locator('button[aria-label="Settings"]').click();
  await page.locator('nav[aria-label="Settings sections"] button', { hasText: "About" }).click();
  await page.locator("[role=dialog] button", { hasText: "welcome screens" }).click();
  await page.waitForSelector('[aria-label="Welcome to OpenWren"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: name("welcome") });
  await context.close();
}

await shots("light");
await shots("dark");
await browser.close();

// The website shows the light ones.
if (existsSync(join(site, ".."))) {
  mkdirSync(site, { recursive: true });
  for (const file of ["inbox.png", "warning.png", "welcome.png"]) copyFileSync(join(out, file), join(site, file));
}
console.log(`Screenshots written to ${out}`);

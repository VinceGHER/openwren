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

  if (scheme === "light") await features(page, open, row);

  // The welcome screen.
  await page.locator('button[aria-label="Settings"]').click();
  await page.locator('nav[aria-label="Settings sections"] button', { hasText: "About" }).click();
  await page.locator("[role=dialog] button", { hasText: "welcome screens" }).click();
  await page.waitForSelector('[aria-label="Welcome to OpenWren"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: name("welcome") });
  await context.close();
}

/** Smaller pictures, one per feature, for the README's feature list. */
async function features(page, open, row) {
  const dir = join(out, "features");
  mkdirSync(dir, { recursive: true });
  const pane = page.locator('[aria-label="Reading pane"]');
  // The top part of an area, without the empty space below it.
  const top = async (area, file, height) => {
    const box = await area.boundingBox();
    await page.screenshot({ path: join(dir, file), clip: { x: box.x, y: box.y, width: box.width, height } });
  };
  const left = { x: 0, y: 0, width: 600, height: 760 };

  // Several accounts, one inbox.
  await open();
  await page.locator('nav[aria-label=Folders] button', { hasText: "All inboxes" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, "accounts.png"), clip: left });

  // Search with operators and filters.
  await page.locator('input[aria-label="Search mail"]').fill("invoice");
  await page.waitForTimeout(700);
  const list = await page.locator("[aria-label=Messages]").boundingBox();
  await page.screenshot({ path: join(dir, "search.png"), clip: { x: list.x, y: 0, width: list.width, height: 620 } });
  await page.locator('input[aria-label="Search mail"]').fill("");

  // A suspicious message.
  await open();
  await row("PayPal Security").click();
  await pane.locator("[role=alert] button", { hasText: "Details" }).click();
  await page.waitForTimeout(300);
  await top(pane, "phishing.png", 430);

  // Trackers removed and unsubscribe.
  await page.locator("[aria-label=Show] button", { hasText: "Other" }).click();
  await row("Spotify").click();
  await page.waitForSelector('[aria-label="Reading pane"] iframe');
  await page.waitForTimeout(400);
  await top(pane, "trackers.png", 350);

  // The "more" menu: move, colours, block, view source.
  await open();
  await row("Mona Kane").click();
  await page.waitForTimeout(400);
  await page.locator('[aria-label="More actions"]').click();
  await page.locator("[role=menu] [role=menuitem]", { hasText: "Move to" }).click();
  await page.waitForTimeout(200);
  await top(pane, "organise.png", 560);
  await page.keyboard.press("Escape");

  // Writing a message.
  await open();
  await page.locator("nav[aria-label=Folders] button", { hasText: "New mail" }).click();
  const composer = page.locator('section[aria-label="New message"]');
  await composer.locator('input[placeholder="name@company.com"]').fill("Mona Kane <mona.kane@example.com>");
  await composer.locator("label", { hasText: "Subject" }).locator("input").fill("Agenda for Thursday");
  await composer.locator(".ProseMirror").click();
  await page.keyboard.type("Hi Mona,");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Here is the agenda for Thursday. I have added the budget review as the first point.");
  await page.waitForTimeout(1800);
  const box = await composer.boundingBox();
  await page.screenshot({ path: join(dir, "writing.png"), clip: { x: box.x, y: box.y, width: box.width, height: 330 } });

  // Privacy settings.
  await open();
  await page.locator('button[aria-label="Settings"]').click();
  await page.locator('nav[aria-label="Settings sections"] button', { hasText: "Privacy" }).click();
  await page.waitForTimeout(300);
  await page.locator('[role=dialog][aria-label="Settings"]').screenshot({ path: join(dir, "privacy.png") });
  await page.keyboard.press("Escape");
  await open();
}

/** The banner at the top of the README, also sized for GitHub's social preview. */
async function cover() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(new URL("./cover.html", import.meta.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, "cover.png") });
  await context.close();
}

await shots("light");
await shots("dark");
await cover();
await browser.close();

// The website shows the light ones.
if (existsSync(join(site, ".."))) {
  mkdirSync(site, { recursive: true });
  for (const file of ["inbox.png", "warning.png", "welcome.png"]) copyFileSync(join(out, file), join(site, file));
}
console.log(`Screenshots written to ${out}`);

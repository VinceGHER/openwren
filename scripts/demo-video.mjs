// Records the short demo video shown on the website's home page.
//
//   pnpm dev            (in another terminal: the interface on sample mail)
//   node scripts/demo-video.mjs
//
// Writes website/public/screens/demo.mp4, demo.webm and demo-poster.jpg.
// Needs a Chromium (see scripts/screenshots.mjs) and ffmpeg on the PATH. The mail is the
// sample mail from src/backend/sample.ts, so no real message is shown.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const url = process.env.OPENWREN_URL ?? "http://localhost:1420";
const site = new URL("../website/public/screens/", import.meta.url).pathname;
const size = { width: 1280, height: 800 };

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

const work = mkdtempSync(join(tmpdir(), "openwren-demo-"));
const browser = await chromium.launch({ executablePath: findChrome() });
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2 });
// A recording shows no mouse pointer, so the page draws one that follows the mouse.
await context.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText = "position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(37,110,243,.35);border:2px solid #256ef3;pointer-events:none;left:-50px;top:-50px;transition:transform .12s";
    document.body.appendChild(dot);
    addEventListener("mousemove", (e) => ((dot.style.left = `${e.clientX}px`), (dot.style.top = `${e.clientY}px`)), true);
    addEventListener("mousedown", () => (dot.style.transform = "scale(.7)"), true);
    addEventListener("mouseup", () => (dot.style.transform = ""), true);
  });
});
const page = await context.newPage();

// Frames come straight from the browser, each with the time it was drawn; ffmpeg
// joins them afterwards. (Playwright's own recorder needs a download of its own.)
const frames = [];
const cdp = await context.newCDPSession(page);
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  const file = join(work, `${String(frames.length).padStart(5, "0")}.jpg`);
  writeFileSync(file, Buffer.from(data, "base64"));
  frames.push({ file, at: metadata.timestamp });
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
const wait = (ms) => page.waitForTimeout(ms);
/** Move the pointer to an element at a human pace, then click it. */
async function click(target, pause = 1500) {
  const box = await target.boundingBox();
  await page.mouse.move(box.x + Math.min(box.width / 2, 160), box.y + box.height / 2, { steps: 22 });
  await wait(180);
  await target.click();
  await wait(pause);
}
const row = (text) => page.locator('[aria-label="Message list"] [role=option]', { hasText: text }).first();
const chip = (text) => page.locator("[aria-label=Show] button", { hasText: text });

await page.goto(url);
await page.waitForSelector('[aria-label="Message list"] [role=option]');
await page.evaluate(() => document.fonts.ready);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: size.width * 2, maxHeight: size.height * 2, everyNthFrame: 1 });
await page.mouse.move(640, 400);
await wait(1400);

// Read a few messages: they open at once.
await click(row("GitHub"));
await click(row("Stripe"));
await click(row("Mona Kane"), 1800);

// A forged message, and why it is flagged.
await click(row("PayPal Security"), 1200);
await click(page.locator('[aria-label="Reading pane"] [role=alert] button', { hasText: "Details" }), 2600);

// A mailing: trackers removed, unsubscribe offered.
await click(chip("Other"), 700);
await click(row("Spotify"), 2400);
await click(chip("All"), 600);

// Search the whole mailbox.
const search = page.getByPlaceholder("Search mail");
await click(search, 300);
await search.pressSequentially("invoice", { delay: 110 });
await wait(2200);
await search.fill("");
await wait(500);

// Write a message.
await click(page.locator("button", { hasText: "New mail" }).first(), 700);
await page.getByPlaceholder("name@company.com").pressSequentially("mona.kane@example.com", { delay: 45 });
await page.locator('section[aria-label="New message"] label', { hasText: "Subject" }).locator("input").pressSequentially("Friday works for me", { delay: 55 });
const editor = page.locator('section[aria-label="New message"] [contenteditable=true]').first();
await editor.click();
await editor.pressSequentially("Hi Mona, the draft looks great. See you on Friday.", { delay: 38 });
await wait(2000);
await click(page.locator('button[aria-label="Discard draft"]'), 1200);

await cdp.send("Page.stopScreencast");
const ended = Date.now() / 1000;
await context.close();
await browser.close();

// Each frame is shown until the next one was drawn.
const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.01, (frames[i + 1]?.at ?? Math.max(ended, f.at + 0.5)) - f.at).toFixed(3)}`).join("\n");
writeFileSync(join(work, "frames.txt"), `${list}\nfile '${frames[frames.length - 1].file}'\n`);
const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"), "-an", "-vf", "fps=30,scale=1600:-2:flags=lanczos"];
execFileSync("ffmpeg", [...input, "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(site, "demo.mp4")]);
execFileSync("ffmpeg", [...input, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-row-mt", "1", join(site, "demo.webm")]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", frames[0].file, "-vf", "scale=1600:-2:flags=lanczos", "-q:v", "3", join(site, "demo-poster.jpg")]);
rmSync(work, { recursive: true, force: true });
console.log(`demo video: ${frames.length} frames, ${(frames[frames.length - 1].at - frames[0].at).toFixed(1)} s`);

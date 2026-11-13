// Worker entry: wires the pure functions in counting.ts to D1.
// It reads the request body and the Origin header and nothing else, stores
// only a counter, and never logs.

import { MAX_BODY_BYTES, MAX_ROWS_PER_DAY, aggregate, allowedOrigin, folded, parseDays, parsePing, period, utcDay, type CounterRow, type Ping } from "./counting";

export interface Env {
  DB: D1Database;
}

const text = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });

/** The body as text, or null as soon as it turns out to be larger than the limit. */
async function readSmallBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

const KEY = "day = ? AND v = ? AND pkg = ? AND os = ? AND arch = ? AND d = ? AND w = ? AND m = ? AND first = ? AND iw = ?";
const keyOf = (day: string, p: Ping) => [day, p.v, p.pkg, p.os, p.arch, Number(p.d), Number(p.w), Number(p.m), Number(p.first), p.iw];

/** Add one to the row for this combination; false when the day has no such row yet. */
async function addToExisting(env: Env, day: string, counted: Ping): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE counters SET n = n + 1 WHERE ${KEY}`).bind(...keyOf(day, counted)).run();
  return (result.meta?.changes ?? 0) > 0;
}

async function ping(request: Request, env: Env, now: Date): Promise<Response> {
  const body = await readSmallBody(request);
  const counted = body === null ? null : parsePing(body, now);
  if (!counted) return text(400, "Bad request\n");
  const day = utcDay(now); // the server's date; the client never supplies one
  if (await addToExisting(env, day, counted)) return new Response(null, { status: 204 });

  // A combination not seen today. Past the day's row limit it is folded into an "other" row.
  const { results } = await env.DB.prepare("SELECT rows FROM day_rows WHERE day = ?").bind(day).all<{ rows: number }>();
  const full = (results[0]?.rows ?? 0) >= MAX_ROWS_PER_DAY;
  const stored = full ? folded(counted) : counted;
  if (full && (await addToExisting(env, day, stored))) return new Response(null, { status: 204 });
  await env.DB.prepare(
    `INSERT INTO counters (day, v, pkg, os, arch, d, w, m, first, iw, n)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (day, v, pkg, os, arch, d, w, m, first, iw) DO UPDATE SET n = n + 1`,
  )
    .bind(...keyOf(day, stored))
    .run();
  await env.DB.prepare("INSERT INTO day_rows (day, rows) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET rows = rows + 1").bind(day).run();
  return new Response(null, { status: 204 });
}

async function daily(request: Request, env: Env, now: Date): Promise<Response> {
  const origin = allowedOrigin(request.headers.get("Origin"));
  const cors: Record<string, string> = { Vary: "Origin" };
  if (origin) {
    cors["Access-Control-Allow-Origin"] = origin;
    cors["Access-Control-Allow-Methods"] = "GET";
  }
  const days = parseDays(new URL(request.url).searchParams.get("days"));
  if (days === null) return text(400, "days must be a whole number from 1 to 365\n", cors);
  const today = utcDay(now);
  const { results } = await env.DB.prepare(
    `SELECT day, v, pkg, os, d, w, m, first, SUM(n) AS n FROM counters
     WHERE day >= ? AND day <= ?
     GROUP BY day, v, pkg, os, d, w, m, first`,
  )
    .bind(period(today, days)[0], today)
    .all<CounterRow>();
  return new Response(JSON.stringify(aggregate(results, today, days)), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=600",
      ...cors,
    },
  });
}

/** `now` is a parameter so tests can set the server clock. */
export async function handle(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/ping") {
    return request.method === "POST" ? ping(request, env, now) : text(405, "Method not allowed\n", { Allow: "POST" });
  }
  if (pathname === "/api/daily") {
    return request.method === "GET" ? daily(request, env, now) : text(405, "Method not allowed\n", { Allow: "GET" });
  }
  return text(404, "Not found\n");
}

/** How long the totals may be served from Cloudflare's cache, in seconds. */
const TOTALS_CACHE_SECONDS = 600;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Never answer over plain HTTP: send the caller to the same address over HTTPS.
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { Location: url.toString() } });
    }
    // The totals change slowly and reading them scans many rows, so they are cached.
    // The key holds only the query and the allowed origin, which decides the CORS headers.
    const cacheable = request.method === "GET" && url.pathname === "/api/daily";
    const key = new Request(`https://cache.openwren.invalid/daily?days=${url.searchParams.get("days") ?? ""}&origin=${allowedOrigin(request.headers.get("Origin")) ?? ""}`);
    if (cacheable) {
      const hit = await caches.default.match(key);
      if (hit) return hit;
    }
    const response = await handle(request, env);
    const headers = new Headers(response.headers);
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    headers.set("X-Content-Type-Options", "nosniff");
    const secured = new Response(response.body, { status: response.status, headers });
    if (cacheable && response.status === 200) {
      const copy = secured.clone();
      copy.headers.set("Cache-Control", `public, max-age=${TOTALS_CACHE_SECONDS}`);
      ctx.waitUntil(caches.default.put(key, copy));
    }
    return secured;
  },
} satisfies ExportedHandler<Env>;

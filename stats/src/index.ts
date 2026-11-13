// Worker entry: wires the pure functions in counting.ts to D1.
// It reads the request body and the Origin header and nothing else, stores
// only a counter, and never logs.

import { MAX_BODY_BYTES, aggregate, allowedOrigin, parseDays, parsePing, period, utcDay, type CounterRow } from "./counting";

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

async function ping(request: Request, env: Env, now: Date): Promise<Response> {
  const body = await readSmallBody(request);
  const counted = body === null ? null : parsePing(body);
  if (!counted) return text(400, "Bad request\n");
  await env.DB.prepare(
    `INSERT INTO counters (day, v, pkg, os, arch, d, w, m, first, iw, n)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (day, v, pkg, os, arch, d, w, m, first, iw) DO UPDATE SET n = n + 1`,
  )
    .bind(
      utcDay(now), // the server's date; the client never supplies one
      counted.v, counted.pkg, counted.os, counted.arch,
      Number(counted.d), Number(counted.w), Number(counted.m), Number(counted.first),
      counted.iw,
    )
    .run();
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

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
} satisfies ExportedHandler<Env>;

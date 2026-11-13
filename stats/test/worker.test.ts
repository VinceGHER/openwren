// The Worker entry against a real SQLite database (Node's own), created from
// the same migration file that D1 gets, so the SQL is exercised too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Env } from "../src/index";

function fakeD1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      let values: (string | number)[] = [];
      const statement = {
        bind(...args: (string | number)[]) {
          values = args;
          return statement;
        },
        async run() {
          db.prepare(sql).run(...values);
          return { success: true };
        },
        async all() {
          return { results: db.prepare(sql).all(...values), success: true };
        },
      };
      return statement;
    },
  };
}

let db: DatabaseSync;
let env: Env;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "../migrations/0001_counters.sql"), "utf8"));
  env = { DB: fakeD1(db) as unknown as D1Database };
});

const good = { v: "0.1.0", pkg: "deb", os: "ubuntu-24.04", arch: "x86_64", d: true, w: true, m: false, first: false, iw: "2026-W46" };
const at = (iso: string) => new Date(iso);
const post = (body: unknown, now = at("2026-11-13T10:00:00Z"), headers: Record<string, string> = {}) =>
  handle(
    new Request("https://stats.openwren.app/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    now,
  );
const get = (path: string, now = at("2026-11-13T10:00:00Z"), headers: Record<string, string> = {}) =>
  handle(new Request(`https://stats.openwren.app${path}`, { headers }), env, now);
const rows = () => db.prepare("SELECT * FROM counters ORDER BY day, v, os").all() as Record<string, unknown>[];

describe("POST /ping", () => {
  it("answers 204 with no body and adds one to a counter", async () => {
    const response = await post(good);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    await post(good);
    await post({ ...good, os: "fedora-41" });
    expect(rows().map((r) => [r.os, r.n])).toEqual([["fedora-41", 1], ["ubuntu-24.04", 2]]);
  });

  it("stores exactly the counter columns and nothing about the sender", async () => {
    await post({ ...good, day: "1999-01-01", id: "abc" }, at("2026-11-13T10:00:00Z"), {
      "User-Agent": "OpenWren",
      "CF-Connecting-IP": "203.0.113.7",
      "X-Forwarded-For": "203.0.113.7",
    });
    expect(rows()).toEqual([
      { day: "2026-11-13", v: "0.1.0", pkg: "deb", os: "ubuntu-24.04", arch: "x86_64", d: 1, w: 1, m: 0, first: 0, iw: "2026-W46", n: 1 },
    ]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables).toEqual([{ name: "counters" }]);
  });

  it("takes the day from the server clock, in UTC", async () => {
    await post({ ...good, day: "2020-01-01" }, at("2026-11-13T23:59:59Z"));
    await post(good, at("2026-11-14T00:00:01Z"));
    expect(rows().map((r) => r.day)).toEqual(["2026-11-13", "2026-11-14"]);
  });

  it("stores unknown system, package and processor as other", async () => {
    await post({ ...good, os: "gentoo-2.17", pkg: "snap", arch: "riscv64" });
    expect(rows()[0]).toMatchObject({ os: "other", pkg: "other", arch: "other" });
  });

  it("rejects malformed requests with 400 and stores nothing", async () => {
    const { v: _v, ...withoutVersion } = good;
    for (const body of ["not json", "", "[]", withoutVersion, { ...good, d: "yes" }, { ...good, v: "one" }, { ...good, iw: "2026-46" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(rows()).toEqual([]);
  });

  it("rejects a body larger than 1 KB", async () => {
    expect((await post({ ...good, pad: "x".repeat(2000) })).status).toBe(400);
    expect((await post(good, undefined, { "Content-Length": "5000" })).status).toBe(400);
    expect(rows()).toEqual([]);
  });
});

describe("GET /api/daily", () => {
  it("reads back what was sent, over several days including empty ones", async () => {
    for (let i = 0; i < 6; i++) await post({ ...good, first: i < 2 }, at("2026-11-11T08:00:00Z"));
    for (let i = 0; i < 5; i++) await post({ ...good, w: false, arch: "aarch64", iw: `2026-W4${i}` }, at("2026-11-13T08:00:00Z"));
    await post({ ...good, v: "0.2.0", os: "arch", pkg: "appimage", m: true }, at("2026-11-13T09:00:00Z"));

    const response = await get("/api/daily?days=4");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(await response.json()).toEqual({
      days: [
        { day: "2026-11-10", daily: 0, weekly: 0, monthly: 0, new: 0 },
        { day: "2026-11-11", daily: 6, weekly: 6, monthly: 0, new: 2 },
        { day: "2026-11-12", daily: 0, weekly: 0, monthly: 0, new: 0 },
        { day: "2026-11-13", daily: 6, weekly: 1, monthly: 1, new: 0 },
      ],
      byVersion: [{ name: "0.1.0", count: 11 }, { name: "other", count: 1 }],
      byPackage: [{ name: "deb", count: 11 }, { name: "other", count: 1 }],
      bySystem: [{ name: "ubuntu-24.04", count: 11 }, { name: "other", count: 1 }],
    });
  });

  it("defaults to 90 days, caps at 365, rejects a bad number", async () => {
    await post(good, at("2025-01-01T00:00:00Z")); // older than any period
    const length = async (path: string) => ((await (await get(path)).json()) as { days: unknown[] }).days.length;
    expect(await length("/api/daily")).toBe(90);
    expect(await length("/api/daily?days=1")).toBe(1);
    expect(await length("/api/daily?days=365")).toBe(365);
    expect(await length("/api/daily?days=5000")).toBe(365);
    expect((await get("/api/daily?days=0")).status).toBe(400);
    expect((await get("/api/daily?days=abc")).status).toBe(400);
    const year = (await (await get("/api/daily?days=365")).json()) as { days: { day: string; daily: number }[] };
    expect(year.days[0].day).toBe("2025-11-14");
    expect(year.days.at(-1)?.day).toBe("2026-11-13");
    expect(year.days.every((d) => d.daily === 0)).toBe(true);
  });

  it("allows the website and localhost to read it, and nobody else", async () => {
    const allow = async (origin?: string) =>
      (await get("/api/daily?days=1", undefined, origin ? { Origin: origin } : {})).headers.get("Access-Control-Allow-Origin");
    expect(await allow("https://openwren.app")).toBe("https://openwren.app");
    expect(await allow("http://localhost:4321")).toBe("http://localhost:4321");
    expect(await allow("https://evil.example")).toBeNull();
    expect(await allow()).toBeNull();
    expect((await get("/api/daily?days=1")).headers.get("Vary")).toBe("Origin");
  });
});

describe("routing", () => {
  it("answers 404 for unknown paths and 405 for the wrong method", async () => {
    expect((await get("/")).status).toBe(404);
    expect((await get("/api")).status).toBe(404);
    expect((await get("/ping/")).status).toBe(404);
    const wrongPing = await get("/ping");
    expect(wrongPing.status).toBe(405);
    expect(wrongPing.headers.get("Allow")).toBe("POST");
    const wrongDaily = await handle(new Request("https://stats.openwren.app/api/daily", { method: "POST", body: "{}" }), env);
    expect(wrongDaily.status).toBe(405);
    expect(wrongDaily.headers.get("Allow")).toBe("GET");
  });
});

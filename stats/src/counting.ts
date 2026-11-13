// Validation of incoming requests and aggregation of counters.
// Pure functions only: nothing here knows about Cloudflare, so all of it can
// be unit-tested with plain vitest.

export const MAX_BODY_BYTES = 1024;
export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 365;
/** Groups smaller than this are folded into "other" in the breakdowns. */
export const MIN_GROUP = 5;

const PACKAGES = ["deb", "rpm", "appimage", "flatpak", "other"];
const ARCHES = ["x86_64", "aarch64"];
const OS_IDS = [
  "ubuntu", "debian", "fedora", "arch", "linuxmint", "pop", "opensuse",
  "opensuse-tumbleweed", "opensuse-leap", "manjaro", "nixos", "rhel", "centos",
  "rocky", "almalinux", "zorin", "elementary", "endeavouros", "kali",
];
const OS_PATTERN = new RegExp(`^(?:${OS_IDS.join("|")})(?:-\\d{1,2}(?:\\.\\d{1,2})?)?$`);
const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const WEEK_PATTERN = /^(\d{4})-W(\d{2})$/;
/** The year OpenWren was first released: no installation is older. */
const FIRST_YEAR = 2026;

/**
 * At most this many different counter rows are created per day. Real use needs
 * far fewer; the limit keeps someone who sends made-up versions and dates from
 * filling the database. Requests past it are counted in "other" rows.
 */
export const MAX_ROWS_PER_DAY = 2000;

/** A week that can exist: 01 to 53, from the first release year to next year at most. */
function plausibleWeek(iw: string, now: Date): boolean {
  const match = WEEK_PATTERN.exec(iw);
  if (!match) return false;
  const [year, week] = [Number(match[1]), Number(match[2])];
  return year >= FIRST_YEAR && year <= now.getUTCFullYear() + 1 && week >= 1 && week <= 53;
}

/** The same request with its free-form facts folded away, for days that reached the row limit. */
export function folded(ping: Ping): Ping {
  return { ...ping, v: "other", os: "other", iw: "other" };
}

/** What is counted for one request: the key of a counter row, minus the day. */
export interface Ping {
  v: string;
  pkg: string;
  os: string;
  arch: string;
  d: boolean;
  w: boolean;
  m: boolean;
  first: boolean;
  iw: string;
}

/**
 * Turn a request body into a Ping, or null when it must be rejected.
 * Unknown package, system and processor values become "other"; unknown extra
 * fields are dropped.
 */
export function parsePing(body: string, now: Date = new Date()): Ping | null {
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const f = data as Record<string, unknown>;
  const { v, pkg, os, arch, d, w, m, first, iw } = f;
  if (typeof v !== "string" || !VERSION_PATTERN.test(v)) return null;
  if (typeof pkg !== "string" || typeof os !== "string" || typeof arch !== "string") return null;
  if (typeof d !== "boolean" || typeof w !== "boolean" || typeof m !== "boolean" || typeof first !== "boolean") return null;
  if (typeof iw !== "string" || !plausibleWeek(iw, now)) return null;
  return {
    v,
    pkg: PACKAGES.includes(pkg) ? pkg : "other",
    os: OS_PATTERN.test(os) ? os : "other",
    arch: ARCHES.includes(arch) ? arch : "other",
    d, w, m, first, iw,
  };
}

/** The UTC date of a moment, as YYYY-MM-DD. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The `days` query parameter: 90 when absent, capped at 365, null when it is
 * not a whole number of at least 1.
 */
export function parseDays(param: string | null): number | null {
  if (param === null) return DEFAULT_DAYS;
  if (!/^\d{1,6}$/.test(param)) return null;
  const days = Number(param);
  if (days < 1) return null;
  return Math.min(days, MAX_DAYS);
}

/** The `days` dates ending today, oldest first. */
export function period(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  const list: string[] = [];
  for (let back = days - 1; back >= 0; back--) {
    list.push(new Date(end - back * 86_400_000).toISOString().slice(0, 10));
  }
  return list;
}

/** A counter row as read back for a report (processor and install week already summed away). */
export interface CounterRow {
  day: string;
  v: string;
  pkg: string;
  os: string;
  d: number | boolean;
  w: number | boolean;
  m: number | boolean;
  first: number | boolean;
  n: number;
}

export interface DayCount {
  day: string;
  daily: number;
  weekly: number;
  monthly: number;
  new: number;
}

export interface NameCount {
  name: string;
  count: number;
}

export interface Report {
  days: DayCount[];
  byVersion: NameCount[];
  byPackage: NameCount[];
  bySystem: NameCount[];
}

/**
 * Largest first; every group below MIN_GROUP is added to a single "other"
 * entry so a small group cannot be singled out.
 */
export function foldSmall(counts: Map<string, number>, min = MIN_GROUP): NameCount[] {
  const kept = new Map<string, number>();
  let other = 0;
  let folded = false;
  for (const [name, count] of counts) {
    if (count <= 0) continue;
    if (name === "other" || count < min) {
      other += count;
      folded = true;
    } else {
      kept.set(name, count);
    }
  }
  if (folded) kept.set("other", other);
  return [...kept]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Build the /api/daily answer from the counter rows of the period. Rows outside it are ignored. */
export function aggregate(rows: CounterRow[], today: string, days: number): Report {
  const byDay = new Map<string, DayCount>();
  for (const day of period(today, days)) {
    byDay.set(day, { day, daily: 0, weekly: 0, monthly: 0, new: 0 });
  }
  const versions = new Map<string, number>();
  const packages = new Map<string, number>();
  const systems = new Map<string, number>();
  const add = (map: Map<string, number>, name: string, n: number) => map.set(name, (map.get(name) ?? 0) + n);

  for (const row of rows) {
    const entry = byDay.get(row.day);
    if (!entry) continue;
    if (row.d) {
      entry.daily += row.n;
      add(versions, row.v, row.n);
      add(packages, row.pkg, row.n);
      add(systems, row.os, row.n);
    }
    if (row.w) entry.weekly += row.n;
    if (row.m) entry.monthly += row.n;
    if (row.first) entry.new += row.n;
  }
  return {
    days: [...byDay.values()],
    byVersion: foldSmall(versions),
    byPackage: foldSmall(packages),
    bySystem: foldSmall(systems),
  };
}

/** The origin to allow for a cross-site GET, or null. */
export function allowedOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  if (origin === "https://openwren.app" || origin === "https://www.openwren.app") return origin;
  return /^http:\/\/localhost(:\d{1,5})?$/.test(origin) ? origin : null;
}

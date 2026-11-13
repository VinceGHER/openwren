import { describe, expect, it } from "vitest";
import { aggregate, allowedOrigin, foldSmall, parseDays, parsePing, period, utcDay, type CounterRow } from "../src/counting";

const good = { v: "0.1.0", pkg: "deb", os: "ubuntu-24.04", arch: "x86_64", d: true, w: true, m: false, first: false, iw: "2026-W46" };
const parse = (change: Record<string, unknown> = {}) => parsePing(JSON.stringify({ ...good, ...change }));

describe("parsePing", () => {
  it("accepts a valid request unchanged", () => {
    expect(parse()).toEqual(good);
  });

  it("ignores unknown extra fields", () => {
    expect(parse({ id: "abc", day: "1999-01-01" })).toEqual(good);
  });

  it("rejects what is not a JSON object", () => {
    for (const body of ["", "not json", "{", "null", "[]", "3", '"text"']) expect(parsePing(body)).toBeNull();
  });

  it.each(Object.keys(good))("rejects a missing %s", (field) => {
    expect(parse({ [field]: undefined })).toBeNull();
  });

  it.each(["v", "pkg", "os", "arch", "iw"])("rejects a %s that is not text", (field) => {
    for (const wrong of [1, true, null, ["x"], {}]) expect(parse({ [field]: wrong })).toBeNull();
  });

  it.each(["d", "w", "m", "first"])("rejects a %s that is not true or false", (field) => {
    for (const wrong of [1, 0, "true", null]) expect(parse({ [field]: wrong })).toBeNull();
  });

  it("checks the version format", () => {
    expect(parse({ v: "12.345.6" })?.v).toBe("12.345.6");
    for (const v of ["0.1", "0.1.0.1", "v0.1.0", "0.1.0-beta", "1234.0.0", "0.1.0\n", ""]) expect(parse({ v })).toBeNull();
  });

  it("checks the install week format", () => {
    for (const iw of ["2026-46", "2026-W4", "26-W46", "2026-W461", "2026-w46", ""]) expect(parse({ iw })).toBeNull();
  });

  it("keeps known packages and stores anything else as other", () => {
    for (const pkg of ["deb", "rpm", "appimage", "flatpak", "other"]) expect(parse({ pkg })?.pkg).toBe(pkg);
    for (const pkg of ["snap", "DEB", "", "deb "]) expect(parse({ pkg })?.pkg).toBe("other");
  });

  it("keeps known systems and stores anything else as other", () => {
    for (const os of ["ubuntu-24.04", "fedora-41", "arch", "opensuse-tumbleweed", "opensuse-leap-15.6", "debian-12", "rhel-9.4"]) {
      expect(parse({ os })?.os).toBe(os);
    }
    for (const os of ["Ubuntu-24.04", "gentoo", "ubuntu-", "ubuntu-24.04-lts", "ubuntu-123456789", "ubuntu-24a", "my-own-distro-1", "ubuntu 24.04", ""]) {
      expect(parse({ os })?.os).toBe("other");
    }
  });

  it("keeps known processors and stores anything else as other", () => {
    expect(parse({ arch: "aarch64" })?.arch).toBe("aarch64");
    expect(parse({ arch: "riscv64" })?.arch).toBe("other");
  });

  it("rejects a body larger than 1 KB", () => {
    expect(parse({ pad: "x".repeat(1024) })).toBeNull();
    const body = JSON.stringify(good);
    expect(parsePing(body + " ".repeat(1024 - body.length))).toEqual(good);
    expect(parsePing(body + " ".repeat(1025 - body.length))).toBeNull();
  });
});

describe("days", () => {
  it("defaults to 90, caps at 365, rejects nonsense", () => {
    expect(parseDays(null)).toBe(90);
    expect(parseDays("1")).toBe(1);
    expect(parseDays("365")).toBe(365);
    expect(parseDays("366")).toBe(365);
    expect(parseDays("99999")).toBe(365);
    for (const bad of ["0", "-3", "1.5", "abc", "", "1e2", "9999999"]) expect(parseDays(bad)).toBeNull();
  });

  it("takes the day from a moment in UTC", () => {
    expect(utcDay(new Date("2026-11-13T23:59:59Z"))).toBe("2026-11-13");
    expect(utcDay(new Date("2026-11-14T00:30:00+02:00"))).toBe("2026-11-13");
  });

  it("lists a period oldest first, across months and years", () => {
    expect(period("2027-01-01", 3)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
    expect(period("2026-11-13", 365)).toHaveLength(365);
    expect(period("2026-11-13", 365)[0]).toBe("2025-11-14");
  });
});

const row = (day: string, n: number, change: Partial<CounterRow> = {}): CounterRow => ({
  day, v: "0.1.0", pkg: "deb", os: "ubuntu-24.04", d: 1, w: 0, m: 0, first: 0, n, ...change,
});

describe("aggregate", () => {
  it("counts each flag per day and fills empty days with zeros", () => {
    const report = aggregate(
      [
        row("2026-11-10", 7, { w: 1, m: 1, first: 1 }),
        row("2026-11-10", 5),
        row("2026-11-12", 4, { w: 1 }),
        row("2026-11-12", 2, { d: 0, m: 1 }), // not a first-of-day request: not a daily user
        row("2026-11-13", 6, { v: "0.2.0", pkg: "rpm", os: "fedora-41" }),
        row("2026-11-01", 50), // before the period
        row("2026-11-14", 50), // after it
      ],
      "2026-11-13",
      5,
    );
    expect(report.days).toEqual([
      { day: "2026-11-09", daily: 0, weekly: 0, monthly: 0, new: 0 },
      { day: "2026-11-10", daily: 12, weekly: 7, monthly: 7, new: 7 },
      { day: "2026-11-11", daily: 0, weekly: 0, monthly: 0, new: 0 },
      { day: "2026-11-12", daily: 4, weekly: 4, monthly: 2, new: 0 },
      { day: "2026-11-13", daily: 6, weekly: 0, monthly: 0, new: 0 },
    ]);
    expect(report.byVersion).toEqual([{ name: "0.1.0", count: 16 }, { name: "0.2.0", count: 6 }]);
    expect(report.byPackage).toEqual([{ name: "deb", count: 16 }, { name: "rpm", count: 6 }]);
    expect(report.bySystem).toEqual([{ name: "ubuntu-24.04", count: 16 }, { name: "fedora-41", count: 6 }]);
  });

  it("gives only zero days and empty breakdowns when there is nothing", () => {
    const report = aggregate([], "2026-11-13", 2);
    expect(report).toEqual({
      days: [
        { day: "2026-11-12", daily: 0, weekly: 0, monthly: 0, new: 0 },
        { day: "2026-11-13", daily: 0, weekly: 0, monthly: 0, new: 0 },
      ],
      byVersion: [], byPackage: [], bySystem: [],
    });
  });

  it("folds groups smaller than 5 into one other entry, over the whole period", () => {
    const report = aggregate(
      [
        row("2026-11-12", 20),
        row("2026-11-12", 3, { os: "fedora-41" }),
        row("2026-11-13", 2, { os: "fedora-41" }), // 3 + 2 = 5 over the period: kept
        row("2026-11-13", 4, { os: "arch" }),
        row("2026-11-13", 1, { os: "kali" }),
        row("2026-11-13", 2, { os: "other" }),
      ],
      "2026-11-13",
      2,
    );
    expect(report.bySystem).toEqual([
      { name: "ubuntu-24.04", count: 20 },
      { name: "other", count: 7 },
      { name: "fedora-41", count: 5 },
    ]);
  });
});

describe("foldSmall", () => {
  it("adds no other entry when nothing is small", () => {
    expect(foldSmall(new Map([["a", 5], ["b", 9]]))).toEqual([{ name: "b", count: 9 }, { name: "a", count: 5 }]);
  });
  it("folds everything when everything is small", () => {
    expect(foldSmall(new Map([["a", 4], ["b", 1]]))).toEqual([{ name: "other", count: 5 }]);
  });
});

describe("allowedOrigin", () => {
  it("allows the website and localhost on any port only", () => {
    for (const ok of ["https://openwren.app", "http://localhost:4321", "http://localhost"]) expect(allowedOrigin(ok)).toBe(ok);
    for (const no of [null, "http://openwren.app", "https://evil.example", "https://localhost:3000", "http://localhost.evil.example", "http://localhost:3000.evil.example", "https://openwren.app.evil.example"]) {
      expect(allowedOrigin(no)).toBeNull();
    }
  });
});

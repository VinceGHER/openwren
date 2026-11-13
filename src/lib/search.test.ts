import { describe, expect, it } from "vitest";
import type { MessageDetail, SearchFilters } from "../types";
import { fileSize, highlight, searchMessages } from "./search";
import { daysAgo, groupLabel, shortTime, useTwelveHourClock } from "./dates";
import { guessHost } from "../features/AddAccount";
import { completeWith, lastToken } from "../features/Composer";
import { snoozeTimes } from "../features/actions";

const now = new Date(2026, 10, 12, 12, 0);
const none: SearchFilters = { accountId: null, hasAttachment: false, date: "any", after: null, before: null };

let nextId = 0;
function msg(tag: string, date: Date, over: Partial<MessageDetail> = {}): MessageDetail & { tag: string } {
  nextId += 1;
  return {
    tag,
    id: nextId,
    accountId: 1,
    folderId: 1,
    folderName: "Inbox",
    accountAddress: "katy@work.com",
    fromName: "Nordic Print",
    fromAddress: "billing@nordicprint.example",
    to: "you",
    cc: "",
    subject: `Invoice ${tag}`,
    preview: "",
    html: null,
    plain: "Attached is your invoice.",
    date: date.getTime() / 1000,
    unread: false,
    pinned: false,
    flagged: false,
    focused: true,
    hasAttachment: false,
    attachments: [],
    categories: [],
    snoozedUntil: null,
    auth: null,
    unsubscribe: null,
    unsubscribeTo: null,
    messageIdHeader: null,
    references: null,
    toAddresses: "",
    ccAddresses: "",
    ...over,
  };
}

const all = [
  msg("recent", new Date(2026, 8, 1)),
  msg("y1", new Date(2025, 8, 14), { hasAttachment: true }),
  msg("y3", new Date(2023, 10, 2), { accountId: 2 }),
  msg("other", new Date(2024, 1, 1), { subject: "Lunch", plain: "Pizza?" }),
];

describe("searchMessages", () => {
  it("returns nothing for an empty query", () => {
    expect(searchMessages(all, "  ", none, now)).toEqual([]);
  });

  it("matches subject and body, newest first", () => {
    expect(searchMessages(all, "invoice", none, now).map((m) => m.tag)).toEqual(["recent", "y1", "y3"]);
  });

  it("requires every word", () => {
    expect(searchMessages(all, "invoice y1", none, now).map((m) => m.tag)).toEqual(["y1"]);
  });

  it("finds mail older than one and two years", () => {
    const ids = (date: SearchFilters["date"]) =>
      searchMessages(all, "invoice", { ...none, date }, now).map((m) => m.tag);
    expect(ids("past-year")).toEqual(["recent"]);
    expect(ids("older-1y")).toEqual(["y1", "y3"]);
    expect(ids("older-2y")).toEqual(["y3"]);
  });

  it("filters by account and attachment", () => {
    expect(searchMessages(all, "invoice", { ...none, accountId: 2 }, now).map((m) => m.tag)).toEqual(["y3"]);
    expect(searchMessages(all, "invoice", { ...none, hasAttachment: true }, now).map((m) => m.tag)).toEqual(["y1"]);
  });
});

describe("highlight", () => {
  it("marks matches case-insensitively", () => {
    expect(highlight("Your yearly Invoice", "invoice")).toEqual([
      { text: "Your yearly ", hit: false },
      { text: "Invoice", hit: true },
    ]);
  });

  it("treats regex characters literally", () => {
    expect(highlight("a (b) c", "(b)")).toEqual([
      { text: "a ", hit: false },
      { text: "(b)", hit: true },
      { text: " c", hit: false },
    ]);
  });
});

describe("guessHost", () => {
  it("suggests imap.<domain>", () => {
    expect(guessHost(" Katy@Work.com ")).toBe("imap.work.com");
    expect(guessHost("katy")).toBe("");
    expect(guessHost("katy@work.com", "smtp")).toBe("smtp.work.com");
  });
});

describe("composer recipients", () => {
  it("finds the recipient being typed", () => {
    expect(lastToken("Ann <a@x.org>, bo")).toBe("bo");
    expect(lastToken("")).toBe("");
  });

  it("completes it with the chosen contact, keeping earlier ones", () => {
    expect(completeWith("Ann <a@x.org>, bo", { name: "Bob, Jr", address: "bob@y.org" })).toBe("Ann <a@x.org>, Bob  Jr <bob@y.org>, ");
    expect(completeWith("bo", { name: "", address: "bob@y.org" })).toBe("bob@y.org, ");
  });
});

describe("snooze choices", () => {
  it("offers later today, tomorrow morning and Monday morning", () => {
    const friday = new Date(2026, 10, 13, 15, 0);
    const times = snoozeTimes(friday).map((t) => new Date(t.at * 1000));
    expect(times[0].getHours()).toBe(18);
    expect([times[1].getDate(), times[1].getHours()]).toEqual([14, 8]);
    expect([times[2].getDay(), times[2].getDate()]).toEqual([1, 16]);
  });
});

describe("fileSize", () => {
  it("picks a readable unit", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(217_000)).toBe("212 KB");
    expect(fileSize(18_900_000)).toBe("18.0 MB");
  });
});

describe("dates", () => {
  it("counts calendar days, not 24-hour periods", () => {
    expect(daysAgo(new Date(2026, 10, 11, 23, 59), now)).toBe(1);
  });

  it("labels groups", () => {
    expect(groupLabel(new Date(2026, 10, 12, 8, 0), now)).toBe("Today");
    expect(groupLabel(new Date(2026, 10, 11, 8, 0), now)).toBe("Yesterday");
    expect(groupLabel(new Date(2026, 10, 8), now)).toBe("This week");
    expect(groupLabel(new Date(2026, 5, 1), now)).toBe("June");
    expect(groupLabel(new Date(2024, 5, 1), now)).toBe("2024");
  });

  it("formats row times", () => {
    expect(shortTime(new Date(2026, 10, 12, 8, 5), now)).toBe("8:05");
    expect(shortTime(new Date(2025, 8, 14), now)).toBe("14 Sep 2025");
    useTwelveHourClock(true);
    expect(shortTime(new Date(2026, 10, 12, 8, 5), now)).toBe("8:05 AM");
    expect(shortTime(new Date(2026, 10, 12, 0, 30), now)).toBe("12:30 AM");
    expect(shortTime(new Date(2026, 10, 12, 12, 0), now)).toBe("12:00 PM");
    expect(shortTime(new Date(2026, 10, 11, 15, 55), now)).toBe("Wed 3:55 PM");
    useTwelveHourClock(false);
  });
});

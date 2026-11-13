import type { DateFilter, MessageDetail, SearchFilters } from "../types";
import { yearsBefore } from "./dates";

function matchesDate(date: Date, filter: DateFilter, now: Date): boolean {
  switch (filter) {
    case "any":
      return true;
    case "past-year":
      return date >= yearsBefore(now, 1);
    case "older-1y":
      return date < yearsBefore(now, 1);
    case "older-2y":
      return date < yearsBefore(now, 2);
    case "custom":
      return true; // handled by the caller, which knows the range
  }
}

/** Lower-cased search words; all of them must match. */
export function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Search for the sample backend. The desktop app uses the SQLite full-text
 * index instead (src-tauri/src/db.rs), with the same filters and order.
 */
export function searchMessages<T extends MessageDetail>(messages: T[], query: string, filters: SearchFilters, now: Date): T[] {
  const words = terms(query);
  if (words.length === 0) return [];
  return messages
    .filter((m) => {
      if (filters.accountId !== null && m.accountId !== filters.accountId) return false;
      if (filters.hasAttachment && !m.hasAttachment) return false;
      if (!matchesDate(new Date(m.date * 1000), filters.date, now)) return false;
      if (filters.date === "custom" && ((filters.after !== null && m.date < filters.after) || (filters.before !== null && m.date >= filters.before))) return false;
      const hay = [m.fromName, m.fromAddress, m.to, m.subject, m.plain].join("\n").toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => b.date - a.date);
}

export interface TextPart {
  text: string;
  hit: boolean;
}

/** Split `text` into plain and matching parts so matches can be highlighted. */
export function highlight(text: string, query: string): TextPart[] {
  const words = terms(query);
  if (words.length === 0) return [{ text, hit: false }];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return text
    .split(re)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, hit: words.some((w) => part.toLowerCase() === w) }));
}

/** "212 KB" */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

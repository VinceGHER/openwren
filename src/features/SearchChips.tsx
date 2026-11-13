import { IconCalendar, IconPaperclip } from "@tabler/icons-react";
import { Chip, Divider } from "../components/ui";
import { useStore } from "../store";
import type { DateFilter } from "../types";

const dates: [DateFilter, string][] = [
  ["any", "Any time"],
  ["past-year", "Past year"],
  ["older-1y", "Older than 1 year"],
  ["older-2y", "Older than 2 years"],
];

const dateBox = "h-7 rounded-full border border-edge bg-card px-2 text-ink";

/** Unix seconds for the start of a yyyy-mm-dd day (local time), plus `addDays`; null when empty. */
function toSeconds(day: string, addDays: number): number | null {
  if (!day) return null;
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + addDays);
  return Math.floor(d.getTime() / 1000);
}

/** Filter row shown under the header while a search is active. */
export function SearchChips() {
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const accounts = useStore((s) => s.accounts);
  return (
    <div className="mt-2 flex flex-none flex-wrap items-center gap-1.5" role="toolbar" aria-label="Search filters">
      <Chip on={filters.accountId === null} onClick={() => setFilters({ accountId: null })}>
        All accounts
      </Chip>
      {accounts.map((a) => (
        <Chip key={a.id} on={filters.accountId === a.id} onClick={() => setFilters({ accountId: a.id })}>
          {a.address}
        </Chip>
      ))}
      <Divider />
      <Chip on={filters.hasAttachment} onClick={() => setFilters({ hasAttachment: !filters.hasAttachment })}>
        <IconPaperclip size={15} />
        Has attachment
      </Chip>
      <Divider />
      {dates.map(([value, label]) => (
        <Chip key={value} on={filters.date === value} onClick={() => setFilters({ date: value })}>
          {label}
        </Chip>
      ))}
      <Chip on={filters.date === "custom"} onClick={() => setFilters({ date: "custom" })}>
        <IconCalendar size={15} />
        Custom range
      </Chip>
      {filters.date === "custom" && (
        <span className="flex items-center gap-1.5 text-[13px] text-ink2">
          <input type="date" aria-label="From date" className={dateBox} onChange={(e) => setFilters({ after: toSeconds(e.target.value, 0) })} />
          to
          <input type="date" aria-label="To date" className={dateBox} onChange={(e) => setFilters({ before: toSeconds(e.target.value, 1) })} />
        </span>
      )}
    </div>
  );
}

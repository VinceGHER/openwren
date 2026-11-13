const DAY = 24 * 60 * 60 * 1000;

// Own name tables: Intl output differs between runtimes ("Sep" vs "Sept").
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "14 Sep 2025" */
function dayMonthYear(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days between `date` and `now` (0 = today, 1 = yesterday). */
export function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY);
}

/** Section heading for the message list. */
export function groupLabel(date: Date, now: Date): string {
  const d = daysAgo(date, now);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7) return "This week";
  if (date.getFullYear() === now.getFullYear()) {
    return MONTHS[date.getMonth()];
  }
  return String(date.getFullYear());
}

const pad = (n: number) => String(n).padStart(2, "0");

let twelveHour = false;

/** Show times as "3:05 PM" (true) or "15:05" (false). Set from the "Time format" setting. */
export function useTwelveHourClock(on: boolean) {
  twelveHour = on;
}

/** The time of day: "15:05", or "3:05 PM" with the 12-hour clock. */
export function clock(date: Date): string {
  const minutes = pad(date.getMinutes());
  if (!twelveHour) return `${date.getHours()}:${minutes}`;
  return `${date.getHours() % 12 || 12}:${minutes} ${date.getHours() < 12 ? "AM" : "PM"}`;
}

/** Short time for a list row: "11:58", "Wed 15:55" or "14 Sep 2025". */
export function shortTime(date: Date, now: Date): string {
  const d = daysAgo(date, now);
  const hm = clock(date);
  if (d <= 0) return hm;
  if (d < 7) return `${WEEKDAYS[date.getDay()]} ${hm}`;
  return dayMonthYear(date);
}

/** Full time for the reading pane. */
export function longTime(date: Date, now: Date): string {
  const d = daysAgo(date, now);
  const hm = clock(date);
  if (d <= 0) return `Today ${hm}`;
  if (d === 1) return `Yesterday ${hm}`;
  return `${dayMonthYear(date)}, ${hm}`;
}

/** Date that lies `years` calendar years before `now`. */
export function yearsBefore(now: Date, years: number): Date {
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - years);
  return d;
}

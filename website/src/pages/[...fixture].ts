// Sample data for the Stats page, so it can be checked without the Worker.
//
// These files are only generated when the site is built (or run in dev) with
// PUBLIC_STATS_URL set to /fixture or /fixture-empty. A normal build contains none of them.
//
//   /fixture/api/daily        sample data from src/fixtures/daily.json, re-dated to end today
//   /fixture-empty/api/daily  a valid response with no data
import type { APIRoute } from 'astro';
import sample from '../fixtures/daily.json';

const DAY_MS = 86_400_000;

export function getStaticPaths() {
  const statsUrl = import.meta.env.PUBLIC_STATS_URL ?? '';
  if (!statsUrl.startsWith('/fixture')) return [];
  return [{ params: { fixture: 'fixture/api/daily' } }, { params: { fixture: 'fixture-empty/api/daily' } }];
}

export const GET: APIRoute = ({ params }) => {
  let body: unknown;
  if (params.fixture === 'fixture-empty/api/daily') {
    body = { days: [], byVersion: [], byPackage: [], bySystem: [] };
  } else {
    // Shift the fixture's dates so its last day is today (UTC). That keeps
    // "this week" and "this month" meaningful whenever the fixture is viewed.
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const last = Date.parse(sample.days[sample.days.length - 1].day);
    const shift = today - last;
    body = {
      ...sample,
      days: sample.days.map((d) => ({ ...d, day: new Date(Date.parse(d.day) + shift).toISOString().slice(0, 10) })),
    };
  }
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};

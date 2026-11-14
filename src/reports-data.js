// Numbers for the owners' Reports page. Pure functions over the same records
// the staff app keeps, so reports always agree with the nightly totals.
//
// A "night" is the 6am-to-6am business day used everywhere else.

import { businessDateOf } from "./billing/pricing.js";
import { sessionCharge, playedIntervals } from "./model.js";
import { floorOf } from "./halls.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const pad = (n) => String(n).padStart(2, "0");
export const nightKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function emptyNight(date) {
  return {
    date, key: nightKey(date), weekday: date.getDay(),
    collected: 0, full: 0, couponCents: 0, coupons: 0, voids: 0, games: 0, ms: 0,
    byFloor: { downstairs: 0, upstairs: 0 },
    seated: 0, left: 0, waitMs: 0, longestMs: 0,
    tableMsByHour: new Array(24).fill(0), // table-time played in each clock hour
  };
}

/** One summary per night that had any games or waitlist activity, oldest first. */
export function nightSummaries(state, now) {
  const nights = new Map();
  const nightOf = (t) => {
    const bd = businessDateOf(t);
    const k = bd.getTime();
    if (!nights.has(k)) nights.set(k, emptyNight(bd));
    return nights.get(k);
  };
  for (const s of state.sessions) {
    const n = nightOf(s.start);
    if (s.voidedAt) { n.voids++; continue; }
    if (s.end == null) continue; // still running: counted once it closes
    const c = sessionCharge(s, now);
    n.games++;
    n.ms += c.price.ms;
    n.full += c.fullCents;
    n.couponCents += c.discountCents;
    if (s.discount) n.coupons++;
    n.collected += c.chargedCents;
    n.byFloor[floorOf(state, s.tableId)] += c.chargedCents;
    for (const [from, to] of playedIntervals(s, s.end)) spreadByHour(n.tableMsByHour, from, to);
  }
  for (const w of state.waitHistory ?? []) {
    const n = nightOf(w.addedAt);
    if (w.outcome === "seated") {
      const ms = w.endedAt - w.addedAt;
      n.seated++;
      n.waitMs += ms;
      n.longestMs = Math.max(n.longestMs, ms);
    } else n.left++;
  }
  return [...nights.values()].sort((a, b) => a.date - b.date);
}

function spreadByHour(buckets, from, to) {
  let t = from;
  while (t < to) {
    const d = new Date(t);
    const hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    const end = Math.min(hourEnd, to);
    buckets[d.getHours()] += end - t;
    t = end;
  }
}

// ---------- Periods ----------

export const PERIODS = [
  { id: "7", label: "Last 7 nights" },
  { id: "30", label: "Last 30 nights" },
  { id: "month", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "year", label: "This year" },
  { id: "all", label: "All time" },
];

/**
 * The nights a period covers, as [from, to) business dates, plus the period
 * before it for comparison (none for "all").
 */
export function periodRange(id, now) {
  const today = businessDateOf(now);
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const tomorrow = addDays(today, 1);
  switch (id) {
    case "7":
    case "30": {
      const n = Number(id);
      const from = addDays(tomorrow, -n);
      return { from, to: tomorrow, prev: { from: addDays(from, -n), to: from } };
    }
    case "month": {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      const days = Math.round((tomorrow - from) / DAY);
      const prevFrom = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return { from, to: tomorrow, prev: { from: prevFrom, to: addDays(prevFrom, days) } }; // same days last month
    }
    case "lastmonth": {
      const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const to = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from, to, prev: { from: new Date(today.getFullYear(), today.getMonth() - 2, 1), to: from } };
    }
    case "year": {
      const from = new Date(today.getFullYear(), 0, 1);
      const days = Math.round((tomorrow - from) / DAY);
      const prevFrom = new Date(today.getFullYear() - 1, 0, 1);
      return { from, to: tomorrow, prev: { from: prevFrom, to: addDays(prevFrom, days) } }; // same days last year
    }
    default:
      return { from: new Date(2000, 0, 1), to: tomorrow, prev: null };
  }
}

export const inRange = (nights, r) => (r ? nights.filter((n) => n.date >= r.from && n.date < r.to) : []);

/** Headline figures for a set of nights. */
export function totals(nights) {
  const t = {
    nights: nights.filter((n) => n.games).length,
    collected: 0, full: 0, couponCents: 0, coupons: 0, voids: 0, games: 0, ms: 0,
    upstairs: 0, downstairs: 0, seated: 0, left: 0, waitMs: 0, longestMs: 0,
  };
  for (const n of nights) {
    for (const k of ["collected", "full", "couponCents", "coupons", "voids", "games", "ms", "seated", "left", "waitMs"]) t[k] += n[k];
    t.upstairs += n.byFloor.upstairs;
    t.downstairs += n.byFloor.downstairs;
    t.longestMs = Math.max(t.longestMs, n.longestMs);
  }
  t.perGame = t.games ? t.collected / t.games : 0;
  t.perNight = t.nights ? t.collected / t.nights : 0;
  t.avgWaitMs = t.seated ? t.waitMs / t.seated : 0;
  t.upstairsShare = t.collected ? t.upstairs / t.collected : 0;
  return t;
}

/** % change from `before` to `now`; null when there's nothing to compare. */
export const change = (now, before) => (before ? (now - before) / before : null);

/** Average collected per night of the week (only nights that had games). */
export function byWeekday(nights) {
  const sum = new Array(7).fill(0);
  const count = new Array(7).fill(0);
  for (const n of nights) {
    if (!n.games) continue;
    sum[n.weekday] += n.collected;
    count[n.weekday]++;
  }
  return sum.map((s, i) => ({ weekday: i, avg: count[i] ? s / count[i] : 0, nights: count[i] }));
}

/**
 * Average number of tables in use in each clock hour, over nights with games.
 * Ordered through the business day (6am first, through to 5am).
 */
export function busyHours(nights) {
  const played = nights.filter((n) => n.games);
  const order = Array.from({ length: 24 }, (_, i) => (i + 6) % 24);
  return order.map((h) => ({
    hour: h,
    tables: played.length ? played.reduce((a, n) => a + n.tableMsByHour[h], 0) / HOUR / played.length : 0,
  }));
}

/**
 * Collected per bar for the revenue chart: one bar per night for short
 * periods, per week past ~2 months, per month past ~6 months.
 */
export function revenueBars(nights, r) {
  const span = Math.round((r.to - r.from) / DAY);
  const unit = span > 190 ? "month" : span > 62 ? "week" : "night";
  if (unit === "night") {
    return { unit, bars: nights.filter((n) => n.games || n.collected).map((n) => ({
      label: n.date, downstairs: n.byFloor.downstairs, upstairs: n.byFloor.upstairs, nights: [n],
    })) };
  }
  const groups = new Map();
  for (const n of nights) {
    let start;
    if (unit === "week") {
      const back = (n.date.getDay() + 6) % 7; // weeks start Monday
      start = new Date(n.date.getFullYear(), n.date.getMonth(), n.date.getDate() - back);
    } else start = new Date(n.date.getFullYear(), n.date.getMonth(), 1);
    const k = start.getTime();
    if (!groups.has(k)) groups.set(k, { label: start, downstairs: 0, upstairs: 0, nights: [] });
    const g = groups.get(k);
    g.downstairs += n.byFloor.downstairs;
    g.upstairs += n.byFloor.upstairs;
    g.nights.push(n);
  }
  return { unit, bars: [...groups.values()].sort((a, b) => a.label - b.label) };
}

// ---------- Sample data (for showing the page before real nights exist) ----------

/**
 * A believable 120 nights of games and waits. Only used by reports/?demo,
 * which says SAMPLE DATA across the top.
 */
export function sampleState(now, tables) {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const sessions = [];
  const waitHistory = [];
  const today = businessDateOf(now);
  const down = tables.filter((t) => t.floor === "downstairs");
  const up = tables.filter((t) => t.floor === "upstairs");
  let id = 0;
  for (let back = 120; back >= 1; back--) {
    const night = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const wd = night.getDay();
    const weekend = wd === 5 || wd === 6;
    const upstairsOpen = weekend && rand() < 0.45;
    const games = Math.round((weekend ? 70 : wd === 4 ? 45 : 30) * (0.8 + rand() * 0.4));
    const pool = upstairsOpen ? [...down, ...up] : down;
    const free = new Map(pool.map((t) => [t.id, 0]));
    for (let g = 0; g < games; g++) {
      // Most games between 6pm and 1am, some in the afternoon.
      const startHour = rand() < 0.25 ? 13 + rand() * 5 : 18 + rand() * 7;
      let start = night.getTime() + startHour * HOUR;
      const table = pool.find((t) => free.get(t.id) <= start) ?? pool[Math.floor(rand() * pool.length)];
      start = Math.max(start, free.get(table.id));
      const length = (25 + rand() * 75) * 60_000;
      const end = start + length;
      if (end > night.getTime() + 26.5 * HOUR) continue; // past the 2am close (night is midnight-based)
      free.set(table.id, end + 5 * 60_000);
      const s = { id: `demo${id++}`, tableId: table.id, name: "", start, end, log: [] };
      if (rand() < 0.06) s.discount = { minutes: 30, label: "Half-hour coupon", at: end };
      if (rand() < 0.02) s.voidedAt = start + 60_000;
      sessions.push(s);
    }
    const waits = weekend ? Math.round(8 + rand() * 14) : Math.round(rand() * 5);
    for (let w = 0; w < waits; w++) {
      const addedAt = night.getTime() + (19 + rand() * 4) * HOUR;
      const leftEarly = rand() < 0.15;
      waitHistory.push({
        id: `dw${id++}`, name: "", addedAt,
        endedAt: addedAt + (leftEarly ? 5 + rand() * 15 : 5 + rand() * (weekend ? 40 : 15)) * 60_000,
        outcome: leftEarly ? "left" : "seated",
      });
    }
  }
  return { sessions, waitHistory };
}

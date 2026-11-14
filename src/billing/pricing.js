// Pricing engine: turns a start and end time into a charge.
//
// Rules:
//  - Charged on exact elapsed time (to the millisecond), no minimum.
//    1 minute on a Friday night = 1/60 x $25 = $0.42.
//  - A session that crosses a rate change is split at the change and each
//    piece is charged at its own rate.
//  - Rounding to the cent happens ONCE, on the total. Segment amounts are
//    rounded cumulatively so they always add up exactly to the total shown.
//  - All clock times are the device's local time zone (the hall's time).
//    Elapsed time is real time, so daylight-saving changes can't add or
//    remove an hour from a bill.

import { DEFAULT_SCHEDULE } from "./rates.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Bad time "${s}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Bad time "${s}"`);
  return h * 60 + min;
}

/** Local midnight of the calendar date that `t`'s business day belongs to. */
export function businessDateOf(t, schedule = DEFAULT_SCHEDULE) {
  const startMin = parseHHMM(schedule.businessDayStartsAt);
  const d = new Date(t);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (minuteOfDay < startMin) date.setDate(date.getDate() - 1);
  return date;
}

/** The rate windows of one business day, as absolute times. */
function windowsFor(businessDate, schedule) {
  const startMin = parseHHMM(schedule.businessDayStartsAt);
  const defs = schedule.days[businessDate.getDay()];
  if (!defs || defs.length === 0) {
    throw new Error(`No rates set for weekday ${businessDate.getDay()}`);
  }
  const at = (minuteOfDay) => {
    // Times before the business-day start are after midnight: next calendar day.
    const dayOffset = minuteOfDay < startMin ? 1 : 0;
    return new Date(
      businessDate.getFullYear(),
      businessDate.getMonth(),
      businessDate.getDate() + dayOffset,
      Math.floor(minuteOfDay / 60),
      minuteOfDay % 60,
    );
  };
  const starts = defs.map((w) => at(parseHHMM(w.from)));
  if (starts[0].getTime() !== at(startMin).getTime()) {
    throw new Error("Each day's first rate must start when the business day starts");
  }
  const dayEnd = at(startMin);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return defs.map((w, i) => {
    const end = i + 1 < defs.length ? starts[i + 1] : dayEnd;
    if (end <= starts[i]) throw new Error("Rate windows must be in time order");
    return { start: starts[i], end, centsPerHour: w.centsPerHour };
  });
}

/** The rate window in effect at time `t` (for showing "now: $25/hr"). */
export function rateAt(t, schedule = DEFAULT_SCHEDULE) {
  const time = new Date(t).getTime();
  const windows = windowsFor(businessDateOf(time, schedule), schedule);
  const w = windows.find((w) => time >= w.start.getTime() && time < w.end.getTime());
  if (!w) throw new Error("No rate window covers this time");
  return w;
}

/**
 * Price a session.
 * @param {Date|number} start
 * @param {Date|number} end
 * @returns {{ totalCents: number, ms: number, segments: Array<{start: Date, end: Date, centsPerHour: number, ms: number, cents: number}> }}
 */
export function priceSession(start, end, schedule = DEFAULT_SCHEDULE) {
  return priceIntervals([[start, end]], schedule);
}

/**
 * Price several stretches of play as one bill (a game with pauses in it).
 * Paused time between the stretches isn't charged. Rounded once, on the total.
 * @param {Array<[Date|number, Date|number]>} intervals  in time order
 */
export function priceIntervals(intervals, schedule = DEFAULT_SCHEDULE) {
  // 1. Split each stretch at every rate change, merging touching pieces with the same rate.
  const raw = [];
  let total = 0;
  for (const [start, end] of intervals) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error("Invalid start or end time");
    if (e < s) throw new Error("End time is before start time");
    total += e - s;
    if (total > 7 * MS_PER_DAY) throw new Error("Session longer than 7 days; check the times");
    let t = s;
    while (t < e) {
      const w = rateAt(t, schedule);
      const segEnd = Math.min(w.end.getTime(), e);
      const last = raw[raw.length - 1];
      if (last && last.centsPerHour === w.centsPerHour && last.end === t) {
        last.end = segEnd;
      } else {
        raw.push({ start: t, end: segEnd, centsPerHour: w.centsPerHour });
      }
      t = segEnd;
    }
  }

  // 2. Exact charge in "cent-milliseconds per hour" (integers, no float drift),
  //    rounded to cents cumulatively so segment amounts sum to the total.
  let exact = 0;
  let roundedSoFar = 0;
  const segments = raw.map((seg) => {
    const ms = seg.end - seg.start;
    exact += ms * seg.centsPerHour;
    const roundedTotal = Math.round(exact / MS_PER_HOUR);
    const cents = roundedTotal - roundedSoFar;
    roundedSoFar = roundedTotal;
    return { start: new Date(seg.start), end: new Date(seg.end), centsPerHour: seg.centsPerHour, ms, cents };
  });

  return { totalCents: roundedSoFar, ms: total, segments };
}

export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

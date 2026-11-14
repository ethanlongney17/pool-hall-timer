// Tests for the owners' Reports numbers. Nov 13 2026 is a Friday.

import * as M from "../src/model.js";
import { ALL_TABLES } from "../src/halls.js";
import { businessDateOf } from "../src/billing/pricing.js";
import {
  nightSummaries, periodRange, inRange, totals, change, byWeekday, busyHours, revenueBars, sampleState,
} from "../src/reports-data.js";

const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
const MINUTE = 60_000;
export const tests = [];
const test = (name, fn) => tests.push({ name: "[reports] " + name, fn });
function eq(a, b, label = "") {
  if (a !== b) throw new Error(`${label}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const building = () => ({ version: 1, hall: "building", tables: ALL_TABLES.map((t) => ({ ...t })), sessions: [], waitlist: [], waitHistory: [] });
const play = (s, tableId, from, to, id) => M.closeTable(M.openTable(s, { tableId, now: from, id }), { tableId, now: to });

function twoNights() {
  let s = building();
  s = play(s, "t1", at(12, 20), at(12, 21), "a"); // Thu night $22
  s = play(s, "t2", at(13, 0, 30), at(13, 1, 30), "b"); // after midnight: still Thursday, $22
  s = play(s, "t3", at(13, 20), at(13, 21), "c"); // Fri $25
  s = play(s, "u1", at(13, 20), at(13, 20, 30), "d"); // Fri upstairs $12.50
  s = M.applyDiscount(s, { sessionId: "c", now: at(13, 21, 1) }); // Fri: -$12.50
  s = M.openTable(s, { tableId: "t5", now: at(13, 21), id: "v" });
  s = M.voidSession(s, { sessionId: "v", now: at(13, 21, 1) });
  s = M.waitlistAdd(s, { name: "Sam", now: at(13, 20), id: "w1" });
  s = M.seatFromWaitlist(s, { waitId: "w1", tableId: "t9", now: at(13, 20, 20) });
  s = M.waitlistAdd(s, { name: "Al", now: at(13, 20), id: "w2" });
  s = M.waitlistRemove(s, { id: "w2", now: at(13, 20, 5) });
  return s;
}

test("Each night adds up the same as the staff app's nightly totals", () => {
  const s = twoNights();
  const nights = nightSummaries(s, at(14, 12));
  eq(nights.length, 2);
  const [thu, fri] = nights;
  eq(thu.collected, 4400, "Thursday incl. after-midnight: ");
  eq(thu.games, 2);
  const fridayStaff = M.daySummary(s, businessDateOf(at(13, 22)), at(14, 12)).closedTotalCents;
  eq(fri.collected, fridayStaff, "Friday matches staff totals: ");
  eq(fri.collected, 2500, "$25 - $12.50 coupon + $12.50 upstairs (+ Sam still running): ");
  eq(fri.byFloor.upstairs, 1250);
  eq(fri.coupons, 1);
  eq(fri.voids, 1);
  eq(fri.seated, 1);
  eq(fri.left, 1);
  eq(fri.waitMs, 20 * MINUTE);
});

test("Table-time is spread over the clock hours it was played in", () => {
  let s = play(building(), "t1", at(13, 20, 30), at(13, 22), "a");
  const n = nightSummaries(s, at(14, 12))[0];
  eq(n.tableMsByHour[20], 30 * MINUTE);
  eq(n.tableMsByHour[21], 60 * MINUTE);
  eq(n.tableMsByHour[22], 0);
  const hours = busyHours([n]);
  eq(hours[0].hour, 6, "business day starts at 6am: ");
  eq(hours.find((h) => h.hour === 21).tables, 1, "one table all of 9pm: ");
});

test("Paused time isn't counted as table-time", () => {
  let s = M.openTable(building(), { tableId: "t1", now: at(13, 20), id: "a" });
  s = M.pauseTable(s, { tableId: "t1", now: at(13, 20, 15) });
  s = M.resumeTable(s, { tableId: "t1", now: at(13, 20, 45) });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21) });
  const n = nightSummaries(s, at(14, 12))[0];
  eq(n.tableMsByHour[20], 30 * MINUTE);
});

test("Periods: last 7 nights, and the 7 before it to compare", () => {
  const r = periodRange("7", at(13, 22));
  eq(r.from.getDate(), 7);
  eq(r.to.getDate(), 14);
  eq(r.prev.from.getDate(), 31);
  eq(r.prev.to.getDate(), 7);
});

test("Periods: this month compares with the same days last month", () => {
  const r = periodRange("month", at(13, 22));
  eq(`${r.from.getMonth()}-${r.from.getDate()}`, "10-1");
  eq(`${r.prev.from.getMonth()}-${r.prev.from.getDate()}`, "9-1");
  eq(`${r.prev.to.getMonth()}-${r.prev.to.getDate()}`, "9-14");
});

test("Just after midnight still reports the night before as tonight", () => {
  const r = periodRange("7", at(14, 1));
  eq(r.to.getDate(), 14, "Friday night is the last night: ");
});

test("Totals and change against the previous period", () => {
  const nights = nightSummaries(twoNights(), at(14, 12));
  const t = totals(nights);
  eq(t.collected, 6900);
  eq(t.games, 4);
  eq(t.perGame, 1725);
  eq(t.upstairs, 1250);
  eq(change(150, 100), 0.5);
  eq(change(5, 0), null);
});

test("Average by day of week only counts nights with games", () => {
  const wd = byWeekday(nightSummaries(twoNights(), at(14, 12)));
  eq(wd[4].avg, 4400);
  eq(wd[5].avg, 2500);
  eq(wd[0].nights, 0);
});

test("Revenue chart groups by night, week or month depending on the period", () => {
  const nights = nightSummaries(twoNights(), at(14, 12));
  eq(revenueBars(nights, periodRange("30", at(13, 22))).unit, "night");
  eq(revenueBars(nights, periodRange("year", at(13, 22))).unit, "month");
  const weeks = revenueBars(nights, { from: new Date(2026, 7, 1), to: new Date(2026, 10, 14) });
  eq(weeks.unit, "week");
  eq(weeks.bars.length, 1, "Thu and Fri are the same Monday-start week: ");
  eq(weeks.bars[0].downstairs + weeks.bars[0].upstairs, 6900);
});

test("Sample data is believable and only covers past nights", () => {
  const sample = sampleState(at(13, 22), ALL_TABLES);
  const nights = nightSummaries({ ...building(), ...sample }, at(13, 22));
  eq(nights.length >= 100, true, "about 120 nights: ");
  eq(nights.every((n) => n.date < businessDateOf(at(13, 22))), true, "nothing tonight or later: ");
  const t = totals(inRange(nights, periodRange("all", at(13, 22))));
  eq(t.collected > 0 && t.upstairs > 0 && t.seated > 0, true);
});

// Tests for the pricing engine. Run by opening tests/index.html in a browser.
// Calendar used: November 2026. Nov 12 = Thursday, 13 = Fri, 14 = Sat,
// 15 = Sun, 16 = Mon, 10 = Tue.

import { priceSession, rateAt, businessDateOf } from "../src/billing/pricing.js";

const at = (day, h, m = 0, s = 0) => new Date(2026, 10, day, h, m, s); // local time, Nov 2026
const MIN = 60_000;
const HOUR = 3_600_000;

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function eq(actual, expected, label = "") {
  if (actual !== expected) {
    throw new Error(`${label}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function throws(fn, label) {
  try { fn(); } catch { return; }
  throw new Error(`${label}: expected an error`);
}
const total = (a, b) => priceSession(a, b).totalCents;

// --- Basic rates -----------------------------------------------------------
test("Tuesday afternoon 2pm-3pm = $15.00", () => eq(total(at(10, 14), at(10, 15)), 1500));
test("Tuesday evening 8pm-9pm = $22.00", () => eq(total(at(10, 20), at(10, 21)), 2200));
test("Friday evening 8pm-9pm = $25.00", () => eq(total(at(13, 20), at(13, 21)), 2500));
test("Saturday evening 8pm-9pm = $25.00", () => eq(total(at(14, 20), at(14, 21)), 2500));
test("Sunday evening 8pm-9pm = $22.00", () => eq(total(at(15, 20), at(15, 21)), 2200));
test("Saturday afternoon 1pm-2pm = $15.00 (day rate every day)", () => eq(total(at(14, 13), at(14, 14)), 1500));

// --- Crossing 6pm ------------------------------------------------------------
test("Tuesday 5:30pm-6:30pm = $7.50 + $11.00 = $18.50", () => {
  const r = priceSession(at(10, 17, 30), at(10, 18, 30));
  eq(r.totalCents, 1850);
  eq(r.segments.length, 2, "segments: ");
  eq(r.segments[0].cents, 750, "day part: ");
  eq(r.segments[1].cents, 1100, "evening part: ");
});
test("Saturday 5pm-7pm = $15 + $25 = $40.00", () => eq(total(at(14, 17), at(14, 19)), 4000));

// --- After midnight belongs to the previous night ---------------------------
test("Thursday 11pm -> Friday 1am = 2h x $22 = $44.00 (not Friday's rate)", () =>
  eq(total(at(12, 23), at(13, 1)), 4400));
test("Starting Friday 12:30am (Thursday night) to 1:30am = $22.00", () =>
  eq(total(at(13, 0, 30), at(13, 1, 30)), 2200));
test("Friday 11pm -> Saturday 1:30am = 2.5h x $25 = $62.50", () =>
  eq(total(at(13, 23), at(14, 1, 30)), 6250));
test("Saturday 11:30pm -> Sunday 12:30am = $25.00 (still Saturday night)", () =>
  eq(total(at(14, 23, 30), at(15, 0, 30)), 2500));
test("Sunday 11pm -> Monday 1am = $44.00 (Sunday night rate)", () =>
  eq(total(at(15, 23), at(16, 1)), 4400));
test("Thursday 5pm -> Friday 1am = 1h x $15 + 7h x $22 = $169.00", () =>
  eq(total(at(12, 17), at(13, 1)), 16900));
test("Running past 2am close keeps the night rate: Fri 1:30am-2:30am = $22.00", () =>
  eq(total(at(13, 1, 30), at(13, 2, 30)), 2200));
test("Business date of Friday 1am is Thursday", () => eq(businessDateOf(at(13, 1)).getDay(), 4));
test("Rate showing at Friday 1am is $22/hr", () => eq(rateAt(at(13, 1)).centsPerHour, 2200));
test("Rate showing at Saturday 1am is $25/hr", () => eq(rateAt(at(14, 1)).centsPerHour, 2500));

// --- Per-minute proration, no minimum -----------------------------------------
test("1 minute on Friday night = 1/60 x $25 = $0.42", () => eq(total(at(13, 21), at(13, 21, 1)), 42));
test("1 minute on Tuesday afternoon = $0.25", () => eq(total(at(10, 14), at(10, 14, 1)), 25));
test("30 minutes Friday night = $12.50", () => eq(total(at(13, 21), at(13, 21, 30)), 1250));
test("17m 30s on a weeknight = $6.42", () => eq(total(at(10, 20), at(10, 20, 17, 30)), 642));
test("Zero time = $0.00", () => eq(total(at(10, 20), at(10, 20)), 0));
test("End before start is rejected", () => throws(() => priceSession(at(10, 21), at(10, 20)), "reversed"));

// --- Totals are trustworthy ---------------------------------------------------
test("Segment amounts always add up exactly to the total (2,000 random sessions)", () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 2000; i++) {
    const start = at(9, 0).getTime() + Math.floor(rand() * 7 * 24 * HOUR);
    const end = start + Math.floor(rand() * 10 * HOUR);
    const r = priceSession(start, end);
    const sum = r.segments.reduce((a, s) => a + s.cents, 0);
    eq(sum, r.totalCents, `session ${i}: `);
    const msSum = r.segments.reduce((a, s) => a + s.ms, 0);
    eq(msSum, end - start, `session ${i} time: `);
  }
});
test("Charging in one go equals the exact per-ms price, rounded once", () => {
  // 5:59:30pm -> 6:00:30pm Tuesday: 30s at $15 + 30s at $22 = 12.5c + 18.33c = 30.83c -> 31c
  eq(total(at(10, 17, 59, 30), at(10, 18, 0, 30)), 31);
});

// --- Daylight saving ------------------------------------------------------------
test("Clocks falling back (Sat Oct 31 -> Sun Nov 1): 3 real hours from 11pm = $75.00", () => {
  const start = new Date(2026, 9, 31, 23, 0).getTime();
  eq(total(start, start + 3 * HOUR), 7500);
});
test("Clocks springing forward (Sat Mar 7 -> Sun Mar 8): 3 real hours from 11pm = $75.00", () => {
  const start = new Date(2026, 2, 7, 23, 0).getTime();
  eq(total(start, start + 3 * HOUR), 7500);
});
test("Durations are charged on real elapsed time", () => {
  const r = priceSession(at(13, 20), at(13, 20) .getTime() + 90 * MIN);
  eq(r.ms, 90 * MIN);
  eq(r.totalCents, 3750);
});

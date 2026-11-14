// Tests for the spreadsheet export and backup/restore. Nov 13 2026 is a Friday.

import * as M from "../src/model.js";
import { sessionsCsv, backupJson, parseBackup, CSV_HEADER } from "../src/export.js";
import { businessDateOf } from "../src/billing/pricing.js";

const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
export const tests = [];
const test = (name, fn) => tests.push({ name: "[export] " + name, fn });
function eq(a, b, label = "") {
  if (a !== b) throw new Error(`${label}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function throws(fn, label) {
  try { fn(); } catch { return; }
  throw new Error(`${label}: expected an error`);
}

// A small parser so the tests read the CSV the way a spreadsheet would.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  return rows;
}

function sampleNight() {
  let s = M.initialState();
  // Friday night
  s = M.openTable(s, { tableId: "t2", name: 'Mike "the shark", Jr.', now: at(13, 17, 30) });
  s = M.closeTable(s, { tableId: "t2", now: at(13, 18, 30) }); // $7.50 + $12.50 = $20.00
  s = M.openTable(s, { tableId: "t5", now: at(14, 0, 30), id: "late" });
  s = M.closeTable(s, { tableId: "t5", now: at(14, 1, 30) }); // after midnight, still Friday: $25.00
  s = M.openTable(s, { tableId: "t1", now: at(13, 21), id: "oops" });
  s = M.voidSession(s, { sessionId: "oops", now: at(13, 21, 1), reason: "wrong table" });
  s = M.openTable(s, { tableId: "t9", now: at(14, 1) }); // still running
  // Saturday afternoon: a different night
  s = M.openTable(s, { tableId: "t3", now: at(14, 14) });
  s = M.closeTable(s, { tableId: "t3", now: at(14, 15) });
  return s;
}

test("One night's export has a row per table played, oldest first, and a total", () => {
  const rows = parseCsv(sessionsCsv(sampleNight(), { night: businessDateOf(at(13, 20)), now: at(14, 1, 30) }));
  eq(rows[0].join("|"), CSV_HEADER.join("|"));
  const data = rows.slice(1, -2);
  eq(data.length, 4, "rows: ");
  eq(data[0][2], "Table 2");
  eq(data[0][3], 'Mike "the shark", Jr.', "name with comma and quotes: ");
  eq(data[0][8], "$15/hr + $25/hr", "rates: ");
  eq(data[0][9], "20.00", "full: ");
  eq(data[0][10], "0.00", "no coupon: ");
  eq(data[0][11], "20.00", "charged: ");
  eq(data[0][0], "2026-11-13");
  eq(data[0][1], "Friday");
  const late = data.find((r) => r[2] === "Table 5");
  eq(late[0], "2026-11-13", "after-midnight game is filed under Friday: ");
  eq(late[11], "25.00");
  eq(late[4], "2026-11-14 12:30 AM");
  const voided = data.find((r) => r[2] === "Table 1");
  eq(voided[11], "0.00");
  eq(voided[12], "Void: wrong table");
  const running = data.find((r) => r[2] === "Table 9");
  eq(running[12], "Still running");
  eq(running[5], "");
  const total = rows[rows.length - 1];
  eq(total[0], "Total (closed tables)");
  eq(total[11], "45.00", "total excludes voids and running tables: ");
});

test("All-nights export includes every night and no total row", () => {
  const rows = parseCsv(sessionsCsv(sampleNight(), { now: at(14, 16) }));
  eq(rows.length, 6, "header + 5 sessions: ");
  eq(rows[5][1], "Saturday");
});

test("Minutes and time played columns are filled in", () => {
  const rows = parseCsv(sessionsCsv(sampleNight(), { night: businessDateOf(at(13, 20)), now: at(14, 2) }));
  const t2 = rows.find((r) => r[2] === "Table 2");
  eq(t2[6], "1:00:00");
  eq(t2[7], "60.0");
});

test("Empty night exports just the header and a $0.00 total", () => {
  const rows = parseCsv(sessionsCsv(M.initialState(), { night: businessDateOf(at(13, 20)), now: at(13, 20) }));
  eq(rows.length, 3);
  eq(rows[2][11], "0.00");
});

test("Backup round-trips everything exactly", () => {
  const s = M.waitlistAdd(sampleNight(), { name: "Sam", now: at(14, 1), id: "w1" });
  const back = parseBackup(backupJson(s, at(14, 2)));
  eq(JSON.stringify(back.state), JSON.stringify(s));
  eq(back.exportedAt, at(14, 2));
});

test("Restore refuses files that aren't backups", () => {
  throws(() => parseBackup("not json"), "garbage");
  throws(() => parseBackup(JSON.stringify({ hello: 1 })), "other json");
  throws(() => parseBackup(JSON.stringify({ app: "pool-tables", state: { version: 1, tables: [], sessions: [{}], waitlist: [] } })), "damaged");
});

// --- Half-off coupons -----------------------------------------------------------
import { nightsCsv } from "../src/export.js";

function couponNight() {
  let s = M.initialState();
  s = M.openTable(s, { tableId: "t1", now: at(13, 20), id: "a" });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21) }); // $25.00
  s = M.applyDiscount(s, { sessionId: "a", now: at(13, 21, 1) }); // -> $12.50
  s = M.openTable(s, { tableId: "t2", now: at(13, 20), id: "b" });
  s = M.closeTable(s, { tableId: "t2", now: at(13, 20, 17) }); // 17 min @ $25 = $7.08
  s = M.applyDiscount(s, { sessionId: "b", now: at(13, 20, 18) }); // half of 708 = 354
  s = M.openTable(s, { tableId: "t3", now: at(13, 20), id: "c" });
  s = M.closeTable(s, { tableId: "t3", now: at(13, 20, 1) }); // 1 min = 41.67c -> 42c; half = 21c
  s = M.applyDiscount(s, { sessionId: "c", now: at(13, 20, 2) });
  return s;
}

test("Half-off coupon halves the charge and shows in the night's totals", () => {
  const s = couponNight();
  const sum = M.daySummary(s, businessDateOf(at(13, 22)), at(13, 22));
  eq(sum.fullTotalCents, 2500 + 708 + 42, "before coupons: ");
  eq(sum.closedTotalCents, 1250 + 354 + 21, "collected: ");
  eq(sum.couponCents, 1250 + 354 + 21, "coupons: ");
  eq(sum.couponCount, 3);
});

test("Odd cents round to the nearest cent: half of $0.43 is $0.22", () => {
  const c = M.sessionCharge({ start: 0, end: 1, discount: { percent: 50 } }, 0);
  eq(c.fullCents, 0); // sanity: tiny session
  const c2 = M.sessionCharge({ start: at(13, 20), end: at(13, 20) + 62_000, discount: { percent: 50 } }, 0);
  eq(c2.fullCents, 43); // 62 s at $25/hr = 43.06c
  eq(c2.chargedCents, 22);
  eq(c2.discountCents, 21);
});

test("Coupon can be removed, and can't go on a running or voided table", () => {
  let s = couponNight();
  s = M.removeDiscount(s, { sessionId: "a", now: at(13, 23) });
  eq(M.sessionCharge(s.sessions.find((x) => x.id === "a"), 0).chargedCents, 2500);
  s = M.openTable(s, { tableId: "t4", now: at(13, 22), id: "run" });
  throws(() => M.applyDiscount(s, { sessionId: "run", now: at(13, 22, 5) }), "running");
  s = M.voidSession(s, { sessionId: "run", now: at(13, 22, 6) });
  throws(() => M.applyDiscount(s, { sessionId: "run", now: at(13, 22, 7) }), "voided");
});

test("Reopening a table takes its coupon off", () => {
  let s = M.reopenSession(couponNight(), { sessionId: "a", now: at(13, 22) });
  eq(s.sessions.find((x) => x.id === "a").discount, undefined);
});

test("Export shows full charge, coupon and charged columns", () => {
  const rows = parseCsv(sessionsCsv(couponNight(), { night: businessDateOf(at(13, 22)), now: at(13, 22) }));
  const t1 = rows.find((r) => r[2] === "Table 1");
  eq(t1[9], "25.00");
  eq(t1[10], "12.50");
  eq(t1[11], "12.50");
  eq(t1[12], "Closed (Half-off coupon)");
  const total = rows[rows.length - 1];
  eq(total[9], "32.50");
  eq(total[10], "16.25");
  eq(total[11], "16.25");
});

test("Nightly totals export: one row per night with collected after coupons", () => {
  let s = couponNight();
  s = M.openTable(s, { tableId: "t5", now: at(14, 14) }); // Saturday afternoon
  s = M.closeTable(s, { tableId: "t5", now: at(14, 15) }); // $15
  s = M.openTable(s, { tableId: "t6", now: at(14, 15), id: "v" });
  s = M.voidSession(s, { sessionId: "v", now: at(14, 15, 1) });
  const rows = parseCsv(nightsCsv(s, { now: at(14, 16) }));
  eq(rows.length, 3, "header + 2 nights: ");
  eq(rows[1].join("|"), "2026-11-13|Friday|3|1.30|32.50|3|16.25|16.25|0|0");
  eq(rows[2].join("|"), "2026-11-14|Saturday|1|1.00|15.00|0|0.00|15.00|1|0");
});

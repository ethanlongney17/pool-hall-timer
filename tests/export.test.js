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

// --- Half-hour coupons -------------------------------------------------------------
import { nightsCsv } from "../src/export.js";

function couponNight() {
  let s = M.initialState();
  s = M.openTable(s, { tableId: "t1", now: at(13, 20), id: "a" });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21, 36) }); // 96 min @ $25 = $40.00
  s = M.applyDiscount(s, { sessionId: "a", now: at(13, 21, 37) }); // - $12.50 = $27.50
  s = M.openTable(s, { tableId: "t2", now: at(13, 20), id: "b" });
  s = M.closeTable(s, { tableId: "t2", now: at(13, 20, 17) }); // 17 min @ $25 = $7.08
  s = M.applyDiscount(s, { sessionId: "b", now: at(13, 20, 18) }); // coupon covers it all: $0
  return s;
}

test("$40 at $25/hr with a half-hour coupon = $40 - $12.50 = $27.50", () => {
  const s = couponNight();
  const c = M.sessionCharge(s.sessions.find((x) => x.id === "a"), 0);
  eq(c.fullCents, 4000);
  eq(c.discountCents, 1250);
  eq(c.chargedCents, 2750);
});

test("Coupon never takes off more than the bill (17 min game is free)", () => {
  const c = M.sessionCharge(couponNight().sessions.find((x) => x.id === "b"), 0);
  eq(c.discountCents, 708);
  eq(c.chargedCents, 0);
});

test("Coupon uses the rate the table stopped on: Tue 5:30-6:30pm $18.50 - $11.00 = $7.50", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(10, 17, 30), id: "x" });
  s = M.closeTable(s, { tableId: "t1", now: at(10, 18, 30) });
  s = M.applyDiscount(s, { sessionId: "x", now: at(10, 18, 31) });
  eq(M.sessionCharge(s.sessions[0], 0).chargedCents, 750);
});

test("After midnight Thursday the coupon is at Thursday's $22: $11.00 off", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 0, 30), id: "x" });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 1, 30) });
  s = M.applyDiscount(s, { sessionId: "x", now: at(13, 1, 31) });
  eq(M.sessionCharge(s.sessions[0], 0).discountCents, 1100);
});

test("Coupons show in the night's totals", () => {
  const sum = M.daySummary(couponNight(), businessDateOf(at(13, 22)), at(13, 22));
  eq(sum.fullTotalCents, 4708, "before coupons: ");
  eq(sum.couponCents, 1958, "coupons: ");
  eq(sum.closedTotalCents, 2750, "collected: ");
  eq(sum.couponCount, 2);
});

test("Older half-off records still add up (half of $0.43 is $0.22, charged $0.25)", () => {
  const c = M.sessionCharge({ start: at(20, 20), end: at(20, 20) + 62_000, discount: { percent: 50 } }, 0);
  eq(c.fullCents, 43);
  eq(c.discountCents, 21);
  eq(c.chargedCents, 25);
});

test("Coupon can be removed, and can't go on a running or voided table", () => {
  let s = M.removeDiscount(couponNight(), { sessionId: "a", now: at(13, 23) });
  eq(M.sessionCharge(s.sessions.find((x) => x.id === "a"), 0).chargedCents, 4000);
  s = M.openTable(s, { tableId: "t4", now: at(13, 22), id: "run" });
  throws(() => M.applyDiscount(s, { sessionId: "run", now: at(13, 22, 5) }), "running");
  s = M.voidSession(s, { sessionId: "run", now: at(13, 22, 6) });
  throws(() => M.applyDiscount(s, { sessionId: "run", now: at(13, 22, 7) }), "voided");
});

test("Reopening a table takes its coupon off", () => {
  const s = M.reopenSession(couponNight(), { sessionId: "a", now: at(13, 22) });
  eq(s.sessions.find((x) => x.id === "a").discount, undefined);
});

test("Export shows full charge, coupon and charged columns", () => {
  const rows = parseCsv(sessionsCsv(couponNight(), { night: businessDateOf(at(13, 22)), now: at(13, 22) }));
  const t1 = rows.find((r) => r[2] === "Table 1");
  eq(t1[9], "40.00");
  eq(t1[10], "12.50");
  eq(t1[11], "27.50");
  eq(t1[12], "Closed (Half-hour coupon)");
  const total = rows[rows.length - 1];
  eq(total[9], "47.08");
  eq(total[10], "19.58");
  eq(total[11], "27.50");
});

test("Nightly totals export: one row per night, collected after coupons", () => {
  let s = couponNight();
  s = M.openTable(s, { tableId: "t5", now: at(14, 14) }); // Saturday afternoon
  s = M.closeTable(s, { tableId: "t5", now: at(14, 15) }); // $15
  s = M.openTable(s, { tableId: "t6", now: at(14, 15), id: "v" });
  s = M.voidSession(s, { sessionId: "v", now: at(14, 15, 1) });
  const rows = parseCsv(nightsCsv(s, { now: at(14, 16) }));
  eq(rows.length, 3, "header + 2 nights: ");
  eq(rows[1].join("|"), "2026-11-13|Friday|2|1.88|47.08|2|19.58|27.50|0|0|Downstairs|0|||0|27.50|0.00");
  eq(rows[2].join("|"), "2026-11-14|Saturday|1|1.00|15.00|0|0.00|15.00|1|0|Downstairs|0|||0|15.00|0.00");
});

test("Export lists paused time in its own column", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 20) });
  s = M.pauseTable(s, { tableId: "t1", now: at(13, 20, 30) });
  s = M.resumeTable(s, { tableId: "t1", now: at(13, 20, 45) });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21, 15) });
  const rows = parseCsv(sessionsCsv(s, { night: businessDateOf(at(13, 22)), now: at(13, 22) }));
  eq(rows[0][13], "Paused (not charged)");
  eq(rows[1][6], "1:00:00", "time played excludes the pause: ");
  eq(rows[1][11], "25.00");
  eq(rows[1][13], "0:15:00");
});

// --- Upstairs floor ----------------------------------------------------------------
import { HALLS } from "../src/halls.js";

test("Upstairs starts with 5 tables of its own", () => {
  const s = M.initialState(HALLS.upstairs);
  eq(s.tables.length, 5);
  eq(s.tables[0].name, "Table 12");
  eq(s.tables[4].name, "Table 16");
  eq(s.hall, "upstairs");
  eq(HALLS.upstairs.storageKey === HALLS.downstairs.storageKey, false, "separate saved data: ");
});

test("Upstairs tables run and bill the same way", () => {
  let s = M.openTable(M.initialState(HALLS.upstairs), { tableId: "u3", now: at(13, 20) });
  s = M.closeTable(s, { tableId: "u3", now: at(13, 21) });
  const rows = parseCsv(sessionsCsv(s, { night: businessDateOf(at(13, 22)), now: at(13, 22) }));
  eq(rows[1][2], "Table 14");
  eq(rows[1][11], "25.00");
  throws(() => M.openTable(s, { tableId: "t1", now: at(13, 22) }), "downstairs table upstairs");
});

test("A backup can only be restored on the floor it came from", () => {
  const up = backupJson(M.initialState(HALLS.upstairs), at(13, 22));
  const down = backupJson(M.initialState(), at(13, 22));
  eq(parseBackup(up, "upstairs").state.tables.length, 5);
  throws(() => parseBackup(up, "downstairs"), "upstairs backup downstairs");
  throws(() => parseBackup(down, "upstairs"), "downstairs backup upstairs");
});

test("Backups saved before upstairs existed count as downstairs", () => {
  const old = JSON.parse(backupJson(M.initialState(), at(13, 22)));
  delete old.hall;
  delete old.state.hall;
  eq(parseBackup(JSON.stringify(old)).state.tables.length, 11);
  throws(() => parseBackup(JSON.stringify(old), "upstairs"), "old backup upstairs");
});

test("Every export row says which floor it's from, so floors can share one sheet", () => {
  let up = M.openTable(M.initialState(HALLS.upstairs), { tableId: "u1", now: at(13, 20) });
  up = M.closeTable(up, { tableId: "u1", now: at(13, 21) });
  const rows = parseCsv(sessionsCsv(up, { night: businessDateOf(at(13, 22)), now: at(13, 22) }));
  eq(rows[0][14], "Floor");
  eq(rows[1][14], "Upstairs");
  eq(rows[rows.length - 1][14], "Upstairs", "total row: ");
  const nights = parseCsv(nightsCsv(up, { now: at(13, 22) }));
  eq(nights[0][10], "Floor");
  eq(nights[1][10], "Upstairs");
  const down = parseCsv(sessionsCsv(sampleNight(), { now: at(14, 16) }));
  eq(down[1][14], "Downstairs");
});

test("Upstairs data saved under the old names picks up Table 12-16, keeping its games", () => {
  let old = M.initialState(HALLS.upstairs);
  old = { ...old, tables: old.tables.map((t, i) => ({ ...t, name: `Upstairs ${i + 1}` })) };
  old = M.openTable(old, { tableId: "u2", now: at(13, 20), id: "g" });
  const s = M.withHallTableNames(old, HALLS.upstairs);
  eq(s.tables.map((t) => t.name).join(","), "Table 12,Table 13,Table 14,Table 15,Table 16");
  eq(M.activeSession(s, "u2").id, "g", "running game stays on its table: ");
  eq(M.withHallTableNames(s, HALLS.upstairs), s, "no change needed: ");
});

test("Nightly totals export includes waitlist stats", () => {
  let s = M.waitlistAdd(M.initialState(), { name: "Sam", now: at(13, 20), id: "w1" });
  s = M.waitlistAdd(s, { name: "Alex", now: at(13, 20, 5), id: "w2" });
  s = M.seatFromWaitlist(s, { waitId: "w1", tableId: "t3", now: at(13, 20, 18) });
  s = M.waitlistRemove(s, { id: "w2", now: at(13, 20, 10) });
  const rows = parseCsv(nightsCsv(s, { now: at(13, 22) }));
  eq(rows[0].slice(11, 15).join("|"), "Seated from waitlist|Average wait (min)|Longest wait (min)|Left waitlist");
  eq(rows[1].slice(11, 15).join("|"), "1|18.0|18.0|1");
});

test("Export shows the rounding for each game and in the total", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(20, 20) });
  s = M.closeTable(s, { tableId: "t1", now: at(20, 20, 1) }); // $0.42 -> $0.50
  const rows = parseCsv(sessionsCsv(s, { night: businessDateOf(at(20, 22)), now: at(20, 22) }));
  eq(rows[0][15], "Rounding ($)");
  eq(rows[1][9], "0.42");
  eq(rows[1][11], "0.50");
  eq(rows[1][15], "0.08");
  eq(rows[rows.length - 1][15], "0.08");
});

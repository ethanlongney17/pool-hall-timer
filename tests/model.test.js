// Tests for table, waitlist and totals rules. Nov 13 2026 is a Friday.

import * as M from "../src/model.js";
import { businessDateOf } from "../src/billing/pricing.js";

const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
export const tests = [];
const test = (name, fn) => tests.push({ name: "[tables] " + name, fn });
function eq(a, b, label = "") {
  if (a !== b) throw new Error(`${label}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function throws(fn, label) {
  try { fn(); } catch { return; }
  throw new Error(`${label}: expected an error`);
}

test("Starts with 11 free tables and an empty waitlist", () => {
  const s = M.initialState();
  eq(s.tables.length, 11);
  eq(s.tables[10].name, "Table 11");
  eq(s.waitlist.length, 0);
});

test("Open then close a table records start and end", () => {
  let s = M.openTable(M.initialState(), { tableId: "t2", now: at(13, 20), id: "a" });
  eq(M.activeSession(s, "t2").id, "a");
  s = M.closeTable(s, { tableId: "t2", now: at(13, 21) });
  eq(M.activeSession(s, "t2"), undefined);
  eq(s.sessions[0].end, at(13, 21));
});

test("Can't open a table that's already running", () => {
  const s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 20) });
  throws(() => M.openTable(s, { tableId: "t1", now: at(13, 20, 5) }), "double open");
});

test("Can't close a table that isn't running", () =>
  throws(() => M.closeTable(M.initialState(), { tableId: "t1", now: at(13, 20) }), "close free"));

test("Reopen continues from the original start time", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 20), id: "a" });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21) });
  s = M.reopenSession(s, { sessionId: "a", now: at(13, 21, 1) });
  eq(M.activeSession(s, "t1").start, at(13, 20));
  eq(M.activeSession(s, "t1").end, null);
});

test("Reopen is refused if the table has been started again", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 20), id: "a" });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21) });
  s = M.openTable(s, { tableId: "t1", now: at(13, 21, 5), id: "b" });
  throws(() => M.reopenSession(s, { sessionId: "a", now: at(13, 22) }), "reopen over new");
});

test("Move keeps the timer and frees the old table", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 20), id: "a" });
  s = M.moveSession(s, { fromTableId: "t1", toTableId: "t5", now: at(13, 20, 30) });
  eq(M.activeSession(s, "t1"), undefined);
  eq(M.activeSession(s, "t5").start, at(13, 20));
});

test("Can't move onto a running table", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 20) });
  s = M.openTable(s, { tableId: "t2", now: at(13, 20) });
  throws(() => M.moveSession(s, { fromTableId: "t1", toTableId: "t2", now: at(13, 21) }), "move onto busy");
});

test("Void frees the table and leaves it out of the totals", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 20), id: "a" });
  s = M.voidSession(s, { sessionId: "a", now: at(13, 20, 2), reason: "wrong table" });
  eq(M.activeSession(s, "t1"), undefined);
  const sum = M.daySummary(s, businessDateOf(at(13, 21)), at(13, 21));
  eq(sum.closedTotalCents, 0);
  eq(sum.voided.length, 1);
});

test("Waitlist: add, seat (opens the table with their name), remove", () => {
  let s = M.waitlistAdd(M.initialState(), { name: "  Sam ", now: at(13, 20), id: "w1" });
  s = M.waitlistAdd(s, { name: "Alex", now: at(13, 20, 1), id: "w2" });
  eq(s.waitlist[0].name, "Sam");
  s = M.seatFromWaitlist(s, { waitId: "w1", tableId: "t3", now: at(13, 20, 10) });
  eq(M.activeSession(s, "t3").name, "Sam");
  eq(s.waitlist.length, 1);
  s = M.waitlistRemove(s, { id: "w2" });
  eq(s.waitlist.length, 0);
});

test("Seating onto a busy table leaves the person on the waitlist", () => {
  let s = M.openTable(M.initialState(), { tableId: "t3", now: at(13, 20) });
  s = M.waitlistAdd(s, { name: "Sam", now: at(13, 20), id: "w1" });
  const before = s;
  throws(() => M.seatFromWaitlist(s, { waitId: "w1", tableId: "t3", now: at(13, 21) }), "seat busy");
  eq(before.waitlist.length, 1);
});

test("Blank waitlist names are refused", () =>
  throws(() => M.waitlistAdd(M.initialState(), { name: "   ", now: at(13, 20) }), "blank"));

test("Night totals: sessions after midnight count toward the previous night", () => {
  let s = M.initialState();
  // Friday night: 8-9pm ($25) and 12:30-1:30am Saturday morning ($25)
  s = M.openTable(s, { tableId: "t1", now: at(13, 20) });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21) });
  s = M.openTable(s, { tableId: "t2", now: at(14, 0, 30) });
  s = M.closeTable(s, { tableId: "t2", now: at(14, 1, 30) });
  // Saturday afternoon 2-3pm ($15): a different business day
  s = M.openTable(s, { tableId: "t3", now: at(14, 14) });
  s = M.closeTable(s, { tableId: "t3", now: at(14, 15) });
  const fri = M.daySummary(s, businessDateOf(at(13, 22)), at(14, 16));
  eq(fri.closed.length, 2);
  eq(fri.closedTotalCents, 5000);
  const sat = M.daySummary(s, businessDateOf(at(14, 16)), at(14, 16));
  eq(sat.closedTotalCents, 1500);
});

test("Running tables show separately from closed totals", () => {
  let s = M.openTable(M.initialState(), { tableId: "t1", now: at(13, 20) });
  const sum = M.daySummary(s, businessDateOf(at(13, 20, 30)), at(13, 20, 30));
  eq(sum.closedTotalCents, 0);
  eq(sum.openRunningCents, 1250);
});

test("Actions never change the previous state (safe to undo/sync)", () => {
  const s0 = M.initialState();
  const snapshot = JSON.stringify(s0);
  M.openTable(s0, { tableId: "t1", now: at(13, 20) });
  eq(JSON.stringify(s0), snapshot);
});

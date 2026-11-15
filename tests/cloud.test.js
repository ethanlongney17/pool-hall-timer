// Tests for the shared two-floor setup and the cloud sync logic
// (everything except Firebase itself). Nov 13 2026 is a Friday.

import * as M from "../src/model.js";
import { ALL_TABLES, HALLS, floorsShown, floorsInPlay, onlyFloors, floorOf } from "../src/halls.js";
import { diffState, createMirror, withExtra, clean } from "../src/store/sync-core.js";
import { sessionsCsv, nightsCsv } from "../src/export.js";
import { businessDateOf } from "../src/billing/pricing.js";

const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
const MINUTE = 60_000;
export const tests = [];
const test = (name, fn) => tests.push({ name: "[cloud] " + name, fn });
function eq(a, b, label = "") {
  if (a !== b) throw new Error(`${label}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const building = () => ({ version: 1, hall: "building", tables: ALL_TABLES.map((t) => ({ ...t })), sessions: [], waitlist: [], waitHistory: [] });

// --- Floors -------------------------------------------------------------------------

test("The building has Tables 1-11 downstairs and 12-16 upstairs", () => {
  eq(ALL_TABLES.length, 16);
  eq(ALL_TABLES[10].name, "Table 11");
  eq(ALL_TABLES[11].name, "Table 12");
  eq(floorOf(building(), "t11"), "downstairs");
  eq(floorOf(building(), "u1"), "upstairs");
});

test("Downstairs shows upstairs only when it's open; upstairs app shows only upstairs", () => {
  eq(floorsShown(HALLS.downstairs, false).join(), "downstairs");
  eq(floorsShown(HALLS.downstairs, true).join(), "downstairs,upstairs");
  eq(floorsShown(HALLS.upstairs, false).join(), "upstairs");
  eq(floorsInPlay(true).join(), "downstairs,upstairs");
});

test("Downstairs can seat a waitlist party on an upstairs table", () => {
  let s = M.waitlistAdd(building(), { name: "Sam", now: at(13, 20), id: "w1" });
  s = M.seatFromWaitlist(s, { waitId: "w1", tableId: "u3", now: at(13, 20, 10) });
  eq(M.activeSession(s, "u3").name, "Sam");
  eq(s.waitHistory[0].tableId, "u3");
});

test("Wait estimates count upstairs tables when upstairs is open", () => {
  let s = building();
  for (const t of ALL_TABLES.filter((t) => t.floor === "downstairs")) s = M.openTable(s, { tableId: t.id, now: at(13, 20) });
  s = M.waitlistAdd(s, { name: "Sam", now: at(13, 20, 5) });
  eq(M.waitEstimates(onlyFloors(s, floorsInPlay(false)), at(13, 20, 10))[0], 50 * MINUTE, "closed: wait for downstairs: ");
  eq(M.waitEstimates(onlyFloors(s, floorsInPlay(true)), at(13, 20, 10))[0], 0, "open: upstairs table free: ");
});

test("Totals and exports split by floor", () => {
  let s = building();
  s = M.openTable(s, { tableId: "t1", now: at(13, 20) });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21) }); // $25
  s = M.openTable(s, { tableId: "u2", now: at(13, 20) });
  s = M.closeTable(s, { tableId: "u2", now: at(13, 20, 30) }); // $12.50
  const night = businessDateOf(at(13, 22));
  eq(M.daySummary(s, night, at(13, 22)).closedTotalCents, 3750, "building: ");
  eq(M.daySummary(onlyFloors(s, ["upstairs"]), night, at(13, 22)).closedTotalCents, 1250, "upstairs: ");
  const rows = sessionsCsv(s, { night, now: at(13, 22) }).replace(/^﻿/, "").trim().split(/\r\n/).map((r) => r.split(","));
  eq(rows[1][14], "Downstairs");
  eq(rows[2][2], "Table 13");
  eq(rows[2][14], "Upstairs");
  eq(rows[rows.length - 1][14], "Both", "total row: ");
  const nights = nightsCsv(s, { now: at(13, 22) }).replace(/^﻿/, "").trim().split(/\r\n/).map((r) => r.split(","));
  eq(nights[1][10], "Both");
  eq(nights[1][7], "37.50");
  eq(nights[1].slice(15).join("|"), "25.00|12.50");
});

// --- Sync logic ---------------------------------------------------------------------

test("Only what changed is sent to the cloud", () => {
  const s0 = M.waitlistAdd(building(), { name: "Sam", now: at(13, 20), id: "w1" });
  const s1 = M.openTable(s0, { tableId: "t1", now: at(13, 20, 5), id: "g1" });
  const ops = diffState(s0, s1);
  eq(ops.length, 1);
  eq(ops[0].op + " " + ops[0].col + " " + ops[0].id, "set sessions g1");
});

test("Seating sends: new game, waitlist entry removed, wait recorded", () => {
  const s0 = M.waitlistAdd(building(), { name: "Sam", now: at(13, 20), id: "w1" });
  const s1 = M.seatFromWaitlist(s0, { waitId: "w1", tableId: "u1", now: at(13, 20, 10) });
  const ops = diffState(s0, s1).map((o) => `${o.op} ${o.col}`).sort();
  eq(ops.join(" | "), "delete waitlist | set sessions | set waitHistory");
});

test("Removing a coupon really removes it from the cloud copy", () => {
  let s = M.openTable(building(), { tableId: "t1", now: at(13, 20), id: "g" });
  s = M.closeTable(s, { tableId: "t1", now: at(13, 21) });
  const withCoupon = M.applyDiscount(s, { sessionId: "g", now: at(13, 21, 1) });
  const without = M.removeDiscount(withCoupon, { sessionId: "g", now: at(13, 21, 2) });
  const op = diffState(withCoupon, without)[0];
  eq("discount" in op.data, false);
});

test("Nothing undefined is ever sent (the cloud rejects it)", () => {
  eq(JSON.stringify(clean({ a: 1, b: undefined, c: { d: undefined } })), '{"a":1,"c":{}}');
});

test("Changes from another device show up; deletions too", () => {
  const m = createMirror();
  m.apply("sessions", [{ type: "added", id: "g1", data: { tableId: "u1", start: at(13, 20), end: null } }]);
  m.apply("waitlist", [{ type: "added", id: "w1", data: { name: "Sam", addedAt: at(13, 20) } }]);
  let s = m.state(building());
  eq(M.activeSession(s, "u1").id, "g1");
  eq(s.waitlist[0].name, "Sam");
  m.apply("waitlist", [{ type: "removed", id: "w1" }]);
  eq(m.state(building()).waitlist.length, 0);
});

test("A device's own change shows straight away, before the cloud confirms", () => {
  const m = createMirror();
  const s0 = m.state(building());
  const s1 = M.openTable(s0, { tableId: "t2", now: at(13, 20), id: "g" });
  m.applyOps(diffState(s0, s1));
  eq(M.activeSession(m.state(building()), "t2").id, "g");
});

test("Two devices changing different things don't overwrite each other", () => {
  // Downstairs adds Sam; at the same moment upstairs closes Table 12.
  let base = M.openTable(building(), { tableId: "u1", now: at(13, 20), id: "g" });
  const m = createMirror();
  m.applyOps(diffState(building(), base));
  const down = M.waitlistAdd(base, { name: "Sam", now: at(13, 21), id: "w1" });
  const up = M.closeTable(base, { tableId: "u1", now: at(13, 21) });
  m.applyOps(diffState(base, down));
  m.applyOps(diffState(base, up));
  const s = m.state(building());
  eq(s.waitlist.length, 1, "Sam still waiting: ");
  eq(s.sessions[0].end, at(13, 21), "Table 12 still closed: ");
});

test("Older nights fetched later merge in without duplicates", () => {
  const recent = { sessions: [{ id: "a", start: 2 }], waitHistory: [] };
  const merged = withExtra(recent, { sessions: [{ id: "a", start: 2 }, { id: "b", start: 1 }], waitHistory: [{ id: "w", addedAt: 1 }] });
  eq(merged.sessions.map((s) => s.id).join(), "b,a");
  eq(merged.waitHistory.length, 1);
});

// --- Upstairs cleaning and "table ready" ---------------------------------------------

function upstairsGame() {
  let s = M.openTable(building(), { tableId: "u2", now: at(13, 20), id: "g" });
  return M.closeTable(s, { tableId: "u2", now: at(13, 21) });
}

test("A closed upstairs table is 'being cleaned' until marked ready", () => {
  const s = upstairsGame();
  eq(M.tableStatus(s, "u2", at(13, 21, 5)), "cleaning");
  const ready = M.markTableReady(s, { tableId: "u2", now: at(13, 21, 8) });
  eq(M.tableStatus(ready, "u2", at(13, 21, 9)), "free");
});

test("Downstairs tables never wait for cleaning", () => {
  let s = M.openTable(building(), { tableId: "t4", now: at(13, 20) });
  s = M.closeTable(s, { tableId: "t4", now: at(13, 21) });
  eq(M.tableStatus(s, "t4", at(13, 21, 1)), "free");
  eq(M.readyAlerts(s, at(13, 21, 1)).length, 0);
});

test("Marking ready alerts downstairs until 'Got it'", () => {
  let s = M.markTableReady(upstairsGame(), { tableId: "u2", now: at(13, 21, 8) });
  const alerts = M.readyAlerts(s, at(13, 21, 9));
  eq(alerts.length, 1);
  eq(alerts[0].tableId, "u2");
  s = M.ackTableReady(s, { tableId: "u2", now: at(13, 21, 10) });
  eq(M.readyAlerts(s, at(13, 21, 11)).length, 0);
  eq(M.tableStatus(s, "u2", at(13, 21, 11)), "free");
});

test("Seating someone at a ready table clears its alert", () => {
  let s = M.markTableReady(upstairsGame(), { tableId: "u2", now: at(13, 21, 8) });
  s = M.waitlistAdd(s, { name: "Sam", now: at(13, 21), id: "w1" });
  s = M.seatFromWaitlist(s, { waitId: "w1", tableId: "u2", now: at(13, 21, 9) });
  eq(M.readyAlerts(s, at(13, 21, 10)).length, 0);
  eq(M.tableStatus(s, "u2", at(13, 21, 10)), "running");
});

test("A table left uncleaned last night is free the next day", () => {
  eq(M.tableStatus(upstairsGame(), "u2", at(14, 14)), "free");
});

test("Voided upstairs games don't need cleaning", () => {
  let s = M.openTable(building(), { tableId: "u3", now: at(13, 20), id: "v" });
  s = M.voidSession(s, { sessionId: "v", now: at(13, 20, 1) });
  eq(M.tableStatus(s, "u3", at(13, 20, 2)), "free");
});

test("A table being cleaned counts as free in about 5 minutes for wait estimates", () => {
  let s = upstairsGame();
  for (const t of ALL_TABLES.filter((t) => t.id !== "u2")) s = M.openTable(s, { tableId: t.id, now: at(13, 21) });
  s = M.waitlistAdd(s, { name: "Sam", now: at(13, 21) });
  eq(M.waitEstimates(s, at(13, 21, 5))[0], 5 * MINUTE);
});

test("Ready and acknowledged are synced like any other change", () => {
  const s0 = upstairsGame();
  const s1 = M.markTableReady(s0, { tableId: "u2", now: at(13, 21, 8) });
  const ops = diffState(s0, s1);
  eq(ops.length, 1);
  eq(ops[0].col + " " + ops[0].id + " " + ops[0].data.readyAt, `sessions g ${at(13, 21, 8)}`);
});

// --- Reserved (prepaid) tables ----------------------------------------------------------

const reserve = (s, tableId, at, name = "Smith") => ({ ...s, reservations: { ...(s.reservations ?? {}), [tableId]: { name, at } } });
const unreserve = (s, tableId) => {
  const { [tableId]: _gone, ...rest } = s.reservations ?? {};
  return { ...s, reservations: rest };
};

test("A reserved table is blocked: not free, not offered, no charge", () => {
  const s = reserve(building(), "t4", at(13, 19));
  eq(M.tableStatus(s, "t4", at(13, 20)), "reserved");
  eq(M.activeReservation(s, "t4", at(13, 20)).name, "Smith");
  const sum = M.daySummary(s, businessDateOf(at(13, 22)), at(13, 22));
  eq(sum.closedTotalCents + sum.openRunningCents, 0);
});

test("Removing the reservation makes the table available straight away", () => {
  const s = unreserve(reserve(building(), "t4", at(13, 19)), "t4");
  eq(M.tableStatus(s, "t4", at(13, 20)), "free");
});

test("Reservations clear themselves at 6am (the next night)", () => {
  const s = reserve(building(), "t4", at(13, 19));
  eq(M.tableStatus(s, "t4", at(14, 1)), "reserved", "1am is still tonight: ");
  eq(M.tableStatus(s, "t4", at(14, 7)), "free", "7am next day: ");
});

test("Reserved tables are left out of wait estimates", () => {
  let s = building();
  for (const t of ALL_TABLES.filter((t) => t.floor === "downstairs" && t.id !== "t4")) s = M.openTable(s, { tableId: t.id, now: at(13, 20) });
  s = reserve(s, "t4", at(13, 19));
  s = M.waitlistAdd(s, { name: "Sam", now: at(13, 20, 5) });
  const down = onlyFloors(s, ["downstairs"]);
  eq(M.waitEstimates(down, at(13, 20, 10))[0], 50 * MINUTE, "waits for a running table, not the reserved one: ");
});

test("A reserved upstairs table doesn't send a 'ready' notice", () => {
  let s = M.openTable(building(), { tableId: "u2", now: at(13, 18), id: "g" });
  s = M.closeTable(s, { tableId: "u2", now: at(13, 19) });
  s = M.markTableReady(s, { tableId: "u2", now: at(13, 19, 5) });
  s = reserve(s, "u2", at(13, 19, 6));
  eq(M.readyAlerts(s, at(13, 19, 7)).length, 0);
});

test("Reservations sync without touching any game records", () => {
  const s0 = building();
  eq(diffState(s0, reserve(s0, "t4", at(13, 19))).length, 0);
});

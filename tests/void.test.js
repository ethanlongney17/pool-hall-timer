// Tests for voids (with manager approval) and manager PINs. Nov 20 2026 is a Friday.

import * as M from "../src/model.js";
import { ALL_TABLES } from "../src/halls.js";
import { businessDateOf } from "../src/billing/pricing.js";
import { sessionsCsv, nightsCsv } from "../src/export.js";
import { nightSummaries, totals } from "../src/reports-data.js";
import { makeManager, findManager, hashPin, hasManagers } from "../src/pin.js";

const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
export const tests = [];
const test = (name, fn) => tests.push({ name: "[void] " + name, fn });
function eq(a, b, label = "") {
  if (a !== b) throw new Error(`${label}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function throws(fn, label) {
  try { fn(); } catch { return; }
  throw new Error(`${label}: expected an error`);
}
async function rejects(fn, label) {
  try { await fn(); } catch { return; }
  throw new Error(`${label}: expected an error`);
}
const building = () => ({ version: 1, hall: "building", tables: ALL_TABLES.map((t) => ({ ...t })), sessions: [], waitlist: [], waitHistory: [] });
const parseCsv = (text) => text.replace(/^﻿/, "").trim().split(/\r\n/).map((r) => r.split(","));

function closedGame() {
  let s = M.openTable(building(), { tableId: "t1", now: at(20, 20), id: "g" });
  return M.closeTable(s, { tableId: "t1", now: at(20, 21) }); // $25.00
}

// --- Voiding ------------------------------------------------------------------------

test("A closed game can be voided: no charge, approver recorded", () => {
  const s = M.voidSession(closedGame(), { sessionId: "g", reason: "comped", approvedBy: "Mike", now: at(20, 21, 5) });
  const g = s.sessions[0];
  eq(M.sessionCharge(g, 0).chargedCents, 0);
  eq(g.voidApprovedBy, "Mike");
  eq(g.end, at(20, 21), "keeps its real end time: ");
  eq(g.log[g.log.length - 1].what, "voided (approved by Mike)");
});

test("The voided amount is recorded: what the game would have cost", () => {
  const s = M.voidSession(closedGame(), { sessionId: "g", approvedBy: "Mike", now: at(20, 21, 5) });
  eq(M.voidedValueCents(s.sessions[0]), 2500);
  const sum = M.daySummary(s, businessDateOf(at(20, 22)), at(20, 22));
  eq(sum.closedTotalCents, 0);
  eq(sum.voidedCents, 2500);
});

test("Voiding a running table charges up to the moment it was voided", () => {
  let s = M.openTable(building(), { tableId: "t2", now: at(20, 20), id: "r" });
  s = M.voidSession(s, { sessionId: "r", approvedBy: "Mike", now: at(20, 20, 30) });
  eq(M.activeSession(s, "t2"), undefined, "table freed: ");
  eq(M.voidedValueCents(s.sessions[0]), 1250, "30 min at $25: ");
});

test("Undoing a void brings the charge back", () => {
  let s = M.voidSession(closedGame(), { sessionId: "g", approvedBy: "Mike", now: at(20, 21, 5) });
  s = M.unvoidSession(s, { sessionId: "g", now: at(20, 21, 6) });
  eq(M.sessionCharge(s.sessions[0], 0).chargedCents, 2500);
  eq(s.sessions[0].voidApprovedBy, undefined);
});

test("Undoing a void on a running table starts its timer again from the original start", () => {
  let s = M.openTable(building(), { tableId: "t2", now: at(20, 20), id: "r" });
  s = M.voidSession(s, { sessionId: "r", approvedBy: "Mike", now: at(20, 20, 30) });
  s = M.unvoidSession(s, { sessionId: "r", now: at(20, 20, 31) });
  eq(M.activeSession(s, "t2").start, at(20, 20));
});

test("Can't undo a running void once the table has been started again", () => {
  let s = M.openTable(building(), { tableId: "t2", now: at(20, 20), id: "r" });
  s = M.voidSession(s, { sessionId: "r", approvedBy: "Mike", now: at(20, 20, 30) });
  s = M.openTable(s, { tableId: "t2", now: at(20, 20, 32) });
  throws(() => M.unvoidSession(s, { sessionId: "r", now: at(20, 20, 33) }), "restarted table");
});

test("Exports show the approver and the voided amount", () => {
  const s = M.voidSession(closedGame(), { sessionId: "g", reason: "wrong table", approvedBy: "Mike", now: at(20, 21, 5) });
  const rows = parseCsv(sessionsCsv(s, { night: businessDateOf(at(20, 22)), now: at(20, 22) }));
  eq(rows[0][16], "Voided value ($)");
  eq(rows[1][12], "Void: wrong table (approved by Mike)");
  eq(rows[1][16], "25.00");
  eq(rows[rows.length - 1][16], "25.00", "total row: ");
  const nights = parseCsv(nightsCsv(s, { now: at(20, 22) }));
  eq(nights[0][17], "Voided ($)");
  eq(nights[1][17], "25.00");
});

test("Reports total up voided amounts", () => {
  let s = M.voidSession(closedGame(), { sessionId: "g", approvedBy: "Mike", now: at(20, 21, 5) });
  s = M.openTable(s, { tableId: "t3", now: at(20, 20), id: "h" });
  s = M.closeTable(s, { tableId: "t3", now: at(20, 20, 30) });
  s = M.voidSession(s, { sessionId: "h", approvedBy: "Ann", now: at(20, 20, 31) });
  const t = totals(nightSummaries(s, at(21, 12)));
  eq(t.voids, 2);
  eq(t.voidedCents, 3750);
  eq(t.collected, 0);
});

// --- Manager PINs ---------------------------------------------------------------------

test("A manager's PIN is stored scrambled, never as the digits", async () => {
  const m = await makeManager("Mike", "4821");
  eq(m.name, "Mike");
  // No stored field is the PIN or contains it (the timestamp is left out: it can
  // contain any digits by chance).
  eq(Object.keys(m).sort().join(","), "addedAt,hash,name,salt", "only these fields: ");
  eq([m.hash, m.salt].some((v) => String(v).includes("4821") && v.length < 8), false);
  eq(m.hash === "4821" || m.salt === "4821", false);
  eq(m.hash.length, 64);
});

test("The right PIN finds its manager; a wrong one finds nobody", async () => {
  const managers = { a: await makeManager("Mike", "4821"), b: await makeManager("Ann", "777777") };
  eq((await findManager(managers, "4821")).name, "Mike");
  eq((await findManager(managers, "777777")).name, "Ann");
  eq(await findManager(managers, "4822"), null);
  eq(await findManager(managers, ""), null);
  eq(await findManager({}, "4821"), null);
});

test("Two managers with the same PIN still get different scrambles", async () => {
  const a = await makeManager("A", "1234");
  const b = await makeManager("B", "1234");
  eq(a.hash === b.hash, false);
  eq(await hashPin("1234", a.salt), a.hash);
});

test("PINs must be 4 to 8 digits, and a name is needed", async () => {
  await rejects(() => makeManager("Mike", "123"), "too short");
  await rejects(() => makeManager("Mike", "123456789"), "too long");
  await rejects(() => makeManager("Mike", "12a4"), "letters");
  await rejects(() => makeManager("  ", "1234"), "no name");
  eq(hasManagers({}), false);
  eq(hasManagers({ a: {} }), true);
});

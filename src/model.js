// The app's data and every change that can be made to it, as pure functions.
// Each action takes the current state and returns a NEW state (or throws with
// a message staff can read). The store decides where state is saved: on this
// device today, in the cloud later. Keeping the rules here means both stores
// behave identically.
//
// A table's timer is never a counter. A session stores its start time; the
// elapsed time and charge are always computed from it. A refresh, crash or
// dead battery cannot lose time.

import { priceSession, businessDateOf } from "./billing/pricing.js";

export const TABLE_COUNT = 11;

export function initialState() {
  return {
    version: 1,
    tables: Array.from({ length: TABLE_COUNT }, (_, i) => ({ id: `t${i + 1}`, name: `Table ${i + 1}` })),
    sessions: [], // { id, tableId, name, start, end|null, voidedAt?, voidReason?, log: [] }
    waitlist: [], // { id, name, note, addedAt }
  };
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- Queries ----------

export function activeSession(state, tableId) {
  return state.sessions.find((s) => s.tableId === tableId && s.end == null && !s.voidedAt);
}

function tableName(state, tableId) {
  return state.tables.find((t) => t.id === tableId)?.name ?? tableId;
}

function requireTable(state, tableId) {
  if (!state.tables.some((t) => t.id === tableId)) throw new Error(`Unknown table ${tableId}`);
}

/** Totals for one business day (the 6am-to-6am "night"), for matching the till. */
export function daySummary(state, businessDate, now) {
  const key = businessDate.getTime();
  const inDay = state.sessions.filter((s) => businessDateOf(s.start).getTime() === key);
  const closed = inDay
    .filter((s) => s.end != null && !s.voidedAt)
    .map((s) => ({ ...s, price: priceSession(s.start, s.end) }))
    .sort((a, b) => b.end - a.end);
  const open = inDay
    .filter((s) => s.end == null && !s.voidedAt)
    .map((s) => ({ ...s, price: priceSession(s.start, Math.max(now, s.start)) }));
  const voided = inDay.filter((s) => s.voidedAt);
  const sum = (list) => list.reduce((a, s) => a + s.price.totalCents, 0);
  return {
    closed,
    open,
    voided,
    closedTotalCents: sum(closed),
    openRunningCents: sum(open),
    totalMs: closed.reduce((a, s) => a + s.price.ms, 0),
  };
}

// ---------- Actions ----------

const withLog = (session, entry) => ({ ...session, log: [...(session.log ?? []), entry] });

function replaceSession(state, updated) {
  return { ...state, sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)) };
}

export function openTable(state, { tableId, name = "", now, id = newId() }) {
  requireTable(state, tableId);
  if (activeSession(state, tableId)) throw new Error(`${tableName(state, tableId)} is already running`);
  const session = { id, tableId, name: name.trim(), start: now, end: null, log: [{ at: now, what: "opened" }] };
  return { ...state, sessions: [...state.sessions, session] };
}

export function closeTable(state, { tableId, now }) {
  const s = activeSession(state, tableId);
  if (!s) throw new Error(`${tableName(state, tableId)} isn't running`);
  const end = Math.max(now, s.start);
  return replaceSession(state, withLog({ ...s, end }, { at: now, what: "closed" }));
}

/** Undo a close ("resume play"): the timer continues from the original start. */
export function reopenSession(state, { sessionId, now }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || s.end == null || s.voidedAt) throw new Error("That session can't be reopened");
  if (activeSession(state, s.tableId)) {
    throw new Error(`${tableName(state, s.tableId)} has been opened again since; can't reopen`);
  }
  return replaceSession(state, withLog({ ...s, end: null }, { at: now, what: "reopened" }));
}

export function moveSession(state, { fromTableId, toTableId, now }) {
  requireTable(state, toTableId);
  const s = activeSession(state, fromTableId);
  if (!s) throw new Error(`${tableName(state, fromTableId)} isn't running`);
  if (activeSession(state, toTableId)) throw new Error(`${tableName(state, toTableId)} is already running`);
  return replaceSession(
    state,
    withLog({ ...s, tableId: toTableId }, { at: now, what: `moved from ${tableName(state, fromTableId)}` }),
  );
}

export function renameSession(state, { sessionId, name, now }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) throw new Error("Session not found");
  return replaceSession(state, withLog({ ...s, name: name.trim() }, { at: now, what: "renamed" }));
}

/** For a table opened by mistake. Kept in the records (marked void), not deleted. */
export function voidSession(state, { sessionId, reason = "", now }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || s.voidedAt) throw new Error("Session not found");
  return replaceSession(
    state,
    withLog({ ...s, end: s.end ?? now, voidedAt: now, voidReason: reason.trim() }, { at: now, what: "voided" }),
  );
}

export function waitlistAdd(state, { name, note = "", now, id = newId() }) {
  const n = name.trim();
  if (!n) throw new Error("Enter a name");
  return { ...state, waitlist: [...state.waitlist, { id, name: n, note: note.trim(), addedAt: now }] };
}

export function waitlistRemove(state, { id }) {
  return { ...state, waitlist: state.waitlist.filter((w) => w.id !== id) };
}

export function seatFromWaitlist(state, { waitId, tableId, now }) {
  const w = state.waitlist.find((x) => x.id === waitId);
  if (!w) throw new Error("That name is no longer on the waitlist");
  const opened = openTable(state, { tableId, name: w.name, now });
  return waitlistRemove(opened, { id: waitId });
}

export const actions = {
  openTable,
  closeTable,
  reopenSession,
  moveSession,
  renameSession,
  voidSession,
  waitlistAdd,
  waitlistRemove,
  seatFromWaitlist,
};

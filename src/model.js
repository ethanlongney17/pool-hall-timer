// The app's data and every change that can be made to it, as pure functions.
// Each action takes the current state and returns a NEW state (or throws with
// a message staff can read). The store decides where state is saved: on this
// device today, in the cloud later. Keeping the rules here means both stores
// behave identically.
//
// A table's timer is never a counter. A session stores its start time; the
// elapsed time and charge are always computed from it. A refresh, crash or
// dead battery cannot lose time.

import { priceIntervals, businessDateOf } from "./billing/pricing.js";

import { HALLS } from "./halls.js";

/**
 * Saved data keeps the table names from when it was first created. When a
 * name changes in halls.js, apply it here (matched by table id, so past
 * games stay attached to the right table).
 */
export function withHallTableNames(state, hall) {
  const names = new Map(hall.tables.map((t) => [t.id, t.name]));
  if (!state.tables.some((t) => names.has(t.id) && names.get(t.id) !== t.name)) return state;
  return { ...state, tables: state.tables.map((t) => (names.has(t.id) ? { ...t, name: names.get(t.id) } : t)) };
}

/** A fresh, empty floor. Defaults to downstairs (11 tables). */
export function initialState(hall = HALLS.downstairs) {
  return {
    version: 1,
    hall: hall.id,
    tables: hall.tables.map((t) => ({ ...t })),
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

/**
 * What a session costs: the full time charge, any coupon taken off it, and
 * what's actually collected. Voided sessions collect nothing.
 */
/** Is this table's timer paused right now? */
export function isPaused(s) {
  const last = s.pauses?.[s.pauses.length - 1];
  return !!last && last.to == null;
}

/** Total time spent paused, up to `now` for a pause still going. */
export function pausedMs(s, now) {
  const end = s.end ?? now;
  return (s.pauses ?? []).reduce((a, p) => a + Math.max(0, Math.min(p.to ?? end, end) - p.from), 0);
}

/** The stretches of actual play, leaving out pauses: [[from, to], ...]. */
export function playedIntervals(s, end) {
  const out = [];
  let t = s.start;
  for (const p of s.pauses ?? []) {
    const pauseFrom = Math.min(p.from, end);
    if (pauseFrom > t) out.push([t, pauseFrom]);
    if (p.to == null) return out; // still paused
    t = Math.max(t, p.to);
  }
  if (end > t) out.push([t, end]);
  return out;
}

export function sessionCharge(s, now) {
  const end = s.end ?? Math.max(now, s.start);
  const price = priceIntervals(playedIntervals(s, end));
  const fullCents = price.totalCents;
  const discountCents = Math.min(fullCents, couponValue(s.discount, price, fullCents));
  return { price, fullCents, discountCents, chargedCents: s.voidedAt ? 0 : fullCents - discountCents };
}

/** The rate the coupon is worked out at: the one the table was on when it stopped. */
export function couponRate(price) {
  return price.segments.length ? price.segments[price.segments.length - 1].centsPerHour : 0;
}

function couponValue(discount, price, fullCents) {
  if (!discount) return 0;
  // Time coupon (e.g. half an hour free): that many minutes at the closing rate.
  // $25/hr table, 30-minute coupon -> $12.50 off. Never more than the bill.
  if (discount.minutes) return Math.round((couponRate(price) * discount.minutes) / 60);
  // Older percent-off coupons, kept so earlier records still add up.
  if (discount.percent) return fullCents - Math.round((fullCents * (100 - discount.percent)) / 100);
  return 0;
}

/** Totals for one business day (the 6am-to-6am "night"), for matching the till. */
export function daySummary(state, businessDate, now) {
  const key = businessDate.getTime();
  const inDay = state.sessions.filter((s) => businessDateOf(s.start).getTime() === key);
  const withCharge = (s) => {
    const c = sessionCharge(s, now);
    return { ...s, price: c.price, charge: c };
  };
  const closed = inDay
    .filter((s) => s.end != null && !s.voidedAt)
    .map(withCharge)
    .sort((a, b) => b.end - a.end);
  const open = inDay.filter((s) => s.end == null && !s.voidedAt).map(withCharge);
  const voided = inDay.filter((s) => s.voidedAt).map(withCharge);
  const sum = (list, field) => list.reduce((a, s) => a + s.charge[field], 0);
  const coupons = closed.filter((s) => s.discount);
  return {
    closed,
    open,
    voided,
    closedTotalCents: sum(closed, "chargedCents"), // what should be in the till
    fullTotalCents: sum(closed, "fullCents"), // before coupons
    couponCents: sum(closed, "discountCents"),
    couponCount: coupons.length,
    openRunningCents: sum(open, "chargedCents"),
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
  // Closing a paused table ends the pause there; the paused time isn't charged.
  const pauses = isPaused(s)
    ? s.pauses.map((p, i) => (i === s.pauses.length - 1 ? { ...p, to: Math.max(end, p.from) } : p))
    : s.pauses;
  return replaceSession(state, withLog({ ...s, end, ...(pauses ? { pauses } : {}) }, { at: now, what: "closed" }));
}

/** Stop the clock on a running table (charge freezes) until it's resumed. */
export function pauseTable(state, { tableId, now }) {
  const s = activeSession(state, tableId);
  if (!s) throw new Error(`${tableName(state, tableId)} isn't running`);
  if (isPaused(s)) throw new Error(`${tableName(state, tableId)} is already paused`);
  const from = Math.max(now, s.start);
  return replaceSession(
    state,
    withLog({ ...s, pauses: [...(s.pauses ?? []), { from, to: null }] }, { at: now, what: "paused" }),
  );
}

export function resumeTable(state, { tableId, now }) {
  const s = activeSession(state, tableId);
  if (!s) throw new Error(`${tableName(state, tableId)} isn't running`);
  if (!isPaused(s)) throw new Error(`${tableName(state, tableId)} isn't paused`);
  const pauses = s.pauses.map((p, i) => (i === s.pauses.length - 1 ? { ...p, to: Math.max(now, p.from) } : p));
  return replaceSession(state, withLog({ ...s, pauses }, { at: now, what: "resumed" }));
}

/** Undo a close ("resume play"): the timer continues from the original start. */
export function reopenSession(state, { sessionId, now }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || s.end == null || s.voidedAt) throw new Error("That session can't be reopened");
  if (activeSession(state, s.tableId)) {
    throw new Error(`${tableName(state, s.tableId)} has been opened again since; can't reopen`);
  }
  // A coupon applies to a finished game, so reopening takes it off.
  const { discount, ...rest } = s;
  return replaceSession(state, withLog({ ...rest, end: null }, { at: now, what: "reopened" }));
}

/** Coupon on a closed table: half an hour free by default. Replaces any coupon already on it. */
export function applyDiscount(state, { sessionId, minutes = 30, label = "Half-hour coupon", now }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || s.end == null) throw new Error("Close the table before applying a coupon");
  if (s.voidedAt) throw new Error("This table was voided; there's nothing to discount");
  if (!(minutes > 0 && minutes <= 600)) throw new Error("Coupon must be for some minutes of play");
  return replaceSession(
    state,
    withLog({ ...s, discount: { minutes, label, at: now } }, { at: now, what: `coupon: ${label}` }),
  );
}

export function removeDiscount(state, { sessionId, now }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s?.discount) throw new Error("There's no coupon on this table");
  const { discount, ...rest } = s;
  return replaceSession(state, withLog(rest, { at: now, what: "coupon removed" }));
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
  applyDiscount,
  pauseTable,
  resumeTable,
  removeDiscount,
};

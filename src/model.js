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
import { ROUND_TO_CENTS, ROUNDING_FROM } from "./billing/rates.js";

import { HALLS, floorOf } from "./halls.js";

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
    waitHistory: [], // { id, name, addedAt, endedAt, outcome, tableId? }
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

// ---------- Cleaning and "table ready" (upstairs) ----------
// Upstairs tables are cleaned by the bartender after a game. Until they tap
// "Table ready", the table shows as being cleaned and isn't offered for
// seating. Marking it ready tells downstairs (a flashing tile and a banner)
// until someone there taps "Got it" or the table is used. Stored on the game
// that just finished, so it syncs like everything else.

export const CLEANING_FLOORS = ["upstairs"];

/** The most recent finished (not voided) game on a table. */
function lastFinished(state, tableId) {
  let last = null;
  for (const s of state.sessions) {
    if (s.tableId !== tableId || s.end == null || s.voidedAt) continue;
    if (!last || s.end > last.end) last = s;
  }
  return last;
}
const sameNight = (a, b) => businessDateOf(a).getTime() === businessDateOf(b).getTime();

// ---------- Reservations ----------
// A reserved table is prepaid and blocked for the night: no timer or charge,
// not offered for seating, left out of free counts and wait estimates.
// Kept in state.reservations = { tableId: { name, at } } (shared by every
// device) and only counts on the night it was made, so it clears at 6am.

export function activeReservation(state, tableId, now) {
  const r = state.reservations?.[tableId];
  if (!r || !Number.isFinite(r.at)) return null;
  return sameNight(r.at, now) ? r : null;
}

/** "running", "reserved", "cleaning" or "free". */
export function tableStatus(state, tableId, now) {
  if (activeSession(state, tableId)) return "running";
  if (activeReservation(state, tableId, now)) return "reserved";
  if (!CLEANING_FLOORS.includes(floorOf(state, tableId))) return "free";
  const last = lastFinished(state, tableId);
  if (last && last.readyAt == null && sameNight(last.end, now)) return "cleaning";
  return "free";
}

/** Tables marked ready that downstairs hasn't acknowledged yet, oldest first. */
export function readyAlerts(state, now) {
  const out = [];
  for (const t of state.tables) {
    if (tableStatus(state, t.id, now) !== "free") continue;
    const last = lastFinished(state, t.id);
    if (last?.readyAt != null && last.readyAckAt == null && sameNight(last.readyAt, now)) {
      out.push({ tableId: t.id, sessionId: last.id, readyAt: last.readyAt });
    }
  }
  return out.sort((a, b) => a.readyAt - b.readyAt);
}

export function markTableReady(state, { tableId, now }) {
  if (activeSession(state, tableId)) throw new Error("That table is in use");
  const last = lastFinished(state, tableId);
  if (!last || last.readyAt != null) return state;
  return replaceSession(state, withLog({ ...last, readyAt: now }, { at: now, what: "table ready" }));
}

/** Downstairs saw the "ready" notice. */
export function ackTableReady(state, { tableId, now }) {
  const last = lastFinished(state, tableId);
  if (!last || last.readyAt == null || last.readyAckAt != null) return state;
  return replaceSession(state, { ...last, readyAckAt: now });
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
  const exact = fullCents - discountCents;
  // Games that finished before rounding started keep their exact amounts.
  const chargedCents = s.voidedAt ? 0 : end >= ROUNDING_FROM ? roundCharge(exact) : exact;
  // roundingCents: what rounding added (+) or took off (-), shown on the receipt.
  return { price, fullCents, discountCents, roundingCents: s.voidedAt ? 0 : chargedCents - exact, chargedCents };
}

/**
 * What a voided game would have cost (up to when it was voided): the amount
 * written off. 0 for games that aren't voided.
 */
export function voidedValueCents(s) {
  if (!s.voidedAt) return 0;
  const { voidedAt, ...asIfNot } = s;
  return sessionCharge(asIfNot, s.end ?? voidedAt).chargedCents;
}

/** Round a charge to the nearest ROUND_TO_CENTS (a quarter). */
export function roundCharge(cents, step = ROUND_TO_CENTS) {
  return Math.round(cents / step) * step;
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
    voidedCents: voided.reduce((a, s) => a + voidedValueCents(s), 0), // written off by voids
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
/**
 * No charge for this game: opened by mistake, or comped after it closed.
 * Kept in the records as voided. `approvedBy` is the manager who okayed it.
 */
export function voidSession(state, { sessionId, reason = "", approvedBy = "", now }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || s.voidedAt) throw new Error("Session not found");
  const voided = { ...s, end: s.end ?? now, voidedAt: now, voidReason: reason.trim(), wasRunning: s.end == null };
  if (approvedBy) voided.voidApprovedBy = approvedBy;
  return replaceSession(
    state,
    withLog(voided, { at: now, what: approvedBy ? `voided (approved by ${approvedBy})` : "voided" }),
  );
}

/** Undo a void: the game counts again, and a running one keeps running. */
export function unvoidSession(state, { sessionId, now }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s?.voidedAt) throw new Error("That game isn't voided");
  if (s.wasRunning && activeSession(state, s.tableId)) {
    throw new Error(`${tableName(state, s.tableId)} has been started again since; can't undo`);
  }
  const { voidedAt, voidReason, voidApprovedBy, wasRunning, ...rest } = s;
  return replaceSession(state, withLog({ ...rest, end: wasRunning ? null : s.end }, { at: now, what: "void undone" }));
}

export function waitlistAdd(state, { name, note = "", now, id = newId() }) {
  const n = name.trim();
  if (!n) throw new Error("Enter a name");
  return { ...state, waitlist: [...state.waitlist, { id, name: n, note: note.trim(), addedAt: now }] };
}

// Every party that leaves the waitlist is recorded in waitHistory, so real
// waits can be reported and used to estimate future ones:
//   { id, name, addedAt, endedAt, outcome: "seated" | "left", tableId? }

function takeOffWaitlist(state, w, now, outcome, tableId) {
  const record = { id: w.id, name: w.name, addedAt: w.addedAt, endedAt: Math.max(now, w.addedAt), outcome };
  if (w.note) record.note = w.note;
  if (tableId) record.tableId = tableId;
  return {
    ...state,
    waitlist: state.waitlist.filter((x) => x.id !== w.id),
    waitHistory: [...(state.waitHistory ?? []), record],
  };
}

/** Taken off the list without being seated (they left, or a mistake). */
export function waitlistRemove(state, { id, now = Date.now() }) {
  const w = state.waitlist.find((x) => x.id === id);
  if (!w) return state;
  return takeOffWaitlist(state, w, now, "left");
}

/** Undo a removal: back in their original place in line, as if never removed. */
export function waitlistRestore(state, { id }) {
  const r = (state.waitHistory ?? []).find((x) => x.id === id && x.outcome === "left");
  if (!r) throw new Error("That name can't be put back");
  if (state.waitlist.some((x) => x.id === id)) return state;
  const entry = { id: r.id, name: r.name, note: r.note ?? "", addedAt: r.addedAt };
  return {
    ...state,
    waitlist: [...state.waitlist, entry].sort((a, b) => a.addedAt - b.addedAt),
    waitHistory: state.waitHistory.filter((x) => x !== r),
  };
}

export function seatFromWaitlist(state, { waitId, tableId, now }) {
  const w = state.waitlist.find((x) => x.id === waitId);
  if (!w) throw new Error("That name is no longer on the waitlist");
  const opened = openTable(state, { tableId, name: w.name, now });
  return takeOffWaitlist(opened, w, now, "seated", tableId);
}

// ---------- Wait estimates ----------

const MIN = 60_000;
const DEFAULT_GAME_MS = 60 * MIN; // used until there are enough games to learn from
const MIN_REMAINING_MS = 5 * MIN; // a table past its typical length is "any minute now"

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * How long a game usually lasts here: the median of the last 100 finished games
 * (at least 10 of them, and ignoring quick 3-minute ones), else 60 minutes.
 */
export function typicalGameMs(state) {
  const lengths = state.sessions
    .filter((s) => s.end != null && !s.voidedAt)
    .sort((a, b) => b.end - a.end)
    .slice(0, 100)
    .map((s) => s.end - s.start - pausedMs(s, s.end))
    .filter((ms) => ms >= 3 * MIN);
  return lengths.length >= 10 ? median(lengths) : DEFAULT_GAME_MS;
}

/**
 * Estimated wait for each person on the list, in order, plus for a party
 * joining now (the last value). 0 means a table is free now.
 *
 * Each running table is expected to finish when it reaches the typical game
 * length (or in about 5 minutes if it's already past it). The 1st person in
 * line gets the soonest table, the 2nd the next, and so on; once every table
 * is spoken for, the line wraps around for another game.
 */
export function waitEstimates(state, now) {
  const typical = typicalGameMs(state);
  let free = 0;
  const remaining = [];
  for (const t of state.tables) {
    const status = tableStatus(state, t.id, now);
    if (status === "free") {
      free++;
      continue;
    }
    if (status === "cleaning") {
      remaining.push(MIN_REMAINING_MS); // ready in a few minutes
      continue;
    }
    if (status === "reserved") continue; // not available tonight
    const s = activeSession(state, t.id);
    const played = now - s.start - pausedMs(s, now);
    remaining.push(Math.max(typical - played, MIN_REMAINING_MS));
  }
  remaining.sort((a, b) => a - b);
  const estimateFor = (position) => {
    if (position < free) return 0;
    const j = position - free;
    if (!remaining.length) return typical; // no tables at all: shouldn't happen
    return remaining[j % remaining.length] + typical * Math.floor(j / remaining.length);
  };
  return Array.from({ length: state.waitlist.length + 1 }, (_, i) => estimateFor(i));
}

/** Real waits for one business night: who was seated, how long they waited, who left. */
export function waitStats(state, businessDate) {
  const key = businessDate.getTime();
  const tonight = (state.waitHistory ?? []).filter((w) => businessDateOf(w.addedAt).getTime() === key);
  const seated = tonight.filter((w) => w.outcome === "seated").map((w) => w.endedAt - w.addedAt);
  return {
    seatedCount: seated.length,
    leftCount: tonight.filter((w) => w.outcome === "left").length,
    averageMs: seated.length ? seated.reduce((a, b) => a + b, 0) / seated.length : 0,
    longestMs: seated.length ? Math.max(...seated) : 0,
  };
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
  waitlistRestore,
  seatFromWaitlist,
  applyDiscount,
  unvoidSession,
  markTableReady,
  ackTableReady,
  pauseTable,
  resumeTable,
  removeDiscount,
};

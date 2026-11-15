// Export (spreadsheet for Numbers/Excel) and full backup/restore.
// Everything here runs on the device: no internet needed.

import { businessDateOf } from "./billing/pricing.js";
import { sessionCharge, pausedMs, waitStats, voidedValueCents } from "./model.js";
import { floorOf, FLOORS } from "./halls.js";

const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dateTime(t) {
  const d = new Date(t);
  const h = d.getHours() % 12 || 12;
  return `${ymd(d)} ${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}
function hms(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
const dollars = (cents) => (cents / 100).toFixed(2);
// Every row says which floor its table is on, so both floors share one sheet.
const floorName = (state, tableId) => FLOORS[floorOf(state, tableId)].name;
// For a total row or a night: "Downstairs", "Upstairs" or "Both".
function floorsLabel(state, sessions) {
  const names = new Set(sessions.map((s) => floorName(state, s.tableId)));
  if (!names.size) return state.hall === "upstairs" ? "Upstairs" : "Downstairs";
  return names.size > 1 ? "Both" : [...names][0];
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(",");

export const CSV_HEADER = [
  "Night", "Day", "Table", "Customer", "Started", "Stopped", "Time played", "Minutes", "Rate",
  "Full charge ($)", "Coupon ($)", "Charged ($)", "Status", "Paused (not charged)", "Floor", "Rounding ($)", "Voided value ($)",
];

/**
 * Spreadsheet of sessions, one row per table played, oldest first.
 * @param {object} state
 * @param {{ night?: Date, now: number }} opts  night = one business date only; omit for all history.
 */
export function sessionsCsv(state, { night, now }) {
  const tableName = (id) => state.tables.find((t) => t.id === id)?.name ?? id;
  const key = night ? night.getTime() : null;
  const sessions = state.sessions
    .filter((s) => key == null || businessDateOf(s.start).getTime() === key)
    .sort((a, b) => a.start - b.start);

  const totals = { full: 0, coupon: 0, charged: 0, rounding: 0, voided: 0 };
  const rows = sessions.map((s) => {
    const bd = businessDateOf(s.start);
    const running = s.end == null && !s.voidedAt;
    const c = sessionCharge(s, now);
    const rates = [...new Set(c.price.segments.map((seg) => `$${seg.centsPerHour / 100}/hr`))].join(" + ");
    let status = s.voidedAt
      ? `Void${s.voidReason ? ": " + s.voidReason : ""}${s.voidApprovedBy ? ` (approved by ${s.voidApprovedBy})` : ""}`
      : running ? "Still running" : "Closed";
    if (s.discount && !s.voidedAt) status += ` (${s.discount.label})`;
    const full = s.voidedAt ? 0 : c.fullCents;
    const coupon = s.voidedAt ? 0 : c.discountCents;
    totals.voided += voidedValueCents(s);
    if (!s.voidedAt && !running) {
      totals.full += full;
      totals.coupon += coupon;
      totals.charged += c.chargedCents;
      totals.rounding += c.roundingCents;
    }
    return csvRow([
      ymd(bd), WEEKDAYS[bd.getDay()], tableName(s.tableId), s.name, dateTime(s.start),
      running ? "" : dateTime(s.end), hms(c.price.ms), (c.price.ms / 60000).toFixed(1), rates,
      dollars(full), dollars(coupon), dollars(c.chargedCents), status, pausedMs(s, now) >= 1000 ? hms(pausedMs(s, now)) : "", floorName(state, s.tableId), dollars(c.roundingCents), s.voidedAt ? dollars(voidedValueCents(s)) : "",
    ]);
  });

  const lines = [csvRow(CSV_HEADER), ...rows];
  if (night) {
    lines.push("", csvRow(["Total (closed tables)", "", "", "", "", "", "", "", "",
      dollars(totals.full), dollars(totals.coupon), dollars(totals.charged), "", "", floorsLabel(state, sessions), dollars(totals.rounding), dollars(totals.voided)]));
  }
  // The byte-order mark makes Excel read the file as UTF-8; Numbers ignores it.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export const NIGHTS_HEADER = [
  "Night", "Day", "Tables played", "Hours played", "Full charges ($)", "Coupons used", "Coupons ($)",
  "Collected ($)", "Voided", "Still running", "Floor",
  "Seated from waitlist", "Average wait (min)", "Longest wait (min)", "Left waitlist",
  "Downstairs collected ($)", "Upstairs collected ($)", "Voided ($)",
];

/** One row per night: the figures to check against the POS. Oldest night first. */
export function nightsCsv(state, { now }) {
  const nights = new Map();
  const nightOf = (t) => {
    const bd = businessDateOf(t);
    const k = bd.getTime();
    if (!nights.has(k)) nights.set(k, { bd, played: 0, ms: 0, full: 0, coupons: 0, coupon: 0, charged: 0, voided: 0, running: 0, games: [], byFloor: { Downstairs: 0, Upstairs: 0 }, voidedCents: 0 });
    return nights.get(k);
  };
  for (const w of state.waitHistory ?? []) nightOf(w.addedAt); // nights with waits but no games still get a row
  for (const s of state.sessions) {
    const n = nightOf(s.start);
    n.games.push(s);
    if (s.voidedAt) { n.voided++; n.voidedCents += voidedValueCents(s); continue; }
    if (s.end == null) { n.running++; continue; }
    const c = sessionCharge(s, now);
    n.played++;
    n.ms += c.price.ms;
    n.full += c.fullCents;
    n.coupon += c.discountCents;
    if (s.discount) n.coupons++;
    n.charged += c.chargedCents;
    n.byFloor[floorName(state, s.tableId)] += c.chargedCents;
  }
  const rows = [...nights.values()]
    .sort((a, b) => a.bd - b.bd)
    .map((n) => {
      const w = waitStats(state, n.bd);
      const mins = (ms) => (w.seatedCount ? (ms / 60_000).toFixed(1) : "");
      return csvRow([
        ymd(n.bd), WEEKDAYS[n.bd.getDay()], n.played, (n.ms / 3_600_000).toFixed(2), dollars(n.full), n.coupons,
        dollars(n.coupon), dollars(n.charged), n.voided, n.running, floorsLabel(state, n.games),
        w.seatedCount, mins(w.averageMs), mins(w.longestMs), w.leftCount,
        dollars(n.byFloor.Downstairs), dollars(n.byFloor.Upstairs), dollars(n.voidedCents),
      ]);
    });
  return "﻿" + [csvRow(NIGHTS_HEADER), ...rows].join("\r\n") + "\r\n";
}

// ---------- Full backup ----------

export function backupJson(state, now) {
  return JSON.stringify({ app: "pool-tables", backupVersion: 1, hall: state.hall ?? "downstairs", exportedAt: now, state }, null, 1);
}

/** Read a backup file. Throws a staff-readable message if it isn't one. */
export function parseBackup(text, hallId = "downstairs") {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a Pool Tables backup.");
  }
  const s = data?.state;
  const ok =
    data?.app === "pool-tables" &&
    s && s.version === 1 &&
    Array.isArray(s.tables) && Array.isArray(s.sessions) && Array.isArray(s.waitlist) &&
    s.sessions.every((x) => typeof x.id === "string" && typeof x.tableId === "string" && Number.isFinite(x.start));
  if (!ok) throw new Error("That file isn't a Pool Tables backup, or it's damaged.");
  const from = data.hall ?? s.hall ?? "downstairs";
  if (hallId !== "any" && from !== hallId) {
    throw new Error(`That's a backup of the ${from} tables. Restore it in the ${from} app instead.`);
  }
  return { exportedAt: data.exportedAt, state: s };
}

// ---------- Handing a file to the iPad ----------

/**
 * Offer a file to the user. On the iPad this opens the share menu
 * (Numbers, Save to Files, AirDrop, Mail...). Elsewhere it downloads.
 * Must be called straight from a tap, before any await.
 */
export async function offerFile(filename, text, type) {
  const file = new File([text], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled";
      // Otherwise fall back to a download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

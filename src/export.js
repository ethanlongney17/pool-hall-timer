// Export (spreadsheet for Numbers/Excel) and full backup/restore.
// Everything here runs on the device: no internet needed.

import { priceSession, businessDateOf } from "./billing/pricing.js";

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

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(",");

export const CSV_HEADER = [
  "Night", "Day", "Table", "Customer", "Started", "Stopped", "Time played", "Minutes", "Rate", "Charge ($)", "Status",
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

  let totalCents = 0;
  const rows = sessions.map((s) => {
    const bd = businessDateOf(s.start);
    const running = s.end == null && !s.voidedAt;
    const end = running ? Math.max(now, s.start) : s.end;
    const price = priceSession(s.start, end);
    const rates = [...new Set(price.segments.map((seg) => `$${seg.centsPerHour / 100}/hr`))].join(" + ");
    const status = s.voidedAt ? `Void${s.voidReason ? ": " + s.voidReason : ""}` : running ? "Still running" : "Closed";
    const cents = s.voidedAt ? 0 : price.totalCents;
    if (!s.voidedAt && !running) totalCents += cents;
    return csvRow([
      ymd(bd), WEEKDAYS[bd.getDay()], tableName(s.tableId), s.name, dateTime(s.start),
      running ? "" : dateTime(end), hms(price.ms), (price.ms / 60000).toFixed(1), rates, dollars(cents), status,
    ]);
  });

  const lines = [csvRow(CSV_HEADER), ...rows];
  if (night) lines.push("", csvRow(["Total (closed tables)", "", "", "", "", "", "", "", "", dollars(totalCents), ""]));
  // The byte-order mark makes Excel read the file as UTF-8; Numbers ignores it.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------- Full backup ----------

export function backupJson(state, now) {
  return JSON.stringify({ app: "pool-tables", backupVersion: 1, exportedAt: now, state }, null, 1);
}

/** Read a backup file. Throws a staff-readable message if it isn't one. */
export function parseBackup(text) {
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

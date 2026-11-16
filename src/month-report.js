// Monthly report for the owners: one month on a page they can read, print or
// save as a PDF. reports/month/?m=2026-11 (defaults to the current month).
// Reads the same cloud records as Reports; changes nothing.

import { createCloudStore, friendlyError } from "./store/cloud-store.js";
import { nightSummaries, monthReport, monthsWithData, change, sampleState } from "./reports-data.js";
import { createDemoStore } from "./store/demo-store.js";
import { ALL_TABLES } from "./halls.js";
import { offerFile } from "./export.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (cents) => "$" + (Math.round(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyRound = (cents) => "$" + Math.round(cents / 100).toLocaleString();
const night = (d) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const shortDate = (d) => d.toLocaleDateString([], { month: "short", day: "numeric" });
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const monthName = (y, m) => new Date(y, m, 1).toLocaleDateString([], { month: "long", year: "numeric" });
const WD = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
function dur(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), isError ? 5000 : 2500);
}

let nights = null;
let months = [];
const params = new URLSearchParams(location.search);
let [year, month] = (params.get("m") || "").split("-").map(Number);
if (!year || !month) {
  const d = new Date();
  year = d.getFullYear();
  month = d.getMonth() + 1;
}
month -= 1; // 0-11 inside

function delta(now, before, { lowerIsBetter = false } = {}) {
  const c = change(now, before);
  if (c == null) return "";
  const pct = Math.round(c * 100);
  if (pct === 0) return `<span class="mr-delta">same as last month</span>`;
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return `<span class="mr-delta ${good ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs last month</span>`;
}

function render() {
  if (!nights) return;
  const now = Date.now();
  const r = monthReport(nights, year, month, now);
  const T = r.totals;
  const P = r.prev;
  document.title = `Monthly Report: ${monthName(year, month)}`;
  renderPicker();

  if (!T.games) {
    $("paper").innerHTML = `<header class="mr-head"><h1>${monthName(year, month)}</h1></header>
      <p class="mr-status">No games recorded in this month.${r.firstRecorded ? ` Records start ${night(r.firstRecorded)}.` : ""}</p>`;
    return;
  }

  const partialStart = r.firstRecorded && r.firstRecorded > r.from && r.firstRecorded < r.to;
  const notes = [
    r.inProgress ? `Month in progress: figures through ${night(new Date(r.through - 86_400_000))}. Compared with the same days of last month.` : "",
    partialStart ? `Records start ${night(r.firstRecorded)}, when the new system began, so earlier nights this month aren't included.` : "",
  ].filter(Boolean);
  const comparePrev = P ? "" : `<span class="mr-delta">no records for last month to compare</span>`;

  $("paper").innerHTML = `
    <header class="mr-head">
      <div>
        <div class="mr-kicker">Pool tables · monthly report</div>
        <h1>${monthName(year, month)}</h1>
      </div>
      <div class="mr-made">Prepared ${new Date(now).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</div>
    </header>
    ${notes.map((n) => `<p class="mr-note">${esc(n)}</p>`).join("")}

    <section class="mr-tiles">
      <div class="mr-tile hero"><span>Collected</span><b>${money(T.collected)}</b>${P ? delta(T.collected, P.collected) : comparePrev}
        <small>${T.nights} nights open · ${money(T.perNight)} per night</small></div>
      <div class="mr-tile"><span>Games played</span><b>${T.games.toLocaleString()}</b>${P ? delta(T.games, P.games) : ""}</div>
      <div class="mr-tile"><span>Average per game</span><b>${money(T.perGame)}</b>${P ? delta(T.perGame, P.perGame) : ""}</div>
      <div class="mr-tile"><span>Table-hours played</span><b>${Math.round(T.ms / 3_600_000).toLocaleString()}</b>${P ? delta(T.ms, P.ms) : ""}</div>
    </section>

    <section class="mr-grid">
      <div class="mr-box">
        <h2>Floors</h2>
        <dl>
          <dt>Downstairs</dt><dd>${money(T.downstairs)}</dd>
          <dt>Upstairs</dt><dd>${money(T.upstairs)} <small>${r.upstairsNights} night${r.upstairsNights === 1 ? "" : "s"} open · ${Math.round(T.upstairsShare * 100)}%</small></dd>
        </dl>
      </div>
      <div class="mr-box">
        <h2>Waitlist</h2>
        <dl>
          <dt>Average wait</dt><dd>${T.seated ? dur(T.avgWaitMs) : "—"} ${P && P.seated && T.seated ? delta(T.avgWaitMs, P.avgWaitMs, { lowerIsBetter: true }) : ""}</dd>
          <dt>Longest wait</dt><dd>${T.seated ? dur(T.longestMs) : "—"}</dd>
          <dt>Busiest waitlist</dt><dd>${T.peakWait.count ? `${T.peakWait.count} waiting <small>${night(T.peakWait.date)}, ${clock(T.peakWait.at)}</small>` : "—"}</dd>
          <dt>Seated from the list</dt><dd>${T.seated} <small>${T.left} taken off without the Seat button</small></dd>
        </dl>
      </div>
      <div class="mr-box">
        <h2>Highlights</h2>
        <dl>
          <dt>Best night</dt><dd>${night(r.best.date)} <small>${money(r.best.collected)}</small></dd>
          <dt>Quietest night</dt><dd>${night(r.quietest.date)} <small>${money(r.quietest.collected)}</small></dd>
          <dt>Strongest day</dt><dd>${r.bestWeekday ? `${WD[r.bestWeekday.weekday]} <small>${money(r.bestWeekday.avg)} average</small>` : "—"}</dd>
        </dl>
      </div>
      <div class="mr-box">
        <h2>Coupons and voids</h2>
        <dl>
          <dt>Half-hour coupons</dt><dd>${T.coupons} <small>${money(T.couponCents)} off</small></dd>
          <dt>Voided games</dt><dd>${T.voids} <small>${money(T.voidedCents)} not charged</small></dd>
        </dl>
      </div>
    </section>

    ${r.weeks.length > 1 ? `<section class="mr-section">
      <h2>Week by week</h2>
      <table class="mr-table"><thead><tr><th>Week</th><th>Nights</th><th>Games</th><th>Collected</th></tr></thead>
      <tbody>${r.weeks.map((w) => `<tr><td>${shortDate(w.start)} – ${shortDate(w.end)}</td><td>${w.nights}</td><td>${w.games}</td><td>${money(w.collected)}</td></tr>`).join("")}</tbody></table>
    </section>` : ""}

    <section class="mr-section">
      <h2>Night by night</h2>
      <table class="mr-table"><thead><tr><th>Night</th><th>Collected</th><th>Games</th><th>Hours</th><th>Upstairs</th><th>Coupons</th><th>Voids</th><th>Avg wait</th><th>Busiest list</th></tr></thead>
      <tbody>${r.nights.map((n) => `<tr><td>${night(n.date)}</td><td>${money(n.collected)}</td><td>${n.games}</td><td>${(n.ms / 3_600_000).toFixed(1)}</td>
        <td>${n.byFloor.upstairs ? money(n.byFloor.upstairs) : "—"}</td><td>${n.coupons || "—"}</td><td>${n.voids || "—"}</td>
        <td>${n.seated ? dur(n.waitMs / n.seated) : "—"}</td><td>${n.peakWait.count ? `${n.peakWait.count} at ${clock(n.peakWait.at)}` : "—"}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total</td><td>${money(T.collected)}</td><td>${T.games}</td><td>${(T.ms / 3_600_000).toFixed(1)}</td><td>${money(T.upstairs)}</td>
        <td>${T.coupons}</td><td>${T.voids}</td><td>${T.seated ? dur(T.avgWaitMs) : "—"}</td><td>${T.peakWait.count || "—"}</td></tr></tfoot></table>
    </section>

    <p class="mr-foot">Charges are worked out from each game's times at the posted rates, rounded to the nearest $0.25 per table, after coupons. A night runs 6am to 6am. Average wait counts parties seated with the waitlist's Seat button.</p>`;
}

function renderPicker() {
  const list = months.some((m) => m.year === year && m.month === month) ? months : [{ year, month }, ...months];
  $("monthPick").innerHTML = list.map((m) => `<option value="${m.year}-${m.month + 1}" ${m.year === year && m.month === month ? "selected" : ""}>${monthName(m.year, m.month)}</option>`).join("");
  $("prevMonth").disabled = !months.some((m) => m.year * 12 + m.month < year * 12 + month);
  $("nextMonth").disabled = !months.some((m) => m.year * 12 + m.month > year * 12 + month);
}

function goTo(y, m) {
  year = y;
  month = m;
  history.replaceState(null, "", `?m=${y}-${String(m + 1).padStart(2, "0")}${new URLSearchParams(location.search).has("demo") ? "&demo" : ""}`);
  render();
}
$("monthPick").addEventListener("change", (e) => {
  const [y, m] = e.target.value.split("-").map(Number);
  goTo(y, m - 1);
});
$("prevMonth").addEventListener("click", () => {
  const older = months.filter((m) => m.year * 12 + m.month < year * 12 + month)[0];
  if (older) goTo(older.year, older.month);
});
$("nextMonth").addEventListener("click", () => {
  const newer = months.filter((m) => m.year * 12 + m.month > year * 12 + month).pop();
  if (newer) goTo(newer.year, newer.month);
});
$("printBtn").addEventListener("click", () => {
  try {
    window.print();
  } catch {
    toast("Printing isn't available here. In Safari use Share → Print, then pinch out to save a PDF.", true);
  }
});
$("csvBtn").addEventListener("click", () => {
  if (!nights) return;
  const r = monthReport(nights, year, month, Date.now());
  const head = ["Night", "Collected ($)", "Games", "Hours played", "Downstairs ($)", "Upstairs ($)", "Coupons used", "Coupons ($)",
    "Voided", "Voided ($)", "Seated from waitlist", "Average wait (min)", "Peak waitlist", "Peak at"];
  const rows = r.nights.map((n) => [n.key, (n.collected / 100).toFixed(2), n.games, (n.ms / 3_600_000).toFixed(2),
    (n.byFloor.downstairs / 100).toFixed(2), (n.byFloor.upstairs / 100).toFixed(2), n.coupons, (n.couponCents / 100).toFixed(2),
    n.voids, (n.voidedCents / 100).toFixed(2), n.seated, n.seated ? (n.waitMs / n.seated / 60000).toFixed(1) : "",
    n.peakWait.count, n.peakWait.at ? clock(n.peakWait.at) : ""]);
  const csv = "﻿" + [head, ...rows].map((x) => x.join(",")).join("\r\n") + "\r\n";
  offerFile(`pool-monthly-report-${year}-${String(month + 1).padStart(2, "0")}.csv`, csv, "text/csv").catch((e) => toast(e.message, true));
});

// Leaving for another page of the app: close the database first.
let store = null;
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-leave]");
  if (!a) return;
  e.preventDefault();
  (store ? store.shutdown() : Promise.resolve()).finally(() => (location.href = a.href));
});

window.__monthReady = true;
if (new URLSearchParams(location.search).has("demo")) {
  // Practice mode: sample months plus tonight's practice night; never the cloud.
  for (const a of document.querySelectorAll("a[data-leave]")) a.href += "?demo";
  const night = createDemoStore().get();
  const sample = sampleState(Date.now(), ALL_TABLES);
  nights = nightSummaries({ ...night, sessions: [...sample.sessions, ...night.sessions], waitHistory: [...sample.waitHistory, ...night.waitHistory] }, Date.now());
  months = monthsWithData(nights);
  document.body.insertAdjacentHTML("afterbegin", '<div class="demo-banner no-print">PRACTICE MODE: made-up figures, not the real records.</div>');
  render();
} else store = createCloudStore({
  memoryCache: true,
  onAuthChange: async (user) => {
    if (!user) {
      $("paper").innerHTML = `<p class="mr-status">Sign in on the Reports page first: <a data-leave href="../">open Reports</a>.</p>`;
      return;
    }
    try {
      const all = await store.loadAll({ full: true });
      nights = nightSummaries(all, Date.now());
      months = monthsWithData(nights);
      render();
    } catch (e) {
      $("paper").innerHTML = `<p class="mr-status">Couldn't load the records: ${esc(friendlyError(e))} Check the connection and reopen.</p>`;
    }
  },
  onError: (msg) => toast(msg, true),
});

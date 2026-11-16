// Owners' Reports page: every night recorded, with period totals, trends and
// comparisons. Reads the same cloud records as the staff apps; changes nothing.
//
// reports/?demo shows made-up sample nights (clearly labelled) so the page can
// be shown before real history builds up. It doesn't touch the cloud.

import { createCloudStore, friendlyError } from "./store/cloud-store.js";
import { createDemoStore } from "./store/demo-store.js";
import { ALL_TABLES, FLOORS, floorOf, floorsInPlay, onlyFloors } from "./halls.js";
import { businessDateOf } from "./billing/pricing.js";
import {
  daySummary, tableStatus, activeSession, activeReservation, isPaused, pausedMs, waitEstimates, peakWaitlist,
} from "./model.js";
import {
  nightSummaries, PERIODS, periodRange, inRange, totals, change, byWeekday, busyHours, revenueBars, sampleState, nightKey, byMonth,
} from "./reports-data.js";
import { offerFile } from "./export.js";
import { makeManager, findManager, hasManagers } from "./pin.js";
import { newId } from "./model.js";

const $ = (id) => document.getElementById(id);
const demo = new URLSearchParams(location.search).has("demo");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- Formatting ----------
const money = (cents) => "$" + Math.round(cents / 100).toLocaleString();
const moneyExact = (cents) => "$" + (Math.round(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_LONG = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const fmtNight = (d) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const fmtShort = (d) => d.toLocaleDateString([], { month: "short", day: "numeric" });
const fmtMonth = (d) => d.toLocaleDateString([], { month: "short", year: "2-digit" });
function shortDur(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
}
const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Month by month: what the owners compare most.
function monthsCard(cur) {
  const months = byMonth(cur.filter((n) => n.games || n.seated || n.left || n.peakWait.count));
  if (!months.length) return "";
  const rows = [...months].reverse().map((m) => `<tr>
    <td><a data-leave href="month/?m=${m.month.getFullYear()}-${String(m.month.getMonth() + 1).padStart(2, "0")}${demo ? "&demo" : ""}">${m.month.toLocaleDateString([], { month: "long", year: "numeric" })} ↗</a></td><td>${moneyExact(m.collected)}</td><td>${m.nights}</td>
    <td>${moneyExact(m.perNight)}</td><td>${m.games}</td><td>${m.seated ? shortDur(m.avgWaitMs) : "—"}</td>
    <td>${m.peakWait.count ? `${m.peakWait.count} <span class="muted">${fmtShort(m.peakWait.date)}</span>` : "—"}</td></tr>`).join("");
  return `<section class="nights-card">
    <h2>Month by month</h2>
    <div class="nights-scroll"><table class="nights-table">
      <thead><tr><th>Month</th><th>Collected</th><th>Nights</th><th>Per night</th><th>Games</th><th>Avg wait</th><th>Busiest list</th></tr></thead>
      <tbody>${rows}</tbody></table></div></section>`;
}

const hourLabel = (h) => (h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`);
const PREV_LABEL = {
  7: "vs the 7 nights before", 30: "vs the 30 nights before", month: "vs the same days last month",
  lastmonth: "vs the month before", year: "vs the same days last year",
};

let toastTimer;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), isError ? 5000 : 2500);
}

// ---------- State ----------
let period = "30";
try { period = localStorage.getItem("reports.period") || "30"; } catch {}
if (!PERIODS.some((p) => p.id === period)) period = "30";
let allState = null; // every record ever (or the sample)
let store = null;

// ---------- Period buttons ----------
function renderPeriods() {
  $("periods").innerHTML = PERIODS.map((p) =>
    `<button type="button" data-period="${p.id}" aria-pressed="${p.id === period}">${p.label}</button>`).join("");
}
$("periods").addEventListener("click", (e) => {
  const b = e.target.closest("[data-period]");
  if (!b) return;
  period = b.dataset.period;
  try { localStorage.setItem("reports.period", period); } catch {}
  renderPeriods();
  render();
});

// ---------- The report ----------
function deltaHtml(now, before, { lowerIsBetter = false } = {}) {
  const c = change(now, before);
  if (c == null) return "";
  const pct = Math.round(c * 100);
  if (pct === 0) return `<span class="delta flat">No change ${PREV_LABEL[period]}</span>`;
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return `<span class="delta ${good ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% <span class="flat">${PREV_LABEL[period]}</span></span>`;
}

function render() {
  if (!allState) return;
  const now = Date.now();
  const nights = nightSummaries(allState, now);
  const r = periodRange(period, now);
  const cur = inRange(nights, r);
  const T = totals(cur);
  const P = r.prev ? totals(inRange(nights, r.prev)) : null;
  const d = (key, opts) => (P ? deltaHtml(T[key], P[key], opts) : "");
  const label = PERIODS.find((p) => p.id === period).label;
  $("subtitle").textContent = `Both floors · ${label.toLowerCase()} · ${T.nights} night${T.nights === 1 ? "" : "s"} with games`;
  // Say plainly when a period reaches back before the first recorded night.
  const first = nights.find((n) => n.games);
  const startNote = first && r.from < first.date
    ? `<p class="r-note">Records start ${fmtNight(first.date)}, when the new system began. Earlier nights were on the old program and aren't included${r.prev ? ", so comparisons with the period before only count from then" : ""}.</p>` : "";

  if (!T.games) {
    $("report").innerHTML = `      <p class="r-empty">No games recorded in this period yet. Records start from the day the two-floor version went live, plus any history uploaded from the iPads.</p>`;
    renderTonight();
    return;
  }

  $("report").innerHTML = `
        ${startNote}
    <section class="kpis" aria-label="Headline figures">
      <div class="kpi hero"><span class="k-label">Collected</span><span class="k-value">${money(T.collected)}</span>
        ${d("collected")}<span class="k-note">${money(T.perNight)} per night on average · after ${money(T.couponCents)} in coupons</span></div>
      <div class="kpi"><span class="k-label">Games played</span><span class="k-value">${T.games.toLocaleString()}</span>${d("games")}</div>
      <div class="kpi"><span class="k-label">Average per game</span><span class="k-value">${moneyExact(T.perGame)}</span>${d("perGame")}</div>
      <div class="kpi"><span class="k-label">Table-hours played</span><span class="k-value">${Math.round(T.ms / 3_600_000).toLocaleString()}</span>${d("ms")}</div>
      <div class="kpi"><span class="k-label">Average wait</span><span class="k-value">${T.seated ? shortDur(T.avgWaitMs) : "—"}</span>
        ${T.seated ? d("avgWaitMs", { lowerIsBetter: true }) : ""}<span class="k-note">${T.seated} seated from the waitlist · ${T.left} gave up</span></div>
      <div class="kpi"><span class="k-label">Busiest waitlist</span><span class="k-value">${T.peakWait.count ? `${T.peakWait.count} waiting` : "—"}</span>
        <span class="k-note">${T.peakWait.count ? `${fmtNight(T.peakWait.date)} at ${fmtClock(T.peakWait.at)}` : "No one on the waitlist in this period"}</span></div>
      <div class="kpi"><span class="k-label">Upstairs</span><span class="k-value">${money(T.upstairs)}</span>
        <span class="k-note">${Math.round(T.upstairsShare * 100)}% of collected</span></div>
      <div class="kpi"><span class="k-label">Coupons and voids</span><span class="k-value">${T.coupons} · ${T.voids}</span>
        <span class="k-note">${T.coupons} half-hour coupons (${money(T.couponCents)}) · ${T.voids} voided (${moneyExact(T.voidedCents)} not charged)</span></div>
    </section>

    <section class="charts">
      <div class="chart-card wide"><h2 id="revTitle">Collected</h2><div class="c-sub" id="revSub"></div>
        <div class="legend" id="revLegend"></div><div class="chart" id="revChart"></div></div>
      <div class="chart-card"><h2>Average night by day of the week</h2><div class="c-sub">Collected per night, nights with games only</div>
        <div class="chart" id="wdChart"></div></div>
      <div class="chart-card"><h2>Busiest hours</h2><div class="c-sub">Average number of tables in use</div>
        <div class="chart" id="hourChart"></div></div>
    </section>

    ${monthsCard(cur)}

    <section class="nights-card">
      <h2>Every night</h2>
      <div class="nights-scroll">${nightsTable(cur, T)}</div>
    </section>

    <p class="r-foot">Charges are worked out from each game's times with the same rates as the staff apps, so these match the nightly totals.
      Games still running count once they're closed. A night runs 6am to 6am, so after-midnight play belongs to the night before.</p>`;
  renderTonight();
  drawCharts(cur, r);
}

function nightsTable(cur, T) {
  const rows = [...cur].filter((n) => n.games || n.seated || n.left).reverse().map((n) => `<tr>
    <td>${fmtNight(n.date)}</td><td>${moneyExact(n.collected)}</td><td>${n.games}</td><td>${(n.ms / 3_600_000).toFixed(1)}</td>
    <td>${moneyExact(n.byFloor.downstairs)}</td><td>${n.byFloor.upstairs ? moneyExact(n.byFloor.upstairs) : "—"}</td>
    <td>${n.coupons ? `${n.coupons} · ${moneyExact(n.couponCents)}` : "—"}</td><td>${n.voids ? `${n.voids} · ${moneyExact(n.voidedCents)}` : "—"}</td>
    <td>${n.seated ? shortDur(n.waitMs / n.seated) : "—"}</td>
    <td>${n.peakWait.count ? `${n.peakWait.count} <span class="muted">at ${fmtClock(n.peakWait.at)}</span>` : "—"}</td><td>${n.left || "—"}</td></tr>`).join("");
  return `<table class="nights-table">
    <thead><tr><th>Night</th><th>Collected</th><th>Games</th><th>Hours</th><th>Downstairs</th><th>Upstairs</th><th>Coupons</th><th>Voids</th><th>Avg wait</th><th>Peak list</th><th>Gave up</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>Total</td><td>${moneyExact(T.collected)}</td><td>${T.games}</td><td>${(T.ms / 3_600_000).toFixed(1)}</td>
      <td>${moneyExact(T.downstairs)}</td><td>${moneyExact(T.upstairs)}</td><td>${T.coupons} · ${moneyExact(T.couponCents)}</td><td>${T.voids} · ${moneyExact(T.voidedCents)}</td>
      <td>${T.seated ? shortDur(T.avgWaitMs) : "—"}</td><td>${T.peakWait.count || "—"}</td><td>${T.left}</td></tr></tfoot></table>`;
}

// Tonight so far, live from the staff apps (not in the sample).
// ---------- Right now (live) ----------
// For the owners checking in from their phones: how busy it is this minute,
// tonight's money so far, and a small map of every table. Updates live from
// the same records the iPads write.

const STATUS_LABEL = { running: "Playing", paused: "Paused", free: "Free", reserved: "Reserved", cleaning: "Cleaning" };

function fmtWait(ms) {
  if (ms == null) return "";
  if (ms <= 0) return "a table is free now";
  const lo = Math.max(5, Math.ceil(ms / 300_000) * 5);
  return lo >= 60 ? `about ${Math.floor(lo / 60)}h ${String(lo % 60).padStart(2, "0")}m` : `about ${lo}–${lo + 5} min`;
}

function renderTonight() {
  const el = $("tonight");
  if (!el || !store) return;
  const now = Date.now();
  const live = store.get();
  const open = live.upstairsOpen;
  const floors = floorsInPlay(open);
  const inPlay = onlyFloors(live, floors);
  const s = daySummary(live, businessDateOf(now), now);
  const statusOf = (t) => {
    const st = tableStatus(live, t.id, now);
    return st === "running" && isPaused(activeSession(live, t.id)) ? "paused" : st;
  };
  const counts = { running: 0, paused: 0, free: 0, reserved: 0, cleaning: 0 };
  for (const t of inPlay.tables) counts[statusOf(t)]++;
  const inUse = counts.running + counts.paused;
  const estimates = waitEstimates(inPlay, now);
  const peak = peakWaitlist(live, businessDateOf(now), now);
  const tile = (t) => {
    const st = statusOf(t);
    const g = activeSession(live, t.id);
    const r = st === "reserved" ? activeReservation(live, t.id, now) : null;
    const detail = g ? shortDur(now - g.start - pausedMs(g, now)) : r?.name ? esc(r.name) : STATUS_LABEL[st];
    return `<div class="map-tile ${st}" title="${esc(t.name)}: ${STATUS_LABEL[st]}"><b>${esc(t.name.replace("Table ", ""))}</b><span>${detail}</span></div>`;
  };
  const floorMap = (f) => {
    const ts = live.tables.filter((t) => floorOf(live, t.id) === f);
    return `<div class="map-floor"><div class="map-label">${FLOORS[f].name}${f === "upstairs" && !open ? " · closed" : ""}</div>
      <div class="map-grid">${ts.map(tile).join("")}</div></div>`;
  };
  el.innerHTML = `
    <div class="live-head"><h2>Right now</h2><span class="live-dot">● Live</span>
      <span class="muted">updated ${new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>
    <div class="live-stats">
      <div><span>Tables in use</span><b>${inUse} <small>of ${inPlay.tables.length}</small></b>
        <small>${counts.free} free${counts.reserved ? ` · ${counts.reserved} reserved` : ""}${counts.cleaning ? ` · ${counts.cleaning} cleaning` : ""}${counts.paused ? ` · ${counts.paused} paused` : ""}${open ? "" : " · upstairs closed"}</small></div>
      <div><span>Waitlist</span><b>${live.waitlist.length} <small>waiting</small></b>
        <small>New party: ${fmtWait(estimates[estimates.length - 1])}${peak.count ? ` · busiest tonight ${peak.count} at ${new Date(peak.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</small></div>
      <div><span>Tonight so far</span><b>${moneyExact(s.closedTotalCents)}</b>
        <small>collected from ${s.closed.length} games · ${moneyExact(s.openRunningCents)} more on running tables</small></div>
    </div>
    <div class="live-map">${floorMap("downstairs")}${floorMap("upstairs")}</div>`;
}

// ---------- Charts ----------
// Plain SVG column charts: thin bars with rounded tops, a 2px gap between
// stacked floors, a recessive grid, a legend for two series, and a tooltip
// on hover or tap.

function drawCharts(cur, r) {
  const { unit, bars } = revenueBars(cur, r);
  const hasUp = bars.some((b) => b.upstairs);
  $("revTitle").textContent = `Collected per ${unit}`;
  $("revSub").textContent = hasUp ? "Downstairs and upstairs, stacked" : "Downstairs (upstairs had no games in this period)";
  $("revLegend").innerHTML = hasUp
    ? `<span><i style="background:var(--series-1)"></i>Downstairs</span><span><i style="background:var(--series-2)"></i>Upstairs</span>` : "";
  const xLabel = (b) => (unit === "month" ? fmtMonth(b.label) : unit === "week" ? fmtShort(b.label) : `${WD[b.label.getDay()]} ${b.label.getDate()}`);
  columnChart($("revChart"), {
    height: 240,
    series: hasUp ? ["var(--series-1)", "var(--series-2)"] : ["var(--series-1)"],
    bands: bars.map((b) => {
      const games = b.nights.reduce((a, n) => a + n.games, 0);
      const title = unit === "month" ? b.label.toLocaleDateString([], { month: "long", year: "numeric" })
        : unit === "week" ? `Week of ${fmtShort(b.label)}` : fmtNight(b.label);
      return {
        label: xLabel(b),
        values: hasUp ? [b.downstairs, b.upstairs] : [b.downstairs],
        tip: `<b>${title}</b>
          ${hasUp ? `<div class="row"><span><i style="background:var(--series-1)"></i>Downstairs</span><span>${moneyExact(b.downstairs)}</span></div>
          <div class="row"><span><i style="background:var(--series-2)"></i>Upstairs</span><span>${moneyExact(b.upstairs)}</span></div>` : ""}
          <div class="row"><span>Total</span><span>${moneyExact(b.downstairs + b.upstairs)}</span></div>
          <div class="row"><span>Games</span><span>${games}</span></div>`,
      };
    }),
    yFmt: money,
  });

  const wd = byWeekday(cur);
  const order = [1, 2, 3, 4, 5, 6, 0];
  columnChart($("wdChart"), {
    height: 200,
    series: ["var(--series-1)"],
    labelMax: true,
    bands: order.map((i) => ({
      label: WD[i],
      values: [wd[i].avg],
      tip: `<b>${WD_LONG[i]}</b><div class="row"><span>Average night</span><span>${moneyExact(wd[i].avg)}</span></div>
        <div class="row"><span>Nights</span><span>${wd[i].nights}</span></div>`,
    })),
    yFmt: money,
  });

  let hours = busyHours(cur);
  const first = hours.findIndex((h) => h.tables >= 0.05);
  const last = hours.length - 1 - [...hours].reverse().findIndex((h) => h.tables >= 0.05);
  hours = first >= 0 ? hours.slice(first, last + 1) : [];
  columnChart($("hourChart"), {
    height: 200,
    series: ["var(--series-1)"],
    labelMax: true,
    bands: hours.map((h) => ({
      label: hourLabel(h.hour),
      values: [h.tables],
      tip: `<b>${hourLabel(h.hour)}–${hourLabel((h.hour + 1) % 24)}</b>
        <div class="row"><span>Tables in use</span><span>${h.tables.toFixed(1)} on average</span></div>`,
    })),
    yFmt: (v) => (v >= 10 ? Math.round(v) : v.toFixed(v % 1 ? 1 : 0)),
    valueFmt: (v) => v.toFixed(1),
  });
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function columnChart(el, { bands, series, height, yFmt, valueFmt, labelMax = false }) {
  el._args = { bands, series, height, yFmt, valueFmt, labelMax };
  const W = Math.max(280, el.clientWidth || 600);
  const H = height;
  const m = { top: 18, right: 8, bottom: 26, left: 52 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(0, ...bands.map((b) => b.values.reduce((a, v) => a + v, 0))));
  const y = (v) => m.top + ih - (v / max) * ih;
  const band = bands.length ? iw / bands.length : iw;
  const bw = Math.max(3, Math.min(24, band * 0.62));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const every = Math.max(1, Math.ceil(bands.length / Math.floor(iw / 46)));
  const maxIdx = bands.reduce((bi, b, i, a) => (b.values[0] > a[bi].values[0] ? i : bi), 0);

  const roundTop = (x, top, w, h) => {
    const r = Math.min(4, w / 2, h);
    return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
  };
  let marks = "";
  bands.forEach((b, i) => {
    const x = m.left + i * band + (band - bw) / 2;
    let base = 0;
    const nonzero = b.values.map((v, k) => (v > 0 ? k : -1)).filter((k) => k >= 0);
    b.values.forEach((v, k) => {
      if (v <= 0) return;
      const top = y(base + v);
      const bottom = y(base) - (base > 0 ? 2 : 0); // 2px gap between stacked floors
      const h = Math.max(0, bottom - top);
      const isTop = k === nonzero[nonzero.length - 1];
      marks += isTop
        ? `<path d="${roundTop(x, top, bw, h)}" fill="${series[k]}"/>`
        : `<rect x="${x}" y="${top}" width="${bw}" height="${h}" fill="${series[k]}"/>`;
      base += v;
    });
    if (labelMax && i === maxIdx && b.values[0] > 0) {
      marks += `<text class="val" x="${x + bw / 2}" y="${y(base) - 5}" text-anchor="middle">${(valueFmt ?? yFmt)(b.values[0])}</text>`;
    }
  });
  const grid = ticks.map((t) => `<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}"/>
    <text x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end">${yFmt(t)}</text>`).join("");
  const xl = bands.map((b, i) => (i % every ? "" : `<text x="${m.left + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`)).join("");
  const hits = bands.map((b, i) => `<rect class="hit" data-i="${i}" x="${m.left + i * band}" y="${m.top}" width="${band}" height="${ih}"/>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Column chart">
    <g class="axis">${grid}${xl}</g><rect class="band-hl" width="0" height="${ih}" y="${m.top}"/>${marks}${hits}</svg>`;

  const svg = el.querySelector("svg");
  const hl = el.querySelector(".band-hl");
  const tip = $("tip");
  const show = (e) => {
    const r = e.target.closest(".hit");
    if (!r) return;
    const i = Number(r.dataset.i);
    hl.setAttribute("x", m.left + i * band);
    hl.setAttribute("width", band);
    tip.innerHTML = bands[i].tip;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = e.clientX + 14;
    if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, e.clientY - th - 12)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    hl.setAttribute("width", 0);
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const id of ["revChart", "wdChart", "hourChart"]) {
      const el = $(id);
      if (el?._args) columnChart(el, el._args);
    }
  }, 150);
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".chart")) $("tip").hidden = true;
});

// ---------- Export ----------
$("exportBtn").addEventListener("click", () => {
  if (!allState) return;
  const now = Date.now();
  const cur = inRange(nightSummaries(allState, now), periodRange(period, now)).filter((n) => n.games || n.seated || n.left);
  const head = ["Night", "Day", "Collected ($)", "Games", "Hours played", "Downstairs ($)", "Upstairs ($)", "Coupons used", "Coupons ($)",
    "Voided", "Voided ($)", "Seated from waitlist", "Average wait (min)", "Longest wait (min)", "Gave up", "Peak waitlist", "Peak at"];
  const rows = cur.map((n) => [nightKey(n.date), WD_LONG[n.weekday].slice(0, -1), (n.collected / 100).toFixed(2), n.games,
    (n.ms / 3_600_000).toFixed(2), (n.byFloor.downstairs / 100).toFixed(2), (n.byFloor.upstairs / 100).toFixed(2), n.coupons,
    (n.couponCents / 100).toFixed(2), n.voids, (n.voidedCents / 100).toFixed(2), n.seated, n.seated ? (n.waitMs / n.seated / 60000).toFixed(1) : "",
    n.seated ? (n.longestMs / 60000).toFixed(1) : "", n.left, n.peakWait.count, n.peakWait.at ? fmtClock(n.peakWait.at) : ""]);
  const csv = "﻿" + [head, ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
  offerFile(`pool-hall-report-${period}-${nightKey(new Date())}.csv`, csv, "text/csv").catch((e) => toast(e.message, true));
});

// ---------- Loading ----------
async function load(full = false) {
  if (demo) {
    // Past nights are sample data; tonight is the practice night (shared with
    // the practice staff app in other tabs).
    const sample = sampleState(Date.now(), ALL_TABLES);
    const night = store.get();
    allState = { ...night, sessions: [...sample.sessions, ...night.sessions], waitHistory: [...sample.waitHistory, ...night.waitHistory] };
    render();
    return;
  }
  $("refreshBtn").disabled = true;
  if (!allState) showStep("Loading every night from the cloud…");
  const loadTimer = setTimeout(() => !allState && showStuck("loading the records from the cloud"), 25_000);
  try {
    allState = await store.loadAll({ full });
    render();
  } catch (e) {
    const msg = friendlyError(e);
    toast(msg, true);
    if (!allState) {
      $("report").innerHTML = `<p class="r-empty">Couldn't load the records: ${esc(msg)} Check the connection, then tap Refresh.</p>`;
    }
  } finally {
    clearTimeout(loadTimer);
    $("refreshBtn").disabled = false;
  }
}

// What the page is doing while it loads, and a clear message if a step takes
// too long, so a problem on one device can be pinned down.
function showStep(text) {
  if (!allState) $("report").innerHTML = `<p class="r-loading">${esc(text)}</p>`;
}
function showStuck(step) {
  if (allState) return;
  $("report").innerHTML = `<div class="r-note">
    <p><b>This is taking too long.</b> The page got stuck ${esc(step)}.</p>
    <p>Check the Wi-Fi, then tap Try again. If it keeps happening on this iPad, open the reports in Safari instead:
      <b>ethanlongney17.github.io/pool-hall-timer/reports/</b></p>
    <p><button class="btn primary" type="button" id="retryBtn">Try again</button></p></div>`;
  $("retryBtn").addEventListener("click", () => location.reload());
}

// Leaving for the staff app: close the database first (see main.js).
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-leave]");
  if (!a) return;
  e.preventDefault();
  (store ? store.shutdown() : Promise.resolve()).finally(() => (location.href = a.href));
});
// Refresh fetches everything again, so it also fixes anything a device missed.
$("refreshBtn").addEventListener("click", () => load(true));

// ---------- Sign-in ----------
const login = document.createElement("div");
login.className = "login";
login.hidden = true;
login.innerHTML = `<form class="login-card" id="loginForm">
  <h2>Pool Hall Reports</h2>
  <p class="sub">Sign in with the staff account to see the records.</p>
  <label for="loginEmail">Email</label>
  <input id="loginEmail" type="email" autocomplete="username" autocapitalize="off" required>
  <label for="loginPassword">Password</label>
  <input id="loginPassword" type="password" autocomplete="current-password" required>
  <button class="btn primary big" type="submit" id="loginBtn">Sign in</button>
  <div class="login-error" id="loginError" role="alert"></div>
</form>`;
document.body.append(login);
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  $("loginBtn").disabled = true;
  try {
    await store.signIn($("loginEmail").value, $("loginPassword").value);
    $("loginPassword").value = "";
  } catch (err) {
    $("loginError").textContent = friendlyError(err);
  } finally {
    $("loginBtn").disabled = false;
  }
});

// ---------- Manager PINs ----------
// Adding or removing a manager needs an existing manager's PIN (except the
// very first one). Removing the last manager isn't allowed, so voids can
// always be approved.

function renderManagers() {
  if (!store) return;
  const managers = store.get().managers ?? {};
  const any = hasManagers(managers);
  $("managers").hidden = false;
  $("approveLabel").hidden = !any;
  $("approvePin").hidden = !any;
  $("mgrList").innerHTML = any
    ? Object.entries(managers).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, m]) => `<li>
        <span><b>${esc(m.name)}</b> <span class="muted">added ${new Date(m.addedAt).toLocaleDateString()}</span></span>
        <button class="btn small" type="button" data-remove="${id}">Remove</button></li>`).join("")
    : `<li class="muted">No managers yet. Add the first one below (no approval needed for the first).</li>`;
}

$("mgrForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("mgrError");
  err.textContent = "";
  try {
    const managers = store.get().managers ?? {};
    if (hasManagers(managers) && !(await findManager(managers, $("approvePin").value))) {
      throw new Error("The approving PIN isn't right.");
    }
    if (await findManager(managers, $("newMgrPin").value)) throw new Error("Someone already has that PIN. Choose another.");
    const record = await makeManager($("newMgrName").value, $("newMgrPin").value);
    store.addManager(newId(), record);
    for (const id of ["newMgrName", "newMgrPin", "approvePin"]) $(id).value = "";
    toast(`${record.name} added as a manager`);
  } catch (ex) {
    err.textContent = ex.message;
  }
});

$("mgrList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  const id = b.dataset.remove;
  const managers = store.get().managers ?? {};
  if (Object.keys(managers).length <= 1) return toast("Add another manager before removing the last one", true);
  const li = b.closest("li");
  if (li.querySelector(".remove-confirm")) return;
  li.insertAdjacentHTML("beforeend", `<form class="remove-confirm">
    <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="Another manager's PIN" aria-label="Approving PIN">
    <button class="btn small danger" type="submit">Confirm removal</button></form>`);
  const form = li.querySelector(".remove-confirm");
  form.querySelector("input").focus();
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const approver = await findManager(managers, form.querySelector("input").value);
    if (!approver || approver.id === id) return toast("Needs a different manager's PIN", true);
    const name = managers[id].name;
    store.removeManager(id);
    toast(`${name} removed`);
  });
});

window.__reportsReady = true; // tells the page's watchdog this script loaded
renderPeriods();
if (demo) {
  $("demoBanner").hidden = false;
  store = createDemoStore();
  $("liveBox").hidden = false;
  for (const a of document.querySelectorAll("a[data-leave]")) a.href += a.href.includes("?") ? "&demo" : "?demo";
  store.subscribe(() => {
    renderTonight();
    load();
  });
  setInterval(renderTonight, 20_000);
  load();
  renderManagers();
} else {
  showStep("Checking this device's sign-in…");
  const authTimer = setTimeout(() => showStuck("checking this device's sign-in"), 20_000);
  store = createCloudStore({
    memoryCache: true,
    onAuthChange: (user) => {
      clearTimeout(authTimer);
      login.hidden = !!user;
      $("liveBox").hidden = !user;
      $("who").hidden = !user;
      if (user) {
        $("who").innerHTML = `Signed in as ${esc(user.email)} <button class="btn link" type="button" id="signOutBtn">Sign out</button>`;
        // Two taps: signing out here signs out this whole device, including the
        // staff app if this is the iPad behind the counter.
        $("signOutBtn").addEventListener("click", (e) => {
          const b = e.currentTarget;
          if (!b.dataset.armed) {
            b.dataset.armed = "1";
            b.textContent = "Tap again to sign out this device (and its staff app, if any)";
            setTimeout(() => { delete b.dataset.armed; b.textContent = "Sign out"; }, 5000);
            return;
          }
          store.signOut().then(() => location.reload());
        });
      }
      if (user) load();
      else showStep("Sign in to see the records.");
    },
    onError: (msg) => toast(msg, true),
  });
  store.subscribe(() => {
    renderTonight();
    if (!document.querySelector(".remove-confirm")) renderManagers();
  });
  setInterval(renderTonight, 20_000);
}

import { createLocalStore } from "./store/local-store.js";
import { currentHall } from "./halls.js";
import { activeSession, daySummary, sessionCharge, couponRate, isPaused, pausedMs, waitEstimates, waitStats } from "./model.js";
import { rateAt, businessDateOf, formatCents, formatDuration } from "./billing/pricing.js";
import { sessionsCsv, nightsCsv, backupJson, parseBackup, offerFile, ymd } from "./export.js";

// Shown in the status bar so staff can tell which version the iPad is running.
export const APP_VERSION = "10";

const hall = currentHall();
const store = createLocalStore(hall);
document.title = hall.title;
document.querySelector(".brand").textContent = hall.title;
const $ = (id) => document.getElementById(id);
const sheet = $("sheet");
const sheetBody = $("sheetBody");

// ---------- Formatting ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtRate = (c) => `${formatCents(c).replace(/\.00$/, "")}/hr`;
const fmtDay = (d) => d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
function shortDur(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
const tableName = (id) => store.get().tables.find((t) => t.id === id)?.name ?? id;

// ---------- Feedback ----------

let toastTimer;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), isError ? 4000 : 2200);
}
function run(fn) {
  try {
    return fn();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), true);
  }
}
const act = (name, args) => store.dispatch(name, args);

// ---------- Live values (timers, running charges) ----------
// Anything with data-live is recomputed every second from stored start times.

function tick() {
  const now = Date.now();
  $("clock").textContent = new Date(now).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
  const w = rateAt(now);
  $("rate").textContent = `Now ${fmtRate(w.centsPerHour)} until ${fmtTime(w.end)}`;

  // Sessions are looked up by id so paused time is left out of timers and charges.
  const byId = new Map(store.get().sessions.map((s) => [s.id, s]));
  const charge = (id) => {
    const s = byId.get(id);
    return s ? sessionCharge(s, now) : null;
  };
  let estimates = null; // worked out once per tick, only if something shows one
  document.querySelectorAll("[data-live]").forEach((el) => {
    const ids = (el.dataset.sessions || "").split(",").filter(Boolean);
    switch (el.dataset.live) {
      case "elapsed": {
        const c = charge(ids[0]);
        if (c) el.textContent = formatDuration(c.price.ms);
        break;
      }
      case "wait":
        el.textContent = shortDur(now - Number(el.dataset.starts));
        break;
      case "estimate": {
        estimates ??= waitEstimates(store.get(), now);
        el.textContent = fmtEstimate(estimates[Number(el.dataset.position)], el.dataset.style);
        break;
      }
      case "charge": {
        const base = Number(el.dataset.base || 0);
        const cents = ids.reduce((a, id) => a + (charge(id)?.chargedCents ?? 0), base);
        el.textContent = formatCents(cents);
        break;
      }
    }
  });
}

// ---------- Main screen ----------

function renderTables(state) {
  $("tables").innerHTML = state.tables
    .map((t) => {
      const s = activeSession(state, t.id);
      if (!s) {
        return `<button class="table-card free" data-table="${t.id}">
          <span class="t-name">${esc(t.name)}</span><span class="t-state">Available</span></button>`;
      }
      const paused = isPaused(s);
      return `<button class="table-card busy${paused ? " paused" : ""}" data-table="${t.id}">
        <span class="t-name">${esc(t.name)}${paused ? ` <span class="paused-tag">Paused</span>` : ""}</span>
        <span class="t-who">${esc(s.name)}</span>
        <span class="t-time" data-live="elapsed" data-sessions="${s.id}"></span>
        <span class="t-charge" data-live="charge" data-sessions="${s.id}"></span></button>`;
    })
    .join("");
}

// Estimates are rounded up to 5 minutes and said as a range staff can quote.
function fmtEstimate(ms, style) {
  if (ms == null) return "";
  if (ms <= 0) return style === "new" ? "A table is free now" : "table free now";
  const lo = Math.max(5, Math.ceil(ms / 300_000) * 5);
  const text = lo >= 60 ? `${Math.floor(lo / 60)}h ${String(lo % 60).padStart(2, "0")}m` : `${lo}–${lo + 5} min`;
  return style === "new" ? `Wait for a new party: about ${text}` : `Est. wait ${text}`;
}

let newWaitEl;
function renderWaitlist(state) {
  if (!newWaitEl) {
    newWaitEl = document.createElement("div");
    newWaitEl.className = "wait-new";
    $("waitForm").after(newWaitEl);
  }
  newWaitEl.innerHTML = `<span data-live="estimate" data-position="${state.waitlist.length}" data-style="new"></span>`;
  $("waitCount").textContent = state.waitlist.length ? `(${state.waitlist.length})` : "";
  $("waitList").innerHTML = state.waitlist.length
    ? state.waitlist
        .map(
          (w, i) => `<li class="wait-item">
        <div style="min-width:0"><div class="wait-name">${esc(w.name)}</div>
          <div class="wait-meta">${w.note ? esc(w.note) + " · " : ""}waiting <span data-live="wait" data-starts="${w.addedAt}"></span></div>
          <div class="wait-est" data-live="estimate" data-position="${i}"></div></div>
        <button class="btn small primary" data-wait-act="seat" data-id="${w.id}">Seat</button>
        <button class="btn small" data-wait-act="remove" data-id="${w.id}" aria-label="Remove ${esc(w.name)}">✕</button>
      </li>`,
        )
        .join("")
    : `<li class="empty">No one waiting.</li>`;
}

function renderStatus(state) {
  const now = Date.now();
  const sum = daySummary(state, businessDateOf(now), now);
  const running = state.tables.filter((t) => activeSession(state, t.id));
  const openIds = sum.open.map((s) => s.id).join(",");
  const pausedCount = running.filter((t) => isPaused(activeSession(state, t.id))).length;
  $("status").innerHTML = `
    <span>Tables running: <b>${running.length}</b> of ${state.tables.length}${pausedCount ? ` (${pausedCount} paused)` : ""}</span>
    <span>Waiting: <b>${state.waitlist.length}</b></span>
    <span>Tonight so far: <b data-live="charge" data-base="${sum.closedTotalCents}" data-sessions="${openIds}"></b></span>
    ${store.kind === "local" ? `<span class="warn">Saved on this device only</span>` : ""}
    <span class="version">Version ${APP_VERSION}</span>`;
}

function renderAll() {
  const state = store.get();
  renderTables(state);
  renderWaitlist(state);
  renderStatus(state);
  if (sheet.open && current?.refresh) showSheet(current);
  tick();
}

// ---------- Sheets (pop-up panels) ----------

let current = null; // { render(): html, handlers: {}, refresh?: bool, mounted?() }

function showSheet(spec) {
  current = spec;
  sheetBody.innerHTML = spec.render();
  spec.mounted?.();
  if (!sheet.open) sheet.showModal();
  tick();
}
function closeSheet() {
  if (sheet.open) sheet.close();
}
// The close event arrives a moment after close(); if another panel opened in
// between, it must keep working, so only forget the panel if none is showing.
sheet.addEventListener("close", () => {
  if (!sheet.open) current = null;
});
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) return closeSheet(); // tap outside the panel
  const el = e.target.closest("[data-act]");
  if (!el || !current) return;
  const fn = el.dataset.act === "close" ? closeSheet : current.handlers?.[el.dataset.act];
  if (fn) run(() => fn(el.dataset));
});

const head = (title, sub = "") => `
  <div class="sheet-head"><div><h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ""}</div>
  <button class="btn ghost close-x" data-act="close" aria-label="Close">✕</button></div>`;

function freeTables() {
  const state = store.get();
  return state.tables.filter((t) => !activeSession(state, t.id));
}

function showOpen(tableId) {
  const waitlist = store.get().waitlist;
  const start = (name) => {
    act("openTable", { tableId, name });
    closeSheet();
    toast(`${tableName(tableId)} started`);
  };
  showSheet({
    render: () => `<div class="sheet">
      ${head(`Open ${esc(tableName(tableId))}`, `Rate now: ${fmtRate(rateAt(Date.now()).centsPerHour)}`)}
      <form id="openForm" autocomplete="off"><input id="openName" placeholder="Customer name (optional)" maxlength="40" enterkeyhint="go"></form>
      <button class="btn primary big" data-act="start">Start timer</button>
      ${waitlist.length ? `<div class="sub" style="margin-top:4px">Or seat someone from the waitlist:</div>
        <div class="choices">${waitlist.map((w) => `<button class="btn chip" data-act="seat" data-id="${w.id}">${esc(w.name)}</button>`).join("")}</div>` : ""}
    </div>`,
    mounted: () =>
      $("openForm").addEventListener("submit", (e) => {
        e.preventDefault();
        run(() => start($("openName").value));
      }),
    handlers: {
      start: () => start($("openName").value),
      seat: ({ id }) => {
        act("seatFromWaitlist", { waitId: id, tableId });
        closeSheet();
        toast(`${tableName(tableId)} started`);
      },
    },
  });
}

function showRunning(tableId) {
  const s = activeSession(store.get(), tableId);
  if (!s) return;
  const paused = isPaused(s);
  const pausedAt = paused ? s.pauses[s.pauses.length - 1].from : null;
  const pausedSoFar = pausedMs(s, Date.now());
  showSheet({
    render: () => `<div class="sheet">
      ${head(esc(tableName(tableId)), `${s.name ? esc(s.name) + " · " : ""}Started ${fmtTime(s.start)}`)}
      ${paused ? `<div class="paused-banner">Timer paused at ${fmtTime(pausedAt)}. Not being charged.</div>` : ""}
      <div class="big-num ${paused ? "paused-num" : "amber"}" data-live="elapsed" data-sessions="${s.id}"></div>
      <dl class="kv"><dt>${paused ? "Total so far" : "Charge so far"}</dt><dd data-live="charge" data-sessions="${s.id}"></dd>
        <dt>Rate now</dt><dd>${fmtRate(rateAt(Date.now()).centsPerHour)}</dd>
        ${pausedSoFar >= 1000 && !paused ? `<dt>Paused so far</dt><dd>${formatDuration(pausedSoFar)}</dd>` : ""}</dl>
      ${paused
        ? `<button class="btn primary big" data-act="resume">Resume timer</button>`
        : `<button class="btn big pause" data-act="pause">Pause timer</button>`}
      <button class="btn danger big" data-act="stop">Stop timer &amp; close table</button>
      <div class="row">
        <button class="btn" data-act="move">Move to another table</button>
        <button class="btn" data-act="rename">${s.name ? "Edit name" : "Add name"}</button>
      </div>
      <button class="btn link" data-act="void">Opened by mistake? Void this table</button>
    </div>`,
    handlers: {
      pause: () => {
        act("pauseTable", { tableId });
        showRunning(tableId);
        toast(`${tableName(tableId)} paused`);
      },
      resume: () => {
        act("resumeTable", { tableId });
        showRunning(tableId);
        toast(`${tableName(tableId)} resumed`);
      },
      stop: () => {
        act("closeTable", { tableId });
        showReceipt(s.id);
      },
      move: () => showMove(tableId),
      rename: () => {
        const name = prompt("Customer name", s.name);
        if (name == null) return;
        act("renameSession", { sessionId: s.id, name });
        showRunning(tableId);
      },
      void: () => showVoid(s.id),
    },
  });
}

function receiptLines(price) {
  return price.segments
    .map(
      (seg) => `<div><span>${fmtTime(seg.start)}–${fmtTime(seg.end)} · ${seg.ms < 60_000 ? `${Math.round(seg.ms / 1000)}s` : shortDur(seg.ms)} @ ${fmtRate(seg.centsPerHour)}</span>
        <span>${formatCents(seg.cents)}</span></div>`,
    )
    .join("");
}

function showReceipt(sessionId, { back } = {}) {
  const s = store.get().sessions.find((x) => x.id === sessionId);
  if (!s || s.end == null) return closeSheet();
  const c = sessionCharge(s, Date.now());
  const halfHourOff = Math.min(c.fullCents, Math.round(couponRate(c.price) / 2));
  const done = back ? `<button class="btn primary big" data-act="back">Back to totals</button>`
    : `<button class="btn primary big" data-act="close">Done</button>`;
  showSheet({
    render: () => `<div class="sheet">
      ${head(`${esc(tableName(s.tableId))} ${s.voidedAt ? "voided" : "closed"}`, s.name ? esc(s.name) : "")}
      ${s.discount ? `<div class="was">${formatCents(c.fullCents)}</div>` : ""}
      <div class="big-num">${formatCents(c.chargedCents)}</div>
      ${s.discount ? `<div class="coupon-tag">${esc(s.discount.label)} applied: −${formatCents(c.discountCents)}</div>` : ""}
      <dl class="kv"><dt>Time played</dt><dd>${formatDuration(c.price.ms)}</dd>
        ${pausedMs(s, s.end) >= 1000 ? `<dt>Paused (not charged)</dt><dd>${formatDuration(pausedMs(s, s.end))}</dd>` : ""}
        <dt>Started</dt><dd>${fmtTime(s.start)}</dd><dt>Stopped</dt><dd>${fmtTime(s.end)}</dd></dl>
      <div class="lines">${receiptLines(c.price)}
        ${s.discount ? `<div><span>${esc(s.discount.label)} (${s.discount.minutes
          ? `${s.discount.minutes} min at ${fmtRate(couponRate(c.price))}`
          : `${s.discount.percent}% off`})</span><span>−${formatCents(c.discountCents)}</span></div>` : ""}</div>
      ${s.voidedAt ? "" : s.discount
        ? `<button class="btn" data-act="uncoupon">Remove coupon</button>`
        : `<button class="btn coupon" data-act="coupon">Apply half-hour coupon (−${formatCents(halfHourOff)})</button>`}
      ${done}
      ${back || s.voidedAt ? "" : `<button class="btn link" data-act="reopen">Closed by mistake? Reopen table</button>`}
    </div>`,
    handlers: {
      coupon: () => {
        act("applyDiscount", { sessionId, minutes: 30, label: "Half-hour coupon" });
        showReceipt(sessionId, { back });
        toast("Half-hour coupon applied");
      },
      uncoupon: () => {
        act("removeDiscount", { sessionId });
        showReceipt(sessionId, { back });
        toast("Coupon removed");
      },
      back: () => back?.(),
      reopen: () => {
        act("reopenSession", { sessionId });
        closeSheet();
        toast(`${tableName(s.tableId)} reopened`);
      },
    },
  });
}

function showMove(fromTableId) {
  const free = freeTables();
  showSheet({
    render: () => `<div class="sheet">
      ${head(`Move ${esc(tableName(fromTableId))}`, "The timer and charge carry over to the new table.")}
      ${free.length ? `<div class="choices">${free.map((t) => `<button class="btn chip" data-act="to" data-id="${t.id}">${esc(t.name)}</button>`).join("")}</div>`
        : `<div class="empty">No free tables.</div>`}
      <button class="btn" data-act="back">Back</button>
    </div>`,
    handlers: {
      to: ({ id }) => {
        act("moveSession", { fromTableId, toTableId: id });
        closeSheet();
        toast(`Moved to ${tableName(id)}`);
      },
      back: () => showRunning(fromTableId),
    },
  });
}

function showVoid(sessionId) {
  const s = store.get().sessions.find((x) => x.id === sessionId);
  showSheet({
    render: () => `<div class="sheet">
      ${head(`Void ${esc(tableName(s.tableId))}?`, "Use this only if the table was opened by mistake. No charge is recorded; it stays in today's list as voided.")}
      <input id="voidReason" placeholder="Reason (optional)" maxlength="80">
      <button class="btn danger big" data-act="confirm">Void — no charge</button>
      <button class="btn" data-act="back">Back</button>
    </div>`,
    handlers: {
      confirm: () => {
        act("voidSession", { sessionId, reason: $("voidReason").value });
        closeSheet();
        toast("Table voided");
      },
      back: () => showRunning(s.tableId),
    },
  });
}

function showSeat(waitId) {
  const w = store.get().waitlist.find((x) => x.id === waitId);
  if (!w) return;
  const free = freeTables();
  if (!free.length) return toast("No free tables right now", true);
  showSheet({
    render: () => `<div class="sheet">
      ${head(`Seat ${esc(w.name)}`, "Pick a table. Its timer starts right away.")}
      <div class="choices">${free.map((t) => `<button class="btn chip" data-act="to" data-id="${t.id}">${esc(t.name)}</button>`).join("")}</div>
    </div>`,
    handlers: {
      to: ({ id }) => {
        act("seatFromWaitlist", { waitId, tableId: id });
        closeSheet();
        toast(`${w.name} seated at ${tableName(id)}`);
      },
    },
  });
}

function showToday(dayOffset = 0) {
  showSheet({
    refresh: true,
    render: () => {
      const now = Date.now();
      const day = businessDateOf(now);
      day.setDate(day.getDate() + dayOffset);
      const sum = daySummary(store.get(), day, now);
      const openIds = sum.open.map((s) => s.id).join(",");
      const row = (s, cls = "") => `<tr class="tap ${cls}" data-act="receipt" data-id="${s.id}"><td>${esc(tableName(s.tableId))}</td><td>${esc(s.name)}</td>
        <td>${fmtTime(s.start)}–${fmtTime(s.end)}</td><td>${formatDuration(s.price.ms)}</td>
        <td class="amt">${cls ? "void" : `${s.discount ? `<span class="half">coupon</span> ` : ""}${formatCents(s.charge.chargedCents)}`}</td></tr>`;
      return `<div class="sheet">
        ${head(dayOffset === 0 ? "Tonight's totals" : "Totals", `${fmtDay(day)} (6am to 6am)`)}
        <div class="big-num">${formatCents(sum.closedTotalCents)}</div>
        <div class="sub" style="margin-top:-4px">collected from ${sum.closed.length} closed table${sum.closed.length === 1 ? "" : "s"} · ${formatDuration(sum.totalMs)} played</div>
        ${waitSummaryHtml(day)}
        ${sum.couponCount ? `<dl class="kv"><dt>Before coupons</dt><dd>${formatCents(sum.fullTotalCents)}</dd>
          <dt>Coupons used (${sum.couponCount})</dt><dd>−${formatCents(sum.couponCents)}</dd></dl>` : ""}
        ${sum.open.length ? `<dl class="kv"><dt>Still running (${sum.open.length})</dt><dd data-live="charge" data-sessions="${openIds}"></dd>
          <dt>Total if all closed now</dt><dd data-live="charge" data-base="${sum.closedTotalCents}" data-sessions="${openIds}"></dd></dl>` : ""}
        <div class="report"><table><thead><tr><th>Table</th><th>Name</th><th>Time</th><th>Played</th><th class="amt">Charged</th></tr></thead>
          <tbody>${sum.closed.map((s) => row(s)).join("")}${sum.voided.map((s) => row({ ...s, end: s.end }, "void")).join("")}
          ${sum.closed.length + sum.voided.length ? "" : `<tr><td colspan="5" class="empty">Nothing closed yet.</td></tr>`}</tbody></table></div>
        ${sum.closed.length ? `<div class="sub">Tap a row to see its receipt or add a coupon.</div>` : ""}
        <div class="row"><button class="btn" data-act="prev">◀ Previous day</button>
          <button class="btn" data-act="next" ${dayOffset >= 0 ? "disabled" : ""}>Next day ▶</button></div>
        <div class="export">
          <div class="export-title">Save a copy for Numbers or Files (works without Wi-Fi)</div>
          <div class="row">
            <button class="btn" data-act="csvNight">Export this night</button>
            <button class="btn" data-act="csvAll">Export every table, all nights</button>
          </div>
          <button class="btn" data-act="csvNights">Export nightly totals (one row per night, for the POS)</button>
          <div class="row">
            <button class="btn" data-act="backup">Save full backup</button>
            <button class="btn" data-act="restore">Restore from backup…</button>
          </div>
        </div>
      </div>`;
    },
    handlers: {
      receipt: ({ id }) => showReceipt(id, { back: () => showToday(dayOffset) }),
      prev: () => showToday(dayOffset - 1),
      next: () => dayOffset < 0 && showToday(dayOffset + 1),
      csvNight: () => {
        const night = businessDateOf(Date.now());
        night.setDate(night.getDate() + dayOffset);
        const csv = sessionsCsv(store.get(), { night, now: Date.now() });
        return saveAndReport(`${hall.filePrefix}-${ymd(night)}.csv`, csv, "text/csv");
      },
      csvAll: () => {
        const csv = sessionsCsv(store.get(), { now: Date.now() });
        return saveAndReport(`${hall.filePrefix}-all-nights-to-${ymd(new Date())}.csv`, csv, "text/csv");
      },
      csvNights: () => {
        const csv = nightsCsv(store.get(), { now: Date.now() });
        return saveAndReport(`${hall.filePrefix}-nightly-totals-to-${ymd(new Date())}.csv`, csv, "text/csv");
      },
      backup: () => {
        const now = new Date();
        const stamp = `${ymd(now)}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
        return saveAndReport(`${hall.filePrefix}-backup-${stamp}.json`, backupJson(store.get(), now.getTime()), "application/json");
      },
      restore: () => $("restoreInput").click(),
    },
  });
}

function waitSummaryHtml(day) {
  const w = waitStats(store.get(), day);
  if (!w.seatedCount && !w.leftCount) return "";
  return `<dl class="kv"><dt>Waitlist</dt><dd>${w.seatedCount} seated${w.leftCount ? `, ${w.leftCount} left` : ""}</dd>
    ${w.seatedCount ? `<dt>Average wait</dt><dd>${shortDur(w.averageMs)}</dd><dt>Longest wait</dt><dd>${shortDur(w.longestMs)}</dd>` : ""}</dl>`;
}

async function saveAndReport(filename, text, type) {
  try {
    const how = await offerFile(filename, text, type);
    if (how === "downloaded") toast(`Saved ${filename}`);
  } catch (e) {
    toast(`Couldn't save the file: ${e.message}`, true);
  }
}

$("restoreInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const { exportedAt, state } = parseBackup(await file.text(), hall.id);
    const when = exportedAt ? new Date(exportedAt).toLocaleString() : "an unknown date";
    const ok = confirm(
      `Replace everything on this iPad with the backup from ${when}?\n\n` +
        `It has ${state.sessions.length} table sessions and ${state.waitlist.length} waitlist names. ` +
        `Anything recorded here since that backup will be lost.`,
    );
    if (!ok) return;
    store.replaceAll(state);
    closeSheet();
    toast("Backup restored");
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Wiring ----------

$("tables").addEventListener("click", (e) => {
  const card = e.target.closest("[data-table]");
  if (!card) return;
  const id = card.dataset.table;
  run(() => (activeSession(store.get(), id) ? showRunning(id) : showOpen(id)));
});

$("waitForm").addEventListener("submit", (e) => {
  e.preventDefault();
  run(() => {
    act("waitlistAdd", { name: $("waitName").value, note: $("waitNote").value });
    $("waitName").value = "";
    $("waitNote").value = "";
    $("waitName").blur();
    $("waitNote").blur();
  });
});

$("waitList").addEventListener("click", (e) => {
  const el = e.target.closest("[data-wait-act]");
  if (!el) return;
  const { id } = el.dataset;
  const w = store.get().waitlist.find((x) => x.id === id);
  if (!w) return;
  if (el.dataset.waitAct === "seat") return run(() => showSeat(id));
  if (confirm(`Remove ${w.name} from the waitlist? (Recorded as left without a table.)`)) run(() => act("waitlistRemove", { id }));
});

$("todayBtn").addEventListener("click", () => run(() => showToday(0)));

store.subscribe(renderAll);
renderAll();
setInterval(tick, 1000);
// The status bar's day boundary and totals can change with time alone.
setInterval(() => {
  renderStatus(store.get());
  tick();
}, 60_000);

// ---------- Updates ----------
// Check for a new version when the app opens and whenever it comes back to the
// screen. When one arrives, reload to use it, but never in the middle of a
// pop-up: wait until it's closed. Saved data isn't affected by a reload.

if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker
    .register(new URL("../sw.js", import.meta.url), { updateViaCache: "none" })
    .then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch((e) => console.warn("Offline support unavailable", e));

  let reloading = false;
  const reloadForUpdate = () => {
    if (reloading) return;
    if (sheet.open) return sheet.addEventListener("close", reloadForUpdate, { once: true });
    reloading = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) reloadForUpdate(); // first install needs no reload
  });
}

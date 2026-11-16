import { createCloudStore } from "./store/cloud-store.js";
import { currentHall, floorsShown, floorsInPlay, onlyFloors, floorOf, FLOORS } from "./halls.js";
import { activeSession, daySummary, sessionCharge, couponRate, isPaused, pausedMs, waitEstimates, waitStats, tableStatus, readyAlerts, activeReservation, recentWaitMs } from "./model.js";
import { rateAt, businessDateOf, formatCents, formatDuration } from "./billing/pricing.js";
import { sessionsCsv, nightsCsv, backupJson, parseBackup, offerFile, ymd } from "./export.js";
import { friendlyError } from "./store/cloud-store.js";
import { makeManager, findManager, hasManagers } from "./pin.js";
import { newId, voidedValueCents } from "./model.js";

// Shown in the status bar so staff can tell which version the iPad is running.
export const APP_VERSION = "20 (cloud)";

const hall = currentHall();
const store = createCloudStore({ onAuthChange: handleAuth, onError: (msg) => toast(msg, true) });

// What this app shows: downstairs shows upstairs too when it's open; the
// upstairs app shows only upstairs. Totals in the downstairs app cover the
// whole building; the upstairs app's cover upstairs.
const shownFloors = () => floorsShown(hall, store.get().upstairsOpen);
const shown = () => onlyFloors(store.get(), shownFloors());
const inPlay = () => onlyFloors(store.get(), floorsInPlay(store.get().upstairsOpen));
const scope = (state) => (hall.id === "upstairs" ? onlyFloors(state, ["upstairs"]) : state);
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
// A short message at the bottom. With `action`, it shows a button (Undo) and
// stays up a little longer so there's time to tap it.
function toast(msg, isError = false, action = null) {
  const el = $("toast");
  el.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-btn";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      el.className = "toast";
      run(action.fn);
    }, { once: true });
    el.append(b);
  }
  el.className = `toast show${isError ? " error" : ""}${action ? " has-action" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), action ? 6000 : isError ? 4000 : 2200);
}

// An "are you sure?" step drawn by the app itself. Browser pop-ups (confirm,
// prompt) can be blocked, so the app never relies on them.
function askSheet({ title, text = "", confirmLabel, danger = false, input = null, onConfirm, onBack }) {
  showSheet({
    render: () => `<div class="sheet">
      ${head(esc(title), text ? esc(text) : "")}
      ${input ? `<input id="askInput" value="${esc(input.value ?? "")}" placeholder="${esc(input.placeholder ?? "")}" maxlength="${input.max ?? 60}">` : ""}
      <button class="btn ${danger ? "danger" : "primary"} big" data-act="yes">${esc(confirmLabel)}</button>
      <button class="btn" data-act="no">${onBack ? "Back" : "Cancel"}</button>
    </div>`,
    mounted: () => {
      if (!input) return;
      const field = $("askInput");
      field.closest(".sheet").addEventListener("submit", (e) => e.preventDefault());
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") run(() => onConfirm(field.value));
      });
    },
    handlers: {
      yes: () => onConfirm(input ? $("askInput").value : undefined),
      no: () => (onBack ? onBack() : closeSheet()),
    },
  });
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
        estimates ??= waitEstimates(inPlay(), now);
        el.textContent = fmtEstimate(estimates[Number(el.dataset.position)], el.dataset.style);
        break;
      }
      case "recent": {
        const r = recentWaitMs(store.get(), now);
        el.textContent = r ? `Last ${r.count} parties seated waited about ${shortDur(r.ms)}` : "";
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
  const floors = shownFloors();
  const closedNote = hall.id === "upstairs" && !store.get().upstairsOpen
    ? `<div class="floor-note">Upstairs is marked closed, so downstairs can't see these tables or seat people here.
        <button class="btn small primary" data-upstairs="open">Open upstairs</button></div>` : "";
  const now = Date.now();
  const statuses = state.tables.map((t) => tableStatus(state, t.id, now));
  const freeCount = statuses.filter((x) => x === "free").length;
  const cleaningCount = statuses.filter((x) => x === "cleaning").length;
  const reservedCount = statuses.filter((x) => x === "reserved").length;
  const waiting = store.get().waitlist.length;
  const strip = `<div class="summary-strip">
    <span class="${freeCount ? "good" : ""}"><b>${freeCount}</b> table${freeCount === 1 ? "" : "s"} free</span>
    ${cleaningCount ? `<span><b>${cleaningCount}</b> being cleaned</span>` : ""}
    ${reservedCount ? `<span><b>${reservedCount}</b> reserved</span>` : ""}
    <span class="${waiting ? "warn" : ""}"><b>${waiting}</b> on the waitlist</span></div>`;
  $("tables").innerHTML = strip + readyBanner() + closedNote + floors.map((f) => {
    const heading = floors.length > 1 ? `<h3 class="floor-head">${FLOORS[f].name}</h3>` : "";
    return heading + state.tables.filter((t) => floorOf(state, t.id) === f).map(tableCard).join("");
  }).join("");
}

// Downstairs gets a flashing tile, a banner and a chime when the upstairs
// bartender marks a table ready; it stays until someone taps "Got it" or
// the table is used.
const alertsFor = () => (hall.id === "downstairs" ? readyAlerts(shown(), Date.now()) : []);

function readyBanner() {
  const alerts = alertsFor();
  if (!alerts.length) return "";
  const next = store.get().waitlist[0];
  return alerts.map((a) => `<div class="ready-banner">
      <span>✓ <b>${esc(tableName(a.tableId))}</b> is ready upstairs</span>
      ${next ? `<button class="btn small primary" data-ready-act="seat" data-table-id="${a.tableId}">Seat ${esc(next.name)}</button>` : ""}
      <button class="btn small" data-ready-act="ack" data-table-id="${a.tableId}">Got it</button>
    </div>`).join("");
}

let heardAlerts = null;
function chimeForNewAlerts() {
  const ids = new Set(alertsFor().map((a) => a.sessionId));
  const fresh = heardAlerts && [...ids].some((id) => !heardAlerts.has(id));
  heardAlerts = ids;
  if (fresh) chime();
}
// A short two-note chime. iPads only allow sound after someone has tapped
// the screen once since the app opened, which happens on any busy night.
let audioCtx;
function chime() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.3, t + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.4);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.18);
      o.stop(t + i * 0.18 + 0.45);
    });
  } catch {}
}
document.addEventListener("pointerdown", () => audioCtx?.resume?.(), { passive: true });

function tableCard(t) {
  const state = store.get();
  {
      const s = activeSession(state, t.id);
      if (!s) {
        const status = tableStatus(state, t.id, Date.now());
        if (status === "reserved") {
          const r = activeReservation(state, t.id, Date.now());
          return `<button class="table-card reserved" data-table="${t.id}">
            <span class="t-name">${esc(t.name)}</span>
            <span class="t-who">${r.name ? esc(r.name) : ""}</span>
            <span class="t-state">Reserved · prepaid</span></button>`;
        }
        if (status === "cleaning") {
          return `<button class="table-card cleaning" data-table="${t.id}">
            <span class="t-name">${esc(t.name)}</span>
            <span class="t-state">${hall.id === "upstairs" ? "Being cleaned · tap when ready" : "Being cleaned"}</span></button>`;
        }
        const alerting = alertsFor().some((a) => a.tableId === t.id);
        return `<button class="table-card free${alerting ? " ready-flash" : ""}" data-table="${t.id}">
          <span class="t-name">${esc(t.name)}</span><span class="t-state">${alerting ? "Ready ✓" : "Available"}</span></button>`;
      }
      const paused = isPaused(s);
      return `<button class="table-card busy${paused ? " paused" : ""}" data-table="${t.id}">
        <span class="t-name">${esc(t.name)}${paused ? ` <span class="paused-tag">Paused</span>` : ""}</span>
        <span class="t-who">${esc(s.name)}</span>
        <span class="t-time" data-live="elapsed" data-sessions="${s.id}"></span>
        <span class="t-charge" data-live="charge" data-sessions="${s.id}"></span></button>`;
  }
}

// Estimates are rounded up to 5 minutes and said as a range staff can quote.
function fmtEstimate(ms, style) {
  if (ms == null) return "";
  if (ms <= 0) return style === "new" ? "A table is free now" : "table free now";
  const lo = Math.max(5, Math.ceil(ms / 300_000) * 5);
  const text = lo >= 60 ? `${Math.floor(lo / 60)}h ${String(lo % 60).padStart(2, "0")}m` : `${lo}–${lo + 5} min`;
  return style === "new" ? `Estimated wait: about ${text}` : `Est. wait ${text}`;
}

let newWaitEl;
function renderWaitlist(state) {
  if (!newWaitEl) {
    newWaitEl = document.createElement("div");
    newWaitEl.className = "wait-new";
    $("waitForm").after(newWaitEl);
  }
  const n = state.waitlist.length;
  newWaitEl.innerHTML = `${n ? `<div class="wait-pos">A new party would be <b>#${n + 1}</b> on the list</div>` : ""}
    <div data-live="estimate" data-position="${n}" data-style="new"></div>
    <div class="wait-recent" data-live="recent"></div>`;
  $("waitCount").innerHTML = n ? `<span class="wait-count-big">${n}</span>` : "";
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

const SYNC_TEXT = {
  live: ["sync live", "● Live: all devices up to date"],
  offline: ["sync offline", "● Offline: saved here, will sync"],
  connecting: ["sync offline", "● Connecting…"],
  "signed-out": ["sync offline", "Not signed in"],
  denied: ["sync denied", "✕ NOT SAVING: the cloud refused access (check the database rules)"],
};

function renderStatus() {
  const now = Date.now();
  const state = shown();
  const sum = daySummary(scope(store.get()), businessDateOf(now), now);
  const running = state.tables.filter((t) => activeSession(state, t.id));
  const openIds = sum.open.map((s) => s.id).join(",");
  const pausedCount = running.filter((t) => isPaused(activeSession(state, t.id))).length;
  $("status").innerHTML = `
    <span>Tables running: <b>${running.length}</b> of ${state.tables.length}${pausedCount ? ` (${pausedCount} paused)` : ""}</span>
    <span>Waiting: <b>${state.waitlist.length}</b></span>
    <span>Tonight so far: <b data-live="charge" data-base="${sum.closedTotalCents}" data-sessions="${openIds}"></b></span>
    <span class="${SYNC_TEXT[store.syncStatus()][0]}">${SYNC_TEXT[store.syncStatus()][1]}</span>
    <span class="version">Version ${APP_VERSION}</span>`;
}

function renderAll() {
  chimeForNewAlerts();
  const state = shown();
  renderTables(state);
  renderWaitlist(state);
  renderStatus();
  renderUpstairsButton();
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
  const state = shown();
  const now = Date.now();
  return state.tables.filter((t) => tableStatus(state, t.id, now) === "free");
}

function showReserve(tableId) {
  askSheet({
    title: `Reserve ${tableName(tableId)} for tonight?`,
    text: "For prepaid bookings: no timer and no charge. The table is blocked on both iPads until you remove the reservation, or 6am.",
    confirmLabel: "Reserve table",
    input: { value: "", placeholder: "Name on the booking (optional)", max: 40 },
    onConfirm: (name) => {
      store.reserveTable(tableId, { name });
      closeSheet();
      toast(`${tableName(tableId)} reserved`, false, { label: "Undo", fn: () => store.unreserveTable(tableId) });
    },
    onBack: () => showOpen(tableId),
  });
}

function showReserved(tableId) {
  const r = activeReservation(store.get(), tableId, Date.now());
  if (!r) return showOpen(tableId);
  showSheet({
    render: () => `<div class="sheet">
      ${head(`${esc(tableName(tableId))}: reserved`, `${r.name ? `${esc(r.name)} · ` : ""}reserved at ${fmtTime(r.at)} · prepaid, no timer`)}
      <button class="btn primary big" data-act="unreserve">Remove reservation</button>
      <button class="btn" data-act="start">Start a timed game here anyway</button>
    </div>`,
    handlers: {
      unreserve: () => {
        const saved = { ...r };
        store.unreserveTable(tableId);
        closeSheet();
        toast(`${tableName(tableId)} is available again`, false, { label: "Undo", fn: () => store.reserveTable(tableId, saved) });
      },
      start: () => {
        store.unreserveTable(tableId);
        showOpen(tableId);
      },
    },
  });
}

function showCleaning(tableId) {
  const upstairsApp = hall.id === "upstairs";
  showSheet({
    render: () => `<div class="sheet">
      ${head(`${esc(tableName(tableId))}: being cleaned`, upstairsApp
        ? "Tap Table ready once it's cleaned. Downstairs gets a notice so they can send the next party up."
        : "The upstairs bartender will mark it ready once it's cleaned.")}
      <button class="btn primary big" data-act="ready">Table ready</button>
      <button class="btn" data-act="start">Start a game here anyway</button>
    </div>`,
    handlers: {
      ready: () => {
        act("markTableReady", { tableId });
        closeSheet();
        toast(`${tableName(tableId)} is ready${upstairsApp ? ". Downstairs has been told." : ""}`);
      },
      start: () => showOpen(tableId),
    },
  });
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
      <button class="btn" data-act="reserve">Reserve this table (prepaid, no timer)</button>
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
      reserve: () => showReserve(tableId),
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
      <button class="btn void-btn" data-act="void">Void (no charge, needs a manager PIN)</button>
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
      rename: () =>
        askSheet({
          title: `${s.name ? "Edit" : "Add"} name for ${tableName(tableId)}`,
          confirmLabel: "Save name",
          input: { value: s.name, placeholder: "Customer name", max: 40 },
          onConfirm: (name) => {
            act("renameSession", { sessionId: s.id, name });
            showRunning(tableId);
          },
          onBack: () => showRunning(tableId),
        }),
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

function showReceipt(sessionId, { back, from } = {}) {
  const live = store.get().sessions.some((x) => x.id === sessionId);
  const s = (from ? store.withHistory(from) : store.get()).sessions.find((x) => x.id === sessionId);
  if (!s || s.end == null) return closeSheet();
  const c = sessionCharge(s, Date.now());
  const halfHourOff = Math.min(c.fullCents, Math.round(couponRate(c.price) / 2));
  const done = back ? `<button class="btn primary big" data-act="back">Back to totals</button>`
    : `<button class="btn primary big" data-act="close">Done</button>`;
  showSheet({
    render: () => `<div class="sheet">
      ${head(`${esc(tableName(s.tableId))} ${s.voidedAt ? "voided" : "closed"}`, [s.name ? esc(s.name) : "",
        s.voidedAt ? `Voided${s.voidReason ? `: ${esc(s.voidReason)}` : ""}${s.voidApprovedBy ? ` · approved by ${esc(s.voidApprovedBy)}` : ""}` : ""].filter(Boolean).join(" · "))}
      ${s.discount ? `<div class="was">${formatCents(c.fullCents)}</div>` : ""}
      <div class="big-num">${formatCents(c.chargedCents)}</div>
      ${s.discount ? `<div class="coupon-tag">${esc(s.discount.label)} applied: −${formatCents(c.discountCents)}</div>` : ""}
      <dl class="kv"><dt>Time played</dt><dd>${formatDuration(c.price.ms)}</dd>
        ${pausedMs(s, s.end) >= 1000 ? `<dt>Paused (not charged)</dt><dd>${formatDuration(pausedMs(s, s.end))}</dd>` : ""}
        <dt>Started</dt><dd>${fmtTime(s.start)}</dd><dt>Stopped</dt><dd>${fmtTime(s.end)}</dd></dl>
      <div class="lines">${receiptLines(c.price)}
        ${s.discount ? `<div><span>${esc(s.discount.label)} (${s.discount.minutes
          ? `${s.discount.minutes} min at ${fmtRate(couponRate(c.price))}`
          : `${s.discount.percent}% off`})</span><span>−${formatCents(c.discountCents)}</span></div>` : ""}
        ${c.roundingCents ? `<div><span>Rounded to the nearest $0.25</span><span>${c.roundingCents > 0 ? "+" : "−"}${formatCents(Math.abs(c.roundingCents))}</span></div>` : ""}</div>
      ${s.voidedAt || !live ? "" : s.discount
        ? `<button class="btn" data-act="uncoupon">Remove coupon</button>`
        : `<button class="btn coupon" data-act="coupon">Apply half-hour coupon (−${formatCents(halfHourOff)})</button>`}
      ${done}
      ${s.voidedAt || !live ? "" : `<button class="btn void-btn" data-act="void">Void this game (needs a manager PIN)</button>`}
      ${back || s.voidedAt || !live ? "" : `<button class="btn link" data-act="reopen">Closed by mistake? Reopen table</button>`}
    </div>`,
    handlers: {
      coupon: () => {
        act("applyDiscount", { sessionId, minutes: 30, label: "Half-hour coupon" });
        showReceipt(sessionId, { back, from });
        toast("Half-hour coupon applied");
      },
      uncoupon: () => {
        act("removeDiscount", { sessionId });
        showReceipt(sessionId, { back, from });
        toast("Coupon removed");
      },
      back: () => back?.(),
      void: () => showVoid(sessionId, { back }),
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

// Voiding needs a manager's PIN. The first time, when no managers exist yet,
// it asks for a name and new PIN to create the first manager instead.
// More managers are added on the owners' Reports page.
function showVoid(sessionId, { back } = {}) {
  const s = store.get().sessions.find((x) => x.id === sessionId);
  if (!s || s.voidedAt) return closeSheet();
  const running = s.end == null;
  const firstManager = !hasManagers(store.get().managers);
  const charged = sessionCharge(s, Date.now()).chargedCents;
  const goBack = () => (running ? showRunning(s.tableId) : showReceipt(sessionId, { back }));
  showSheet({
    render: () => `<div class="sheet">
      ${head(`Void ${esc(tableName(s.tableId))}?`, running
        ? "No charge. The table is freed and the game stays in tonight's list as voided."
        : `No charge for this game (was ${formatCents(charged)}). If it was already paid, refund it on the POS too.`)}
      <input id="voidReason" placeholder="Reason (optional)" maxlength="80">
      ${firstManager ? `<div class="sub">No manager PINs are set up yet. Create the first manager to approve this void:</div>
        <input id="mgrName" placeholder="Manager's name" maxlength="30" autocomplete="off">
        <input id="mgrPin" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="New PIN (4–8 digits)" maxlength="8" autocomplete="off">`
        : `<input id="mgrPin" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="Manager PIN" maxlength="8" autocomplete="off">`}
      <div class="login-error" id="voidError" role="alert"></div>
      <button class="btn danger big" data-act="confirm">Void: no charge</button>
      <button class="btn" data-act="back">Back</button>
    </div>`,
    handlers: {
      confirm: async () => {
        const err = $("voidError");
        err.textContent = "";
        try {
          let approver;
          if (firstManager) {
            const record = await makeManager($("mgrName").value, $("mgrPin").value);
            store.addManager(newId(), record);
            approver = record.name;
          } else {
            const m = await findManager(store.get().managers, $("mgrPin").value);
            if (!m) {
              err.textContent = "That PIN isn't right. Ask a manager to enter theirs.";
              $("mgrPin").value = "";
              return;
            }
            approver = m.name;
          }
          act("voidSession", { sessionId, reason: $("voidReason").value, approvedBy: approver });
          closeSheet();
          toast(`${tableName(s.tableId)} voided, approved by ${approver}`, false, {
            label: "Undo", fn: () => act("unvoidSession", { sessionId }),
          });
        } catch (e) {
          err.textContent = e.message || String(e);
        }
      },
      back: goBack,
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
      const from = day.getTime();
      if (!store.hasHistory(from)) {
        store.loadHistory(from).then(() => current?.isToday && showToday(dayOffset)).catch((e) => toast(e.message, true));
        return `<div class="sheet">${head("Totals", `${fmtDay(day)} (6am to 6am)`)}
          <div class="empty">Getting that night from the cloud…</div>
          <div class="row"><button class="btn" data-act="prev">◀ Previous day</button>
          <button class="btn" data-act="next">Next day ▶</button></div></div>`;
      }
      const dayState = scope(store.withHistory(from));
      const sum = daySummary(dayState, day, now);
      const floorTotals = hall.id === "upstairs" ? [] : Object.values(FLOORS).map((f) => {
        const fs = daySummary(onlyFloors(dayState, [f.id]), day, now);
        return { name: f.name, cents: fs.closedTotalCents, count: fs.closed.length };
      });
      const openIds = sum.open.map((s) => s.id).join(",");
      const row = (s, cls = "") => `<tr class="tap ${cls}" data-act="receipt" data-id="${s.id}"><td>${esc(tableName(s.tableId))}</td><td>${esc(s.name)}</td>
        <td>${fmtTime(s.start)}–${fmtTime(s.end)}</td><td>${formatDuration(s.price.ms)}</td>
        <td class="amt">${cls ? `void · ${formatCents(voidedValueCents(s))}` : `${s.discount ? `<span class="half">coupon</span> ` : ""}${formatCents(s.charge.chargedCents)}`}</td></tr>`;
      return `<div class="sheet">
        ${head(dayOffset === 0 ? "Tonight's totals" : "Totals", `${fmtDay(day)} (6am to 6am)`)}
        <div class="big-num">${formatCents(sum.closedTotalCents)}</div>
        <div class="sub" style="margin-top:-4px">collected from ${sum.closed.length} closed table${sum.closed.length === 1 ? "" : "s"} · ${formatDuration(sum.totalMs)} played</div>
        ${floorTotals.some((f) => f.count && f.name === "Upstairs") ? `<dl class="kv">${floorTotals.map((f) =>
          `<dt>${f.name} (${f.count})</dt><dd>${formatCents(f.cents)}</dd>`).join("")}</dl>` : ""}
        ${waitSummaryHtml(day, dayState)}
        ${sum.couponCount ? `<dl class="kv"><dt>Before coupons</dt><dd>${formatCents(sum.fullTotalCents)}</dd>
          <dt>Coupons used (${sum.couponCount})</dt><dd>−${formatCents(sum.couponCents)}</dd></dl>` : ""}
        ${sum.voided.length ? `<dl class="kv"><dt>Voided (${sum.voided.length})</dt><dd>${formatCents(sum.voidedCents)} not charged</dd></dl>` : ""}
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
            <button class="btn" data-act="restore">Upload a backup file…</button>
          </div>
        </div>
        <a class="btn link" data-leave href="${new URL("../reports/", import.meta.url)}">Owners' reports: every night, trends and comparisons ↗</a>
        <button class="btn link" data-act="signout">Sign this device out</button>
      </div>`;
    },
    isToday: true,
    handlers: {
      receipt: ({ id }) => {
        const day = businessDateOf(Date.now());
        day.setDate(day.getDate() + dayOffset);
        showReceipt(id, { back: () => showToday(dayOffset), from: day.getTime() });
      },
      signout: () =>
        askSheet({
          title: "Sign this device out?",
          text: "Nothing is deleted. Someone will need the staff email and password to sign back in.",
          confirmLabel: "Sign out",
          danger: true,
          onConfirm: () => {
            closeSheet();
            store.signOut();
          },
          onBack: () => showToday(dayOffset),
        }),
      prev: () => showToday(dayOffset - 1),
      next: () => dayOffset < 0 && showToday(dayOffset + 1),
      csvNight: () => {
        const night = businessDateOf(Date.now());
        night.setDate(night.getDate() + dayOffset);
        const csv = sessionsCsv(scope(store.withHistory(night.getTime())), { night, now: Date.now() });
        return saveAndReport(`${hall.filePrefix}-${ymd(night)}.csv`, csv, "text/csv");
      },
      csvAll: () => withAllHistory((all) => {
        const csv = sessionsCsv(all, { now: Date.now() });
        return saveAndReport(`${hall.filePrefix}-all-nights-to-${ymd(new Date())}.csv`, csv, "text/csv");
      }),
      csvNights: () => withAllHistory((all) => {
        const csv = nightsCsv(all, { now: Date.now() });
        return saveAndReport(`${hall.filePrefix}-nightly-totals-to-${ymd(new Date())}.csv`, csv, "text/csv");
      }),
      backup: () => withAllHistory((all) => {
        const now = new Date();
        const stamp = `${ymd(now)}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
        return saveAndReport(`${hall.filePrefix}-backup-${stamp}.json`, backupJson(all, now.getTime()), "application/json");
      }),
      restore: () => $("restoreInput").click(),
    },
  });
}

// Saving needs the tap that asked for it (the iPad won't open the share menu
// later), so when older nights aren't on the device yet, fetch them first and
// ask for a second tap.
let fetchingAll = false;
function withAllHistory(fn) {
  if (store.hasHistory(0)) return fn(scope(store.withHistory(0)));
  if (fetchingAll) return toast("Still getting every night from the cloud…");
  fetchingAll = true;
  toast("Getting every night from the cloud…");
  store.loadHistory(0)
    .then(() => toast("Ready. Tap the button again to save."))
    .catch((e) => toast(e.message, true))
    .finally(() => (fetchingAll = false));
}

function waitSummaryHtml(day, state) {
  const w = waitStats(state, day);
  if (!w.seatedCount && !w.leftCount && !w.peakCount) return "";
  return `<dl class="kv"><dt>Waitlist</dt><dd>${w.seatedCount} seated${w.leftCount ? `, ${w.leftCount} left` : ""}</dd>
    ${w.peakCount ? `<dt>Busiest waitlist</dt><dd>${w.peakCount} waiting at ${fmtTime(w.peakAt)}</dd>` : ""}
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
    const { exportedAt, state } = parseBackup(await file.text(), "any");
    const when = exportedAt ? new Date(exportedAt).toLocaleString() : "an unknown date";
    askSheet({
      title: "Add this backup to the cloud?",
      text: `Backup from ${when} with ${state.sessions.length} games. Anything already in the cloud stays; nothing is deleted.`,
      confirmLabel: "Upload backup",
      onConfirm: () => {
        const n = store.importState(state);
        closeSheet();
        toast(`Uploaded ${n} records`);
      },
    });
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Wiring ----------

$("tables").addEventListener("click", (e) => {
  const card = e.target.closest("[data-table]");
  if (!card) return;
  const id = card.dataset.table;
  run(() => {
    const status = tableStatus(store.get(), id, Date.now());
    if (status === "running") return showRunning(id);
    if (status === "cleaning") return showCleaning(id);
    if (status === "reserved") return showReserved(id);
    if (alertsFor().some((a) => a.tableId === id)) act("ackTableReady", { tableId: id });
    showOpen(id);
  });
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
  // One tap: people give up all the time. A mis-tap can be undone.
  run(() => {
    act("waitlistRemove", { id });
    toast(`${w.name} removed from the waitlist`, false, { label: "Undo", fn: () => act("waitlistRestore", { id }) });
  });
});

$("todayBtn").addEventListener("click", () => run(() => showToday(0)));

// Going to another page of the app (Reports): close the database first, so
// the next page isn't left waiting on it (iPad Safari keeps it locked otherwise).
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-leave]");
  if (!a) return;
  e.preventDefault();
  store.shutdown().finally(() => (location.href = a.href));
});

// ---------- Upstairs open / closed (shared by every device) ----------

const upstairsBtn = document.createElement("button");
upstairsBtn.className = "btn ghost upstairs-btn";
$("todayBtn").before(upstairsBtn);
function renderUpstairsButton() {
  const open = store.get().upstairsOpen;
  upstairsBtn.textContent = open ? "Upstairs: open" : "Upstairs: closed";
  upstairsBtn.classList.toggle("on", open);
}
function setUpstairs(open) {
  if (!open) {
    const up = onlyFloors(store.get(), ["upstairs"]);
    const running = up.tables.filter((t) => activeSession(up, t.id)).length;
    if (running) return toast(`Close the ${running} upstairs table${running === 1 ? "" : "s"} first`, true);
  }
  store.setUpstairsOpen(open);
  toast(open ? "Upstairs is open" : "Upstairs is closed", false, { label: "Undo", fn: () => store.setUpstairsOpen(!open) });
}
upstairsBtn.addEventListener("click", () => run(() => setUpstairs(!store.get().upstairsOpen)));
$("tables").addEventListener("click", (e) => {
  if (e.target.closest("[data-upstairs=open]")) run(() => setUpstairs(true));
  const r = e.target.closest("[data-ready-act]");
  if (!r) return;
  const tableId = r.dataset.tableId;
  run(() => {
    act("ackTableReady", { tableId });
    if (r.dataset.readyAct === "seat") {
      const next = store.get().waitlist[0];
      if (!next) return;
      act("seatFromWaitlist", { waitId: next.id, tableId });
      toast(`${next.name} seated at ${tableName(tableId)}`);
    }
  });
});

// ---------- Sign-in ----------
// Each device signs in once with the business's staff account and stays
// signed in. Until then nothing can be read or changed.

const login = document.createElement("div");
login.className = "login";
login.hidden = true;
login.innerHTML = `<form class="login-card" id="loginForm">
  <h2>${esc(hall.title)}</h2>
  <p class="sub">Sign in once on this device with the staff account. It stays signed in.</p>
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

function handleAuth(user) {
  login.hidden = !!user;
  renderAll();
  if (user) moveLocalDataToCloud();
}

// Before the cloud, each app kept its data on its own iPad. The first time a
// device signs in, send what it saved up to the cloud (once), so no history
// is lost. Safe to run on every device: each record keeps its own id.
function moveLocalDataToCloud() {
  const doneKey = `${hall.storageKey}.movedToCloud`;
  let local;
  try {
    if (localStorage.getItem(doneKey)) return;
    local = JSON.parse(localStorage.getItem(hall.storageKey) || "null");
  } catch {
    return;
  }
  const count = local ? local.sessions.length + local.waitlist.length + (local.waitHistory?.length ?? 0) : 0;
  const markDone = () => {
    try { localStorage.setItem(doneKey, String(Date.now())); } catch {}
  };
  if (!count) return markDone();
  let tries = 0;
  const attempt = () => {
    // Wait until the cloud copy has loaded, so running tables aren't doubled up.
    if (store.syncStatus() === "connecting" && tries++ < 20) return setTimeout(attempt, 500);
    run(() => {
      const n = store.importState(local);
      markDone();
      toast(`Moved ${n} records from this iPad to the cloud`);
    });
  };
  attempt();
}

store.subscribe(renderAll);
renderAll();
setInterval(tick, 1000);
// The status bar's day boundary and totals can change with time alone.
setInterval(() => {
  renderStatus();
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

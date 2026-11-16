// Practice mode (?demo): the real app on a made-up busy night. Same screens and
// rules, but everything lives in this browser only (localStorage), so nothing
// ever reaches the real records in the cloud. Opening the downstairs, upstairs
// and Reports pages in practice mode in different tabs share the same night.
//
// Same interface as the cloud store, so the screens don't need to know.

import { actions } from "../model.js";
import { ALL_TABLES } from "../halls.js";
import { businessDateOf } from "../billing/pricing.js";
import { makeManager } from "../pin.js";

const KEY = "poolhall.demo.v1";
export const DEMO_PIN = "1234";
const MIN = 60_000;

/** A believable night in progress, built around `now`. */
export function demoNight(now = Date.now()) {
  // Keep everything inside tonight's 6am-to-6am night, even early in the day.
  const nightStart = businessDateOf(now).getTime() + 6 * 60 * MIN + MIN;
  const ago = (m) => Math.max(nightStart, now - m * MIN);
  let n = 0;
  const id = () => `demo-${++n}`;
  const sessions = [];
  const game = (tableId, startAgo, endAgo, extra = {}) => {
    const s = { id: id(), tableId, name: "", start: ago(startAgo), end: endAgo == null ? null : ago(endAgo), log: [], ...extra };
    if (s.end != null && s.end <= s.start) s.end = s.start + MIN;
    sessions.push(s);
    return s;
  };

  // Earlier tonight: finished games (also what the wait estimates learn from).
  const finished = [
    ["t1", 300, 230], ["t2", 290, 200], ["t3", 280, 215], ["t4", 270, 190], ["t5", 260, 205], ["t6", 255, 150],
    ["t7", 250, 185], ["t9", 240, 170], ["t10", 235, 160], ["t11", 230, 175], ["t1", 225, 150], ["t3", 210, 120],
    ["t5", 200, 140], ["t4", 185, 110], ["t7", 180, 95], ["u1", 175, 100], ["u2", 170, 85], ["u3", 165, 120],
  ];
  finished.forEach(([t, a, b], i) => game(t, a, b, i === 4 ? { discount: { minutes: 30, label: "Half-hour coupon", at: ago(b) } } : {}));
  game("t6", 140, 139, { voidedAt: ago(139), voidReason: "wrong table", voidApprovedBy: "Demo manager", wasRunning: true });

  // Right now: most tables playing.
  game("t1", 140, null, { name: "Jordan" });
  game("t2", 118, null);
  game("t3", 104, null, { name: "Priya", pauses: [{ from: ago(6), to: null }] }); // paused
  game("t4", 92, null);
  game("t5", 71, null, { name: "Sam" });
  game("t6", 49, null);
  game("t7", 33, null);
  game("t9", 21, null, { name: "Lee" });
  game("u1", 88, null, { name: "Birthday group" });
  game("u2", 64, null);
  game("u4", 40, 4); // upstairs, just finished: being cleaned
  game("u3", 110, 15, { readyAt: ago(1) }); // upstairs, cleaned and marked ready: downstairs gets a notice

  const waitHistory = [
    { id: id(), name: "Alex", addedAt: ago(200), endedAt: ago(170), outcome: "seated", tableId: "t9" },
    { id: id(), name: "Morgan", addedAt: ago(190), endedAt: ago(150), outcome: "seated", tableId: "t1" },
    { id: id(), name: "Chris", addedAt: ago(130), endedAt: ago(95), outcome: "seated", tableId: "t7" },
    { id: id(), name: "Taylor", addedAt: ago(125), endedAt: ago(110), outcome: "left" },
  ];
  const waitlist = [
    { id: id(), name: "Riley", note: "party of 4", addedAt: ago(26) },
    { id: id(), name: "Dana", note: "", addedAt: ago(17) },
    { id: id(), name: "Kai", note: "pool + bar", addedAt: ago(8) },
    { id: id(), name: "Noor", note: "", addedAt: ago(2) },
  ];

  return {
    version: 1, hall: "building", tables: ALL_TABLES.map((t) => ({ ...t })),
    sessions, waitlist, waitHistory,
    upstairsOpen: true,
    reservations: { t8: { name: "Smith party (prepaid)", at: ago(30) } },
    managers: {},
  };
}

export function createDemoStore() {
  let state = load() ?? demoNight();
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  };
  const set = (next) => {
    state = next;
    save();
    emit();
  };

  // A practice manager, so voids can be tried: PIN 1234.
  if (!Object.keys(state.managers ?? {}).length) {
    makeManager("Demo manager", DEMO_PIN).then((m) => set({ ...state, managers: { demo: m } })).catch(() => {});
  }
  save();

  // Other practice tabs (upstairs, Reports) see changes straight away.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      state = JSON.parse(e.newValue);
      emit();
    } catch {}
  });

  return {
    kind: "demo",
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch(name, args) {
      const action = actions[name];
      if (!action) throw new Error(`Unknown action ${name}`);
      set(action(state, { now: Date.now(), ...args }));
      return state;
    },
    user: () => ({ email: "practice mode" }),
    signIn: async () => {},
    signOut: async () => {},
    syncStatus: () => "demo",
    setUpstairsOpen: (open) => set({ ...state, upstairsOpen: open }),
    reserveTable: (tableId, { name = "" } = {}) =>
      set({ ...state, reservations: { ...state.reservations, [tableId]: { name: name.trim(), at: Date.now() } } }),
    unreserveTable(tableId) {
      const { [tableId]: _gone, ...rest } = state.reservations ?? {};
      set({ ...state, reservations: rest });
    },
    addManager: (mid, record) => set({ ...state, managers: { ...state.managers, [mid]: record } }),
    removeManager(mid) {
      const { [mid]: _gone, ...rest } = state.managers ?? {};
      set({ ...state, managers: rest });
    },
    hasHistory: () => true,
    withHistory: () => state,
    loadHistory: async () => {},
    loadAll: async () => state,
    importState: () => 0,
    shutdown: () => Promise.resolve(),
    /** Start the practice night over. */
    reset() {
      set({ ...demoNight(), managers: state.managers });
    },
  };
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    // A practice night from an earlier day is stale: start a fresh one.
    if (s && s.version === 1 && s.sessions?.some((x) => businessDateOf(x.start).getTime() === businessDateOf(Date.now()).getTime())) return s;
  } catch {}
  return null;
}

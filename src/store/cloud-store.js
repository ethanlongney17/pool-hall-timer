// Store that keeps everything in Firebase so every device shares the same
// tables, waitlist and history, live. Same interface as the local store:
//   get(), subscribe(fn), dispatch(name, args)
// plus sign-in, sync status, the upstairs open/closed switch, and loading
// older nights on demand.
//
// Works offline: Firestore keeps a copy on the device, changes made without
// Wi-Fi are saved there and sent when the connection comes back.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, query, where, writeBatch, getDocs, getDocsFromCache, setDoc, deleteField,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { firebaseConfig } from "../firebase-config.js";
import { actions } from "../model.js";
import { ALL_TABLES } from "../halls.js";
import { COLLECTIONS, clean, diffState, createMirror, withExtra } from "./sync-core.js";

const DAY = 86_400_000;
// Devices keep the last few days live. Older nights are fetched when asked for,
// which keeps the free Firebase plan's daily read allowance comfortably unused.
const RECENT_DAYS = 3;
const MAX_BATCH = 450;

const FRIENDLY = {
  "permission-denied": "The cloud database refused access. Check the database rules are published and this device is signed in.",
  "unavailable": "Can't reach the cloud right now. Changes are saved on this device and will sync.",
  "auth/invalid-credential": "That email or password isn't right.",
  "auth/wrong-password": "That email or password isn't right.",
  "auth/user-not-found": "That email or password isn't right.",
  "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
  "auth/network-request-failed": "No internet connection. Connect to Wi-Fi to sign in the first time.",
};
export const friendlyError = (e) => FRIENDLY[e?.code] ?? e?.message ?? String(e);

export function createCloudStore({ onAuthChange, onError }) {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  const recentFrom = Date.now() - RECENT_DAYS * DAY;
  const mirror = createMirror();
  let base = { version: 1, hall: "building", tables: ALL_TABLES.map((t) => ({ ...t })), upstairsOpen: false, reservations: {} };
  let state = mirror.state(base);
  let user = null;
  let unsubs = [];
  const loaded = new Set();
  const sync = { fromCache: true, pending: false };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));
  const rebuild = () => {
    state = mirror.state(base);
    emit();
  };
  let denied = false;
  const fail = (e) => {
    console.error(e);
    if (e?.code === "permission-denied") {
      denied = true;
      emit();
    }
    onError?.(friendlyError(e));
  };

  function listen() {
    stop();
    const watch = (col, q) =>
      onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
        mirror.apply(col, snap.docChanges().map((ch) => ({ type: ch.type, id: ch.doc.id, data: ch.doc.data() })));
        denied = false;
        sync.fromCache = snap.metadata.fromCache;
        sync.pending = snap.metadata.hasPendingWrites;
        loaded.add(col);
        rebuild();
      }, fail);
    unsubs = [
      watch("sessions", query(collection(db, "sessions"), where("start", ">=", recentFrom))),
      watch("waitlist", collection(db, "waitlist")),
      watch("waitHistory", query(collection(db, "waitHistory"), where("addedAt", ">=", recentFrom))),
      onSnapshot(doc(db, "settings", "floors"), (snap) => {
        base = { ...base, upstairsOpen: !!snap.data()?.upstairsOpen };
        rebuild();
      }, fail),
      onSnapshot(doc(db, "settings", "reservations"), (snap) => {
        base = { ...base, reservations: snap.data() ?? {} };
        rebuild();
      }, fail),
    ];
  }
  function stop() {
    unsubs.forEach((u) => u());
    unsubs = [];
  }

  /** Send changes in batches. Offline, Firestore queues them and sends later. */
  function write(ops) {
    for (let i = 0; i < ops.length; i += MAX_BATCH) {
      const batch = writeBatch(db);
      for (const o of ops.slice(i, i + MAX_BATCH)) {
        const ref = doc(db, o.col, o.id);
        if (o.op === "delete") batch.delete(ref);
        else batch.set(ref, o.data);
      }
      batch.commit().catch(fail);
    }
  }

  onAuthStateChanged(auth, (u) => {
    user = u;
    denied = false;
    if (u) listen();
    else stop();
    onAuthChange?.(u);
  });

  const historyCache = new Map();

  return {
    kind: "cloud",
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch(name, args) {
      if (!user) throw new Error("Sign in first");
      const action = actions[name];
      if (!action) throw new Error(`Unknown action ${name}`);
      const next = action(state, { now: Date.now(), ...args });
      const ops = diffState(state, next);
      mirror.applyOps(ops);
      write(ops);
      base = { ...base, ...pickBase(next) };
      rebuild();
      return state;
    },

    // --- Sign-in ---
    user: () => user,
    signIn: (email, password) => signInWithEmailAndPassword(auth, email.trim(), password),
    signOut: () => signOut(auth),

    /** "live", "offline" (changes saved here, will sync) or "connecting". */
    syncStatus() {
      if (!user) return "signed-out";
      if (denied) return "denied";
      if (loaded.size < COLLECTIONS.length) return "connecting";
      if (sync.pending || sync.fromCache) return "offline";
      return "live";
    },

    // --- Upstairs open/closed, shared by every device ---
    setUpstairsOpen(open) {
      base = { ...base, upstairsOpen: open };
      rebuild();
      setDoc(doc(db, "settings", "floors"), { upstairsOpen: open, changedAt: Date.now() }, { merge: true }).catch(fail);
    },

    // --- Reserved tables, shared by every device ---
    reserveTable(tableId, { name = "" } = {}) {
      if (!user) throw new Error("Sign in first");
      const r = { name: name.trim(), at: Date.now() };
      base = { ...base, reservations: { ...base.reservations, [tableId]: r } };
      rebuild();
      setDoc(doc(db, "settings", "reservations"), { [tableId]: r }, { merge: true }).catch(fail);
    },
    unreserveTable(tableId) {
      if (!user) throw new Error("Sign in first");
      const { [tableId]: _gone, ...rest } = base.reservations;
      base = { ...base, reservations: rest };
      rebuild();
      setDoc(doc(db, "settings", "reservations"), { [tableId]: deleteField() }, { merge: true }).catch(fail);
    },

    // --- Older nights ---
    /** Is everything since `from` already on this device? */
    hasHistory: (from) => from >= recentFrom || [...historyCache.keys()].some((k) => k <= from),
    /** State including every game since `from` (fetched once, then kept). */
    withHistory(from) {
      if (from >= recentFrom) return state;
      const key = [...historyCache.keys()].filter((k) => k <= from).sort((a, b) => a - b)[0];
      return key == null ? state : withExtra(state, historyCache.get(key));
    },
    async loadHistory(from) {
      if (this.hasHistory(from)) return;
      const [s, w] = await Promise.all([
        getDocs(query(collection(db, "sessions"), where("start", ">=", from))),
        getDocs(query(collection(db, "waitHistory"), where("addedAt", ">=", from))),
      ]);
      historyCache.set(from, {
        sessions: s.docs.map((d) => ({ ...d.data(), id: d.id })),
        waitHistory: w.docs.map((d) => ({ ...d.data(), id: d.id })),
      });
    },

    /**
     * Every record ever, for the Reports page. Records this device already
     * has are reused, and only the last week's are fetched again (to pick up
     * late changes like coupons), so opening Reports again costs very little.
     * `full: true` re-fetches everything.
     */
    async loadAll({ full = false } = {}) {
      const all = {};
      for (const [col, field] of [["sessions", "start"], ["waitHistory", "addedAt"]]) {
        let cached = [];
        if (!full) {
          try {
            cached = (await getDocsFromCache(collection(db, col))).docs.map((d) => ({ ...d.data(), id: d.id }));
          } catch {}
        }
        const newest = cached.reduce((m, x) => Math.max(m, x[field] ?? 0), 0);
        const since = cached.length ? newest - 7 * DAY : 0;
        const fresh = (await getDocs(query(collection(db, col), where(field, ">=", since)))).docs
          .map((d) => ({ ...d.data(), id: d.id }));
        const byId = new Map(cached.map((x) => [x.id, x]));
        for (const x of fresh) byId.set(x.id, x);
        all[col] = [...byId.values()];
      }
      historyCache.set(0, all);
      return withExtra(state, all);
    },

    /**
     * Upload games, waitlist and waits from a backup or from what a device saved
     * before the cloud. Adds and updates; never deletes. Running games are
     * skipped if that table is already running in the cloud.
     */
    importState(local) {
      if (!user) throw new Error("Sign in first");
      const running = new Set(state.sessions.filter((s) => s.end == null && !s.voidedAt).map((s) => s.tableId));
      const ops = [];
      for (const col of COLLECTIONS) {
        for (const item of local[col] ?? []) {
          if (col === "sessions" && item.end == null && !item.voidedAt && running.has(item.tableId)) continue;
          ops.push({ op: "set", col, id: item.id, data: clean(item) });
        }
      }
      mirror.applyOps(ops.filter((o) => o.col !== "sessions" || o.data.start >= recentFrom));
      write(ops);
      rebuild();
      return ops.length;
    },
  };
}

// Fields of the state that aren't documents (none of the actions change these
// today, but keep them if one ever does).
function pickBase(next) {
  const { sessions, waitlist, waitHistory, ...rest } = next;
  return rest;
}

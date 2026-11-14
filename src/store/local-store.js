// Store that keeps everything on this device (browser storage).
// Same interface the cloud store will have:
//   get()                 -> current state
//   subscribe(fn)         -> fn(state) on every change; returns unsubscribe
//   dispatch(name, args)  -> run a model action; returns the new state or throws
//
// Several tabs/windows on the same device stay in sync via the storage event.

import { actions, initialState } from "../model.js";

const KEY = "poolhall.state.v1";

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) return parsed;
    }
  } catch (e) {
    console.error("Could not read saved data", e);
  }
  return initialState();
}

export function createLocalStore() {
  let state = load();
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));

  window.addEventListener("storage", (e) => {
    if (e.key === KEY && e.newValue) {
      try {
        state = JSON.parse(e.newValue);
        emit();
      } catch {}
    }
  });

  return {
    kind: "local",
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Replace everything (used by Restore from backup). */
    replaceAll(next) {
      state = next;
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        throw new Error("Couldn't save the restored data on this device.");
      }
      emit();
    },
    dispatch(name, args) {
      const action = actions[name];
      if (!action) throw new Error(`Unknown action ${name}`);
      const next = action(state, { now: Date.now(), ...args });
      state = next;
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        console.error("Could not save", e);
        alert("Warning: this change could not be saved on this device.");
      }
      emit();
      return state;
    },
  };
}

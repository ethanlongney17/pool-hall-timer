// The part of cloud syncing that doesn't touch Firebase, so it can be tested.
//
// In the cloud, each game (session), waitlist entry and finished wait is its
// own document. That way two devices changing different things at the same
// moment (upstairs closing a table while downstairs adds a name) never
// overwrite each other.

export const COLLECTIONS = ["sessions", "waitlist", "waitHistory"];

/** Plain data Firestore accepts: drops undefined fields. */
export const clean = (obj) => JSON.parse(JSON.stringify(obj));

/**
 * What to write to go from one state to the next:
 * [{ op: "set" | "delete", col, id, data? }]
 */
export function diffState(prev, next) {
  const ops = [];
  for (const col of COLLECTIONS) {
    const before = new Map((prev[col] ?? []).map((x) => [x.id, x]));
    const after = new Map((next[col] ?? []).map((x) => [x.id, x]));
    for (const [id, item] of after) {
      const old = before.get(id);
      if (!old || JSON.stringify(clean(old)) !== JSON.stringify(clean(item))) {
        ops.push({ op: "set", col, id, data: clean(item) });
      }
    }
    for (const id of before.keys()) if (!after.has(id)) ops.push({ op: "delete", col, id });
  }
  return ops;
}

/** Keeps the latest copy of every document the device has heard about. */
export function createMirror() {
  const maps = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
  return {
    maps,
    /** Apply changes from the cloud: [{ type: "added"|"modified"|"removed", id, data }] */
    apply(col, changes) {
      for (const ch of changes) {
        if (ch.type === "removed") maps[col].delete(ch.id);
        else maps[col].set(ch.id, { ...ch.data, id: ch.id });
      }
    },
    /** Apply a local change straight away, before the cloud confirms it. */
    applyOps(ops) {
      for (const o of ops) {
        if (o.op === "delete") maps[o.col].delete(o.id);
        else maps[o.col].set(o.id, o.data);
      }
    },
    /** The app's state built from everything known. */
    state(base) {
      return {
        ...base,
        sessions: [...maps.sessions.values()].sort((a, b) => a.start - b.start),
        waitlist: [...maps.waitlist.values()].sort((a, b) => a.addedAt - b.addedAt),
        waitHistory: [...maps.waitHistory.values()].sort((a, b) => a.addedAt - b.addedAt),
      };
    },
  };
}

/** Merge extra documents (older nights fetched on demand) into a state without duplicates. */
export function withExtra(state, extra) {
  const merge = (a = [], b = [], key) => {
    const m = new Map(a.map((x) => [x.id, x]));
    for (const x of b) if (!m.has(x.id)) m.set(x.id, x);
    return [...m.values()].sort((x, y) => x[key] - y[key]);
  };
  return {
    ...state,
    sessions: merge(state.sessions, extra.sessions, "start"),
    waitHistory: merge(state.waitHistory, extra.waitHistory, "addedAt"),
  };
}

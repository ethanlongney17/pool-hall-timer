// The building has two floors that share one set of data in the cloud:
// one waitlist, and tables numbered 1-16 across both floors.
//
// Two apps run from the same code. Which one a page is comes from
// <html data-hall="..."> in its index.html:
//   - downstairs: the main app. Shows downstairs tables, plus upstairs when
//     upstairs is open, so staff can seat anyone anywhere from one screen.
//   - upstairs: for the upstairs device. Shows the 5 upstairs tables.
// Same rates on both floors.

export const FLOORS = {
  downstairs: { id: "downstairs", name: "Downstairs" },
  upstairs: { id: "upstairs", name: "Upstairs" },
};

const DOWNSTAIRS_TABLES = Array.from({ length: 11 }, (_, i) => ({
  id: `t${i + 1}`, name: `Table ${i + 1}`, floor: "downstairs",
}));
// Numbered on from downstairs (1-11), so every table in the building has its own number.
const UPSTAIRS_TABLES = Array.from({ length: 5 }, (_, i) => ({
  id: `u${i + 1}`, name: `Table ${i + 12}`, floor: "upstairs",
}));

export const ALL_TABLES = [...DOWNSTAIRS_TABLES, ...UPSTAIRS_TABLES];

export const HALLS = {
  downstairs: {
    id: "downstairs",
    title: "Pool Tables",
    tables: DOWNSTAIRS_TABLES,
    storageKey: "poolhall.state.v1", // where this app kept data before the cloud
    filePrefix: "pool-tables",
  },
  upstairs: {
    id: "upstairs",
    title: "Upstairs Tables",
    tables: UPSTAIRS_TABLES,
    storageKey: "poolhall.upstairs.v1",
    filePrefix: "pool-tables-upstairs",
  },
};

export function currentHall() {
  const id = globalThis.document?.documentElement?.dataset?.hall;
  return HALLS[id] ?? HALLS.downstairs;
}

/** Which floor a table is on (older saved data has no floor on its tables). */
export function floorOf(state, tableId) {
  const t = state.tables.find((x) => x.id === tableId) ?? ALL_TABLES.find((x) => x.id === tableId);
  if (t?.floor) return t.floor;
  return state.hall === "upstairs" ? "upstairs" : "downstairs";
}

/**
 * The floors a given app shows, and the floors whose tables count toward
 * wait estimates (anyone on the waitlist can be seated on any open floor).
 */
export function floorsShown(hall, upstairsOpen) {
  if (hall.id === "upstairs") return ["upstairs"];
  return upstairsOpen ? ["downstairs", "upstairs"] : ["downstairs"];
}
export function floorsInPlay(upstairsOpen) {
  return upstairsOpen ? ["downstairs", "upstairs"] : ["downstairs"];
}

/** The same state with only the tables (and their games) on the given floors. */
export function onlyFloors(state, floors) {
  const keep = new Set(state.tables.filter((t) => floors.includes(floorOf(state, t.id))).map((t) => t.id));
  return {
    ...state,
    tables: state.tables.filter((t) => keep.has(t.id)),
    sessions: state.sessions.filter((s) => keep.has(s.tableId)),
  };
}

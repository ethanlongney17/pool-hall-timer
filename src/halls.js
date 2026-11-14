// The two floors run as separate apps from the same code. Each has its own
// tables, waitlist, nightly totals, exports and saved data, so the upstairs
// till is never mixed into downstairs. Same rates on both floors.
//
// Which floor a page is comes from <html data-hall="..."> in its index.html.

export const HALLS = {
  downstairs: {
    id: "downstairs",
    title: "Pool Tables",
    tables: Array.from({ length: 11 }, (_, i) => ({ id: `t${i + 1}`, name: `Table ${i + 1}` })),
    storageKey: "poolhall.state.v1", // unchanged, so existing downstairs data carries on
    filePrefix: "pool-tables",
  },
  upstairs: {
    id: "upstairs",
    title: "Upstairs Tables",
    // Numbered on from downstairs (1-11), so every table in the building has its own number.
    tables: Array.from({ length: 5 }, (_, i) => ({ id: `u${i + 1}`, name: `Table ${i + 12}` })),
    storageKey: "poolhall.upstairs.v1",
    filePrefix: "pool-tables-upstairs",
  },
};

export function currentHall() {
  const id = globalThis.document?.documentElement?.dataset?.hall;
  return HALLS[id] ?? HALLS.downstairs;
}

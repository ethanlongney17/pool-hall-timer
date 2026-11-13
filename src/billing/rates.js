// The hall's rate schedule. This is data, not code: a settings screen will
// edit it later, so changing a price never needs a code change.
//
// How the "business day" works:
//   A business day runs from `businessDayStartsAt` until the same time the
//   next calendar day. The hall closes at 2am, so anything after midnight
//   (and before 6am) belongs to the PREVIOUS night. Example: Thursday 12:30am
//   Friday is still "Thursday night" and is charged Thursday's evening rate,
//   not Friday's day rate and not Friday's evening rate.
//   6am is used instead of 2am so a table that runs a little past close keeps
//   the evening rate instead of suddenly dropping to the day rate.
//
// Each day lists rate windows in the order they happen. `from` is a clock
// time; times earlier than `businessDayStartsAt` mean "after midnight".
// Rates are whole cents per hour so the math never touches floating-point
// dollars.

const DAY_RATE = 1500; // $15/hr before 6pm, every day
const WEEKNIGHT = 2200; // $22/hr from 6pm, Sun-Thu nights
const WEEKEND_NIGHT = 2500; // $25/hr from 6pm, Fri-Sat nights

const day = (eveningRate) => [
  { from: "06:00", centsPerHour: DAY_RATE },
  { from: "18:00", centsPerHour: eveningRate },
];

export const DEFAULT_SCHEDULE = {
  businessDayStartsAt: "06:00",
  // Index matches Date#getDay(): 0 = Sunday ... 6 = Saturday.
  days: [
    day(WEEKNIGHT), // Sunday
    day(WEEKNIGHT), // Monday
    day(WEEKNIGHT), // Tuesday
    day(WEEKNIGHT), // Wednesday
    day(WEEKNIGHT), // Thursday
    day(WEEKEND_NIGHT), // Friday
    day(WEEKEND_NIGHT), // Saturday
  ],
};

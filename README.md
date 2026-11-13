# Pool Tables

Table timer, waitlist and nightly totals for the pool hall. Runs in a browser
and installs on an iPad from Safari (Share → Add to Home Screen).

No build step and no dependencies: plain HTML, CSS and JavaScript modules.

## Run it locally

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173. Tests: http://localhost:5173/tests/

## Layout

- `src/billing/rates.js` – prices and rate windows (data only)
- `src/billing/pricing.js` – turns start/end times into a charge
- `src/model.js` – every action (open, close, move, void, waitlist) as pure functions
- `src/store/local-store.js` – saves on this device; a cloud store with the same interface comes next
- `src/main.js` – the screens
- `sw.js`, `manifest.webmanifest`, `icons/` – install and offline support

## Rate rules

- $15/hr before 6pm every day; from 6pm $22/hr Sun–Thu nights, $25/hr Fri–Sat nights.
- A "night" runs 6am to 6am, so after-midnight play is charged at the previous night's rate.
- Charged on exact elapsed time, no minimum; rounded to the cent once, on the total.

// Offline support: the app keeps opening and running with no internet.
// Network first (so updates arrive as soon as they're published), falling
// back to the last cached copy when offline.

const CACHE = "pool-hall-v19";
const SHELL = [
  "./",
  "index.html",
  "app.css",
  "manifest.webmanifest",
  "src/main.js",
  "src/model.js",
  "src/export.js",
  "src/halls.js",
  "src/pin.js",
  "reports/",
  "reports/index.html",
  "reports.css",
  "src/reports.js",
  "src/reports-data.js",
  "src/firebase-config.js",
  "src/store/cloud-store.js",
  "src/store/sync-core.js",
  "upstairs/",
  "upstairs/index.html",
  "upstairs/manifest.webmanifest",
  "icons/upstairs-180.png",
  "icons/upstairs-192.png",
  "icons/upstairs-512.png",
  "src/store/local-store.js",
  "src/billing/pricing.js",
  "src/billing/rates.js",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL.map((u) => new Request(u, { cache: "reload" })), ...FIREBASE_FILES])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Firebase's own code comes from Google. Each version's files never change,
// so keep a copy and use it, which lets the app open with no internet.
const FIREBASE = "https://www.gstatic.com/firebasejs/11.10.0/";
const FIREBASE_FILES = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map((f) => FIREBASE + f);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method === "GET" && req.url.startsWith(FIREBASE)) {
    e.respondWith(
      caches.match(req.url).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.url, copy));
        }
        return res;
      })),
    );
    return;
  }
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    // "no-cache" makes the browser check with the server every time instead of
    // reusing a copy for up to 10 minutes, so updates show up on the next open.
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))),
  );
});

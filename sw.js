// Offline support: the app keeps opening and running with no internet.
// Network first (so updates arrive as soon as they're published), falling
// back to the last cached copy when offline.

const CACHE = "pool-hall-v6";
const SHELL = [
  "./",
  "index.html",
  "app.css",
  "manifest.webmanifest",
  "src/main.js",
  "src/model.js",
  "src/export.js",
  "src/store/local-store.js",
  "src/billing/pricing.js",
  "src/billing/rates.js",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
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

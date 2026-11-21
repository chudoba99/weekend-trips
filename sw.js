// Keeps the app's own files on the phone so it opens offline.
// The forecast itself is saved by app.js, not here. Bump VERSION after changing any file.
const VERSION = "wt-4";
const FILES = ["./", "index.html", "style.css", "places.js", "core.js", "app.js",
  "manifest.webmanifest", "icon-180.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App files: network first (so updates show up), falling back to the saved copy offline.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// Weekmenu app — service worker
// Network-first strategy: always tries the live server first (so testers get
// the latest version), and only falls back to the cached copy if the network
// request fails (e.g. briefly offline). Bump CACHE_NAME whenever you want to
// force-invalidate old cached assets after a deploy.

var CACHE_NAME = "weekmenu-shell-v2";
var SHELL_FILES = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  // Only handle plain http(s) requests — browser extensions, chrome-extension://
  // and other schemes can't be cached and would throw if we tried.
  if (event.request.url.indexOf("http") !== 0) return;
  // Never intercept API calls — those must always hit the live server.
  if (event.request.url.indexOf("/api/") !== -1) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); }).catch(function () {});
        return response;
      })
      .catch(function () {
        return caches.match(event.request).then(function (cached) {
          return cached || caches.match("/");
        });
      })
  );
});

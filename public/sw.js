// Weekmenu app — service worker
// Network-first strategy: always tries the live server first (so testers get
// the latest version), and only falls back to the cached copy if the network
// request fails (e.g. briefly offline). Bump CACHE_NAME whenever you want to
// force-invalidate old cached assets after a deploy.

var CACHE_NAME = "weekmenu-shell-v13";
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
        keys.filter(function (key) { return key !== CACHE_NAME && key !== "balanza-badge"; })
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
  if (event.request.url.indexOf("/admin") !== -1) return;
  if (event.request.url.indexOf("/media/") !== -1) return;   // filmpjes: rechtstreeks (Range-verzoeken horen niet in de cache)
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request, event.request.mode === "navigate" ? { cache: "no-store" } : {})
      .then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); }).catch(function () {});
        return response;
      })
      .catch(function () {
        return caches.match(event.request).then(function (cached) {
          // Alleen een pagina valt terug op de app; een script of plaatje krijgt nooit HTML terug.
          return cached || (event.request.mode === "navigate" ? caches.match("/") : Response.error());
        });
      })
  );
});

// ---------- Meldingen (Web Push) ----------
// De server stuurt een versleutelde melding als een opdracht klaar is terwijl de gebruiker weg is, als het tijd is om te
// plannen of als er nieuwe community-recepten zijn die passen. "url" bepaalt welk scherm opent.
self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { try { data = { body: event.data.text() }; } catch (e2) { data = {}; } }
  var title = data.title || "Balanza";
  var options = {
    body: data.body || "Er staat iets voor je klaar.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || "balanza",
    renotify: true,
    data: { url: data.url || "/" }
  };
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), bumpBadge()]));
});

// ---------- Teller op het app-icoon (iPhone vanaf iOS 16.4 op het beginscherm, Android/desktop in Chrome/Edge) ----------
// Elke melding telt er één bij; de app zet de teller weer op nul zodra je hem opent. De stand bewaren we in een eigen cache,
// omdat een service worker tussendoor kan worden afgesloten.
var BADGE_CACHE = "balanza-badge", BADGE_KEY = "/__badge";
function readBadge() {
  return caches.open(BADGE_CACHE).then(function (c) { return c.match(BADGE_KEY); })
    .then(function (r) { return r ? r.text() : "0"; }).then(function (t) { return Number(t) || 0; }, function () { return 0; });
}
function writeBadge(n) {
  return caches.open(BADGE_CACHE).then(function (c) { return c.put(BADGE_KEY, new Response(String(n))); }).catch(function () {});
}
function bumpBadge() {
  if (!self.navigator || typeof self.navigator.setAppBadge !== "function") return Promise.resolve();
  return readBadge().then(function (n) { n = Math.min(n + 1, 99); return writeBadge(n).then(function () { return self.navigator.setAppBadge(n); }); }).catch(function () {});
}

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "balanza-badge-reset") event.waitUntil(writeBadge(0));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c && typeof c.focus === "function") {
        // De app is al open: daarheen, en vertel welk scherm hoort bij deze melding (plannen, community).
        if (target !== "/" && typeof c.postMessage === "function") c.postMessage({ type: "balanza-open", url: target });
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  }));
});

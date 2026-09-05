/*
 * Minimal service worker. Two jobs, deliberately no more:
 *
 *  1. Installability — a fetch handler is what makes the browser offer "add to
 *     home screen", which is the whole point of running this from a phone.
 *  2. Notification clicks — focus the existing tab instead of opening a new one.
 *
 * It is network-first with a cached shell fallback, and it never touches /api.
 * Caching agent traffic would be actively wrong: the transcript is live state,
 * and a stale shell would silently pin the UI to an old build.
 */
const SHELL = "pi-web-shell-v1";
const SHELL_URL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add(SHELL_URL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Live endpoints: never cached, never intercepted.
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode !== "navigate") return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(SHELL).then((cache) => cache.put(SHELL_URL, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(SHELL_URL).then((hit) => hit ?? Response.error())),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

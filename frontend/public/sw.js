const CACHE_NAME = "finisher-support-v2";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/health")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {
      title: "Finisher Data",
      body: event.data?.text() || "Nuevo mensaje recibido",
    };
  }

  const title = payload.title || "Finisher Data";
  const options = {
    body: payload.body || "Nuevo mensaje recibido",
    icon: payload.icon || "/icons/icon-192.png",
    badge: payload.badgeIcon || "/icons/maskable-512.png",
    tag: payload.tag || "finisher-support-message",
    renotify: true,
    data: {
      url: payload.url || "/",
      ...(payload.data || {}),
    },
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      self.navigator?.setAppBadge ? self.navigator.setAppBadge(payload.badge || 1) : Promise.resolve(),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    Promise.all([
      self.navigator?.clearAppBadge ? self.navigator.clearAppBadge() : Promise.resolve(),
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clientList) => {
          const existing = clientList.find((client) => client.url.startsWith(self.location.origin));
          if (existing) return existing.focus();
          return self.clients.openWindow(targetUrl);
        }),
    ])
  );
});

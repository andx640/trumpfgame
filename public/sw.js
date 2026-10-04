// Service Worker: zeigt Push-Benachrichtigungen an (z. B. Einladungen) und öffnet beim Antippen die App.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Andi Trumpf", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Andi Trumpf", {
      body: data.body || "",
      icon: "/web-app-manifest-192x192.png",
      badge: "/favicon-96x96.png",
      tag: data.tag || "andi-trumpf",
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: data.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

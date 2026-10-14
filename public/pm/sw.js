// NetPower PM service worker: lets phones install the app ("Add to Home Screen") and shows push notifications.
// It doesn't cache anything — every request goes to the network as usual, so updates show up right away.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* network as normal */ });

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "NetPower PM", {
    body: d.body || "", tag: d.tag || undefined, data: { url: d.url || "/pm/" },
    icon: "/pm/img/icon-192.png?v=2", badge: "/pm/img/icon-192.png?v=2"
  }));
});

// Tapping a notification opens (or focuses) the app on the right page
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/pm/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.location.origin + "/pm"));
    if (win) { await win.focus(); if ("navigate" in win) return win.navigate(url); return; }
    return self.clients.openWindow(url);
  })());
});

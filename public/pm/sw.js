// NetPower PM service worker: lets phones install the app ("Add to Home Screen").
// It doesn't cache anything — every request goes to the network as usual, so updates show up right away.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* network as normal */ });

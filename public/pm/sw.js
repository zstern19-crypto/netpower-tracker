// NetPower PM service worker: install to the home screen, push notifications, and viewing offline.
//
// Offline (iPhone and Android): everything goes to the network first, so updates show up right away. A copy of
// what came back is kept on the phone; with no signal (or a connection that hangs), the saved copy is shown and the
// app marks the page as offline (response header X-PM-Offline = when that copy was saved).
//   pm-shell   the app's own files (pages, scripts, styles, icons, the PDF viewer)
//   pm-data    data you've looked at (GET /api/pm…), including whole jobs (?action=projectPack)
//   pm-files   drawings, specs, photos and attachments, under /pm/__file/<file URL>; filled by "Save this job for
//              offline" and automatically for smaller files you open. Served with Range support for the PDF viewer.
// Signing out (or a different person signing in on the phone) clears pm-data and pm-files — see public/pm/offline.js.
const SHELL = "pm-shell-v1", DATA = "pm-data-v1", FILES = "pm-files-v1";
const SHELL_FILES = ["/pm/", "/pm/pm.css", "/pm/manifest.webmanifest", "/pm/img/icon-192.png?v=2", "/pm/img/netpower-logo.jpg",
  "/pm/vendor/pdf.min.js", "/pm/vendor/pdf.worker.min.js",
  ...["pm", "drawings", "forms", "auth", "photos", "people", "export", "tools", "inspections", "changeorders", "equipment", "tasks", "push-ui", "jobs", "assistant-ui", "offline"].map(f => `/pm/${f}.js`)];
const AUTO_SAVE_MAX = 30 * 1024 * 1024;   // files you open that are smaller than this are kept automatically
const SLOW_MS = 10000;                    // no answer by then → show the saved copy (the network keeps going in the background)

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => Promise.allSettled(SHELL_FILES.map(u => c.add(new Request(u, { cache: "reload" }))))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => e.waitUntil((async () => {
  const keep = [SHELL, DATA, FILES];
  for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;   // saving needs the network (the app says so when offline)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/pm/__file/")) return e.respondWith(fileResponse(req, url));
  if (url.pathname === "/api/pm") return e.respondWith(dataResponse(req, url));
  if (req.mode === "navigate" && (url.pathname === "/pm" || url.pathname.startsWith("/pm/"))) return e.respondWith(networkFirst(req, SHELL, "/pm/"));
  if (url.pathname.startsWith("/pm/") && !url.pathname.startsWith("/pm/__")) return e.respondWith(networkFirst(req, SHELL));
});

// Network first; on failure or a hang, the saved copy. Only good (200) answers are saved.
async function networkFirst(req, cacheName, key) {
  const cache = await caches.open(cacheName);
  const net = fetch(req).then(async res => {
    if (res.ok && res.status === 200) await cache.put(key || req, stamp(res.clone()));
    return res;
  });
  const saved = () => cache.match(key || req, { ignoreSearch: cacheName === SHELL && !key });
  try {
    return await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error("slow")), SLOW_MS))]);
  } catch (err) {
    const hit = await saved();
    if (hit) { net.catch(() => {}); return offlineCopy(hit); }
    return net;   // nothing saved: keep waiting for the network (or fail)
  }
}

async function dataResponse(req, url) {
  try { return await networkFirst(req, DATA); }
  catch (err) {
    // A single type for a job (?type=rfi&project=…) can come out of that job's saved whole-job copy
    const type = url.searchParams.get("type"), project = url.searchParams.get("project");
    if (type && project) {
      const pack = await (await caches.open(DATA)).match(`/api/pm?action=projectPack&project=${encodeURIComponent(project)}`);
      if (pack) {
        const d = await pack.clone().json();
        if ((d.types || []).includes(type)) return json({ ok: true, records: d.records.filter(r => r.type === type) }, 200, pack.headers.get("X-PM-Saved"));
      }
    }
    return json({ ok: false, code: "OFFLINE", error: "You're offline, and this isn't saved on this phone yet." }, 503);
  }
}

// Files: the saved copy if there is one (with Range support), else the real file (src=) — smaller ones are kept
async function fileResponse(req, url) {
  const key = url.origin + url.pathname;
  const cache = await caches.open(FILES);
  const hit = await cache.match(key);
  if (hit) return ranged(req, hit);
  const src = url.searchParams.get("src");
  if (!src) return json({ ok: false, code: "OFFLINE", error: "This file isn't saved on this phone." }, 404);
  const range = req.headers.get("range");
  let res;
  try { res = await fetch(src, { mode: "cors", headers: range ? { range } : {} }); }
  catch (err) {
    try { return await fetch(src, { mode: "no-cors" }); }   // e.g. a store without CORS: still shows, just isn't kept
    catch (e2) { return json({ ok: false, code: "OFFLINE", error: "You're offline, and this file isn't saved on this phone." }, 503); }
  }
  const size = Number(res.headers.get("content-length") || 0);
  if (!range && res.status === 200 && size && size <= AUTO_SAVE_MAX) cache.put(key, stamp(res.clone())).catch(() => {});
  return res;
}

async function ranged(req, hit) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  const type = hit.headers.get("content-type") || "application/octet-stream";
  if (!range) { const h = new Headers(hit.headers); h.set("accept-ranges", "bytes"); return new Response(hit.body, { status: 200, headers: h }); }
  const blob = await hit.blob(), size = blob.size;
  let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
  if (!(start >= 0 && start <= end)) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { "content-type": type, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" } });
}

// Saved copies remember when they were saved
function stamp(res) {
  const h = new Headers(res.headers);
  h.set("X-PM-Saved", new Date().toISOString());
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
function offlineCopy(hit) {
  const h = new Headers(hit.headers);
  h.set("X-PM-Offline", hit.headers.get("X-PM-Saved") || "saved");
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: h });
}
function json(obj, status, offlineAt) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...(offlineAt ? { "X-PM-Offline": offlineAt } : {}) } });
}

self.addEventListener("message", e => {
  if (e.data === "clear-saved") e.waitUntil(Promise.all([caches.delete(DATA), caches.delete(FILES)]));
});

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

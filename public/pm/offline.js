// NetPower PM — viewing offline (iPhone and Android). The service worker (sw.js) keeps a copy of what you look at;
// this file adds:
//   • the "Offline" bar (shown while pages come from the phone's saved copy, or the phone has no connection)
//   • "Save this job for offline" on the project home: the job's data plus its drawings, specs and attachments
//   • file links that go through the worker (/pm/__file/<file URL>?src=<signed link>) so files can be kept
//   • clearing everything saved when someone signs out, or a different person signs in on the phone
(() => {
  const PM = window.NetPowerPM;
  const { $, esc, toast, Store } = PM;
  const FILES = "pm-files-v1", DATA = "pm-data-v1";
  const REG_KEY = "netpower_pm_offline", USER_KEY = "netpower_pm_offline_user";
  const KEEP_MAX = 30 * 1024 * 1024;   // drawings you open that are smaller than this are kept automatically

  const ok = () => !!(window.caches && navigator.serviceWorker && navigator.serviceWorker.controller && Store.mode !== "local");
  const fileKey = fileUrl => location.origin + "/pm/__file/" + encodeURIComponent(fileUrl);
  const reg = () => PM.lsGet(REG_KEY, {}) || {};
  const setReg = r => PM.lsSet(REG_KEY, r);
  const mb = n => (n / 1048576 >= 10 ? Math.round(n / 1048576) : (n / 1048576).toFixed(1)) + " MB";

  // ── File links ──
  async function saved(fileUrl) {
    if (!ok()) return false;
    try { return !!(await (await caches.open(FILES)).match(fileKey(fileUrl))); } catch (e) { return false; }
  }
  // The URL the page should use for a file: the saved copy, or the real one through the worker (so it can be kept)
  async function fileUrlFor(fileUrl, signed) {
    if (!ok()) return signed ? signed() : fileUrl;
    if (await saved(fileUrl)) return fileKey(fileUrl);
    let src;
    try { src = signed ? await signed() : fileUrl; }
    catch (e) { if (offlineNow()) throw new Error("This file isn't saved on this phone for offline use."); throw e; }
    return fileKey(fileUrl) + "?src=" + encodeURIComponent(src);
  }
  // Keep a full copy of a file (e.g. a drawing set you opened). Skips files over `max` bytes.
  async function keep(fileUrl, src, max) {
    if (!ok() || await saved(fileUrl)) return 0;
    const ctl = new AbortController();
    const res = await fetch(src, { mode: "cors", signal: ctl.signal });
    const size = Number(res.headers.get("content-length") || 0);
    if (!res.ok || (max && (!size || size > max))) { ctl.abort(); return 0; }
    const h = new Headers({ "content-type": res.headers.get("content-type") || "application/octet-stream", "X-PM-Saved": new Date().toISOString() });
    if (size) h.set("content-length", String(size));
    await (await caches.open(FILES)).put(fileKey(fileUrl), new Response(res.body, { status: 200, headers: h }));
    return size;
  }
  function keepOpened(fileUrl) {
    if (!ok() || offlineNow() || !/^https:\/\//.test(fileUrl)) return;
    PM.files.signedUrl(fileUrl).then(src => keep(fileUrl, src, KEEP_MAX)).catch(() => {});
  }

  // ── Offline bar ──
  let offlineAt = null;
  const offlineNow = () => navigator.onLine === false || !!offlineAt;
  function note(res) {
    const at = res && res.headers ? res.headers.get("X-PM-Offline") : null;
    if (at) { offlineAt = at; paint(); }
    else if (res && offlineAt && res.ok) { offlineAt = null; paint(); }
  }
  function lost() { if (!offlineAt) { offlineAt = "now"; paint(); } }   // a request just failed for lack of signal
  function paint() {
    let bar = $("#offlineBar");
    const show = navigator.onLine === false || offlineAt;
    if (!show) { if (bar) bar.remove(); document.body.classList.remove("is-offline"); return; }
    if (!bar) { bar = document.createElement("div"); bar.id = "offlineBar"; bar.className = "offline-bar"; document.body.appendChild(bar); }
    document.body.classList.add("is-offline");
    const when = offlineAt && !isNaN(Date.parse(offlineAt)) ? ` from ${PM.fmtDateTime(offlineAt)}` : "";
    bar.innerHTML = `📴 <strong>Offline</strong> — showing what's saved on this phone${esc(when)}. Changes can't be saved until you have signal.`;
  }
  window.addEventListener("offline", paint);
  window.addEventListener("online", () => { offlineAt = null; paint(); PM.render(); });

  // ── Save a job ──
  const BLOB_RE = /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\/\S+$/i;
  function jobFiles(p, photos) {
    const out = new Map();   // fileUrl → {kind, size}
    const add = (u, kind, size) => { if (typeof u === "string" && BLOB_RE.test(u) && !out.has(u)) out.set(u, { kind, size: Number(size) || 0 }); };
    if (PM.can(p.id, "drawings")) {
      const sets = Object.fromEntries(Store.all("drawset", p.id).map(s => [s.id, s]));
      for (const g of Store.all("drawing", p.id)) {
        const r = (g.data.revisions || []).find(x => x.id === g.data.current) || (g.data.revisions || [])[0];
        if (r) add(r.fileUrl, "Drawings", sets[r.setId] && sets[r.setId].data.size);
      }
    }
    const walk = (v, kind, size) => {
      if (typeof v === "string") return add(v, kind, size);
      if (Array.isArray(v)) return v.forEach(x => walk(x, kind));
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, kind, k === "url" ? v.size : undefined);
    };
    const KIND = { spec: "Specs", jphoto: "Jobsite photos" };
    for (const r of Object.values(Store.cache)) {
      if (r.projectId !== p.id || ["drawing", "drawset", "markup", "project"].includes(r.type)) continue;
      if (r.type === "jphoto" && !photos) continue;
      walk(r.data, KIND[r.type] || "Attachments");
    }
    return out;
  }

  async function saveJob(p, photos) {
    if (!ok()) { toast("Open the app from the home-screen icon (or reload once) to save jobs for offline.", true); return; }
    if (offlineNow()) { toast("You need signal to save a job for offline.", true); return; }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});   // ask the phone not to clear it
    Store.loaded.delete("pack|" + p.id);
    await Store.loadProject(p.id);   // fresh copy of the job's data (the worker keeps it)
    const files = [...jobFiles(p, photos)];
    const box = $("#offStatus");
    let done = 0, bytes = 0, failed = 0;
    const show = () => { if (box) box.textContent = `Saving ${done} of ${files.length} files… ${mb(bytes)}`; };
    show();
    const queue = files.slice();
    await Promise.all([0, 1, 2].map(async () => {
      for (let f; (f = queue.shift());) {
        try { bytes += await keep(f[0], await PM.files.signedUrl(f[0])); }
        catch (e) { failed++; }
        done++; show();
      }
    }));
    const r = reg();
    r[p.id] = { at: new Date().toISOString(), files: files.map(f => f[0]), photos: !!photos, failed };
    setReg(r);
    toast(failed ? `Saved, but ${failed} file${failed === 1 ? "" : "s"} couldn't be downloaded` : "Saved for offline ✓", !!failed);
    PM.render();
  }

  async function removeJob(p) {
    const r = reg(), entry = r[p.id];
    if (!entry) return;
    const others = new Set(Object.entries(r).filter(([pid]) => pid !== p.id).flatMap(([, e]) => e.files || []));
    const c = await caches.open(FILES);
    await Promise.all((entry.files || []).filter(u => !others.has(u)).map(u => c.delete(fileKey(u))));
    delete r[p.id]; setReg(r);
    toast("Removed from this phone");
    PM.render();
  }

  // Project home panel
  function panel(p) {
    if (Store.mode === "local") return "";
    const e = reg()[p.id];
    setTimeout(async () => {
      const box = $("#offStatus");
      if (!box) return;
      if (!ok()) { box.innerHTML = `Open NetPower PM from the home-screen icon to save jobs for offline. <span class="muted">(On a computer, reload this page once.)</span>`; return; }
      if (e) {
        const missing = [...jobFiles(p, e.photos).keys()].filter(u => !(e.files || []).includes(u)).length;
        let used = "";
        try { const est = await navigator.storage.estimate(); used = ` · this phone is using ${mb(est.usage || 0)} for NetPower PM`; } catch (x) { /* not available */ }
        box.innerHTML = `✅ Saved on this phone ${esc(PM.fmtDateTime(e.at))} · ${(e.files || []).length} files${missing ? ` · <strong>${missing} new file${missing === 1 ? "" : "s"} not saved yet</strong>` : ""}${esc(used)}`;
      }
      const go = $("#offSave"), rm = $("#offRemove");
      if (go) go.onclick = async () => { go.disabled = true; try { await saveJob(p, $("#offPhotos") && $("#offPhotos").checked); } catch (x) { toast(x.message, true); } go.disabled = false; };
      if (rm) rm.onclick = () => removeJob(p).catch(x => toast(x.message, true));
    }, 0);
    return `<div class="panel off-panel"><h2>📴 Offline</h2>
      <p class="muted" style="margin-top:0">Saves this job's info, current drawings, specs and attachments on this phone so you can look at them with no signal (view only).</p>
      <div id="offStatus" class="off-status">${e ? "" : "Not saved on this phone yet."}</div>
      <label class="off-photos"><input type="checkbox" id="offPhotos" ${e && e.photos ? "checked" : ""}> Include jobsite photos</label>
      <div class="np-btns"><button class="btn ${e ? "" : "primary"}" id="offSave">${e ? "Update saved copy" : "📥 Save this job for offline"}</button>${e ? `<button class="btn" id="offRemove">Remove from this phone</button>` : ""}</div></div>`;
  }

  // Signed out, or someone else signed in on this phone: nothing of theirs stays behind
  async function clearAll() {
    PM.lsSet(REG_KEY, {});
    try { await Promise.all([caches.delete(DATA), caches.delete(FILES)]); } catch (e) { /* no Cache API */ }
  }
  async function checkUser() {
    if (!PM.session) return;
    const id = PM.session.user.id;
    if (PM.lsGet(USER_KEY, null) !== id) { await clearAll(); PM.lsSet(USER_KEY, id); }
  }

  PM.offline = { fileUrlFor, keepOpened, note, lost, offlineNow, panel, clearAll, checkUser, saveJob };
})();

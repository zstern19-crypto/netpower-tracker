// NetPower PM — Notification settings (user menu → Notification settings): turn phone notifications on for this
// device and choose what you get. Server side: lib/push.js and the push* actions in api/pm.js.
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast } = PM;

  const supported = () => "serviceWorker" in navigator && !!window.PushManager && "Notification" in window;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const keyBytes = b64 => { const s = atob((b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); };
  const post = (action, body) => PM.api("/api/pm?action=" + action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

  // The worker's registration (push works through it even when it doesn't control this exact page, e.g. "/pm")
  async function registration() {
    const reg = (await navigator.serviceWorker.getRegistration("/pm/")) || (await navigator.serviceWorker.register("/pm/sw.js", { scope: "/pm/" }));
    if (reg.active) return reg;
    const w = reg.installing || reg.waiting;
    if (w) await new Promise(res => { const t = setTimeout(res, 8000); w.addEventListener("statechange", () => { if (w.state === "activated") { clearTimeout(t); res(); } }); });
    return reg;
  }
  async function currentSub() { if (!supported()) return null; try { return await (await registration()).pushManager.getSubscription(); } catch (e) { return null; } }

  async function turnOn(publicKey) {
    const perm = await Notification.requestPermission();   // must come straight from the tap
    if (perm !== "granted") throw new Error(perm === "denied" ? "Notifications are blocked for this app — allow them in the phone's Settings" : "Notifications weren't allowed");
    const reg = await registration();
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    await post("pushSubscribe", { subscription: sub.toJSON() });
  }
  async function turnOff() {
    const sub = await currentSub();
    if (sub) { await post("pushUnsubscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  }

  async function page() {
    if (PM.Store.mode === "local") return `<div class="empty">Notifications need the online version (not demo mode).</div>`;
    const sub = await currentSub();
    const d = await PM.api("/api/pm?action=pushPrefs" + (sub ? "&endpoint=" + encodeURIComponent(sub.endpoint) : ""));
    const perm = supported() ? Notification.permission : "unsupported";
    const here = d.devices.find(x => x.thisDevice);
    // This phone has permission and a subscription the server doesn't know (e.g. Apple replaced it): sign it up again
    if (sub && perm === "granted" && !here) await post("pushSubscribe", { subscription: sub.toJSON() }).then(() => { synced(sub); }).catch(() => {});
    const on = !!(sub && perm === "granted");
    let device;
    if (!supported()) device = isIOS() && !installed()
      ? `<p><strong>On iPhone, notifications only work from the home-screen app.</strong></p><ol class="steps"><li>In Safari tap <strong>•••</strong> → <strong>Share</strong> → <strong>Add to Home Screen</strong>.</li><li>Open NetPower PM from the new icon and sign in.</li><li>Come back here (your name → Notification settings) and tap <strong>Turn on</strong>.</li></ol>`
      : `<p>This browser can't receive notifications. Try the home-screen app on your phone, or Chrome / Edge / Safari on a computer.</p>`;
    else if (perm === "denied") device = `<p><strong>Notifications are blocked for this app.</strong> Allow them in your phone's Settings (iPhone: Settings → Notifications → NetPower PM), then come back here.</p>`;
    else device = on ? `<p>✅ <strong>On for this phone.</strong></p><div class="np-btns"><button class="btn" id="npTest">Send me a test</button><button class="btn" id="npOff">Turn off on this phone</button></div>`
      : `<p>Get a notification on this phone even when the app is closed.</p><button class="btn primary" id="npOn">Turn on notifications</button>`;
    // Step-by-step check: what has to be true for this phone to get notifications
    const me = PM.contactName(PM.me()) || "";
    const row = (ok, text, fix) => `<li class="${ok === true ? "ok" : ok === false ? "bad" : "na"}"><span>${ok === true ? "✅" : ok === false ? "❌" : "➖"}</span><div>${text}${fix && ok === false ? `<div class="muted">${fix}</div>` : ""}</div></li>`;
    const checks = [
      isIOS() ? row(installed(), "Opened from the home-screen icon", "On iPhone, notifications only work in the home-screen app (Safari → Share → Add to Home Screen).") : "",
      row(supported(), "This browser can receive notifications", "Use the home-screen app, or Chrome / Edge / Safari."),
      row(perm === "granted" ? true : perm === "unsupported" ? null : false, perm === "granted" ? "Notifications allowed" : perm === "denied" ? "Notifications are blocked" : "Notifications not allowed yet",
        perm === "denied" ? "iPhone: Settings → Notifications → NetPower PM → Allow Notifications. Android: long-press the icon → App info → Notifications." : "Tap “Turn on notifications” above."),
      row(on ? !!here || null : false, on ? (here ? "This phone is signed up" : "Signing this phone up…") : "This phone is signed up", "Tap “Turn on notifications” above."),
      here && here.lastError ? row(false, "The last notification to this phone failed", `${esc(here.lastError)} (${esc(PM.fmtDateTime(here.lastErrorAt))}). Tap “Turn off on this phone”, then “Turn on notifications” again.`) : "",
      row(!!d.prefs.assigned, "“Assigned to me / ball in my court” is on", "Tick it in the list below."),
      row(me ? true : false, me ? `Things assigned to <strong>${esc(me)}</strong> in the directory notify you` : "Your login isn't linked to a person in the directory", "Ask a company admin to link your login to your directory entry (Admin → Users).")
    ].join("");
    let team = "";
    if (PM.isCompanyAdmin()) {
      const t = await PM.api("/api/pm?action=pushTeam").catch(() => null);
      if (t) team = `<div class="panel" style="max-width:640px"><h2>Who has notifications on</h2>
        <table class="list"><thead><tr><th>Person</th><th>Phones</th><th>Assigned to me</th></tr></thead><tbody>
        ${t.team.map(u => `<tr><td>${esc(u.name)}${u.problem ? `<div class="overdue" style="font-size:12px">Last send failed: ${esc(u.problem)}</div>` : ""}</td><td>${u.devices || `<span class="muted">none</span>`}</td><td>${u.assigned ? "on" : "off"}</td></tr>`).join("")}</tbody></table>
        <p class="muted" style="font-size:13px">People with no phone have to open the app on their phone and turn notifications on themselves (your name → Notification settings).</p></div>`;
    }
    setTimeout(() => wire(d), 0);   // after the last await, so the page is on screen when this runs
    return `<div class="page-head"><h1>Notification settings</h1></div>
      <div class="panel" style="max-width:640px"><h2>This phone</h2>${device}
        <p class="muted" style="font-size:13px">${d.devices.length ? `Turned on for ${d.devices.length} device${d.devices.length === 1 ? "" : "s"} of yours.` : "Not turned on for any of your devices yet."}</p></div>
      <div class="panel" style="max-width:640px"><h2>Check notifications</h2><ul class="np-check">${checks}</ul>
        <p class="muted" style="font-size:13px">You aren't notified about things you do yourself (for example a task you assign to yourself) — they show in 🔔 and My Tasks instead.</p></div>
      <div class="panel" style="max-width:640px"><h2>What to notify me about</h2>
        ${d.categories.map(c => `<label class="np-cat"><input type="checkbox" data-np="${c.k}" ${d.prefs[c.k] ? "checked" : ""}><span><strong>${esc(c.label)}</strong><span class="muted">${esc(c.help)}</span></span></label>`).join("")}
        <p class="muted" style="font-size:13px">These apply to all your devices. The morning summary comes once a day, around 7 AM (6 AM in winter).</p></div>${team}`;
  }

  // Once a day when the app opens: make sure the server still has this phone's current subscription
  const SYNC_KEY = "netpower_pm_push_sync";
  const synced = sub => PM.lsSet(SYNC_KEY, { endpoint: sub.endpoint, at: Date.now() });
  async function sync() {
    try {
      if (!supported() || Notification.permission !== "granted" || PM.Store.mode === "local" || !PM.session) return;
      const sub = await currentSub();
      if (!sub) return;
      const last = PM.lsGet(SYNC_KEY, null);
      if (last && last.endpoint === sub.endpoint && Date.now() - last.at < 86400000) return;
      await post("pushSubscribe", { subscription: sub.toJSON() });
      synced(sub);
    } catch (e) { /* try again next time */ }
  }

  function wire(d) {
    const on = $("#npOn");
    if (on) on.onclick = async () => { on.disabled = true; try { await turnOn(d.publicKey); const s2 = await currentSub(); if (s2) synced(s2); toast("Notifications on ✓"); PM.render(); } catch (e) { toast(e.message, true); on.disabled = false; } };
    const off = $("#npOff");
    if (off) off.onclick = async () => { await turnOff(); toast("Turned off on this phone"); PM.render(); };
    const test = $("#npTest");
    if (test) test.onclick = async () => { try { const r = await post("pushTest"); toast(r.sent ? "Test sent — check your notifications" : "Nothing was sent — try turning it off and on again on this phone", !r.sent); } catch (e) { toast(e.message, true); } };
    $$("[data-np]").forEach(c => c.onchange = async () => {
      const prefs = Object.fromEntries($$("[data-np]").map(x => [x.dataset.np, x.checked]));
      try { await post("pushPrefs", { prefs }); toast("Saved"); } catch (e) { toast(e.message, true); c.checked = !c.checked; }
    });
  }

  PM.push = { page, supported, sync };
})();

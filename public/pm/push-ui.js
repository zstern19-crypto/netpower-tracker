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
    const d = await PM.api("/api/pm?action=pushPrefs");
    const sub = await currentSub();
    const on = !!(sub && Notification.permission === "granted");
    setTimeout(() => wire(d), 0);
    let device;
    if (!supported()) device = isIOS() && !installed()
      ? `<p><strong>On iPhone, notifications only work from the home-screen app.</strong></p><ol class="steps"><li>In Safari tap <strong>•••</strong> → <strong>Share</strong> → <strong>Add to Home Screen</strong>.</li><li>Open NetPower PM from the new icon and sign in.</li><li>Come back here (your name → Notification settings) and tap <strong>Turn on</strong>.</li></ol>`
      : `<p>This browser can't receive notifications. Try the home-screen app on your phone, or Chrome / Edge / Safari on a computer.</p>`;
    else if (Notification.permission === "denied") device = `<p><strong>Notifications are blocked for this app.</strong> Allow them in your phone's Settings (iPhone: Settings → Notifications → NetPower PM), then come back here.</p>`;
    else device = on ? `<p>✅ <strong>On for this phone.</strong></p><div class="np-btns"><button class="btn" id="npTest">Send me a test</button><button class="btn" id="npOff">Turn off on this phone</button></div>`
      : `<p>Get a notification on this phone even when the app is closed.</p><button class="btn primary" id="npOn">Turn on notifications</button>`;
    return `<div class="page-head"><h1>Notification settings</h1></div>
      <div class="panel" style="max-width:640px"><h2>This phone</h2>${device}
        <p class="muted" style="font-size:13px">${d.devices.length ? `Turned on for ${d.devices.length} device${d.devices.length === 1 ? "" : "s"} of yours.` : "Not turned on for any of your devices yet."}</p></div>
      <div class="panel" style="max-width:640px"><h2>What to notify me about</h2>
        ${d.categories.map(c => `<label class="np-cat"><input type="checkbox" data-np="${c.k}" ${d.prefs[c.k] ? "checked" : ""}><span><strong>${esc(c.label)}</strong><span class="muted">${esc(c.help)}</span></span></label>`).join("")}
        <p class="muted" style="font-size:13px">These apply to all your devices. The morning summary comes once a day, around 7 AM (6 AM in winter).</p></div>`;
  }

  function wire(d) {
    const on = $("#npOn");
    if (on) on.onclick = async () => { on.disabled = true; try { await turnOn(d.publicKey); toast("Notifications on ✓"); PM.render(); } catch (e) { toast(e.message, true); on.disabled = false; } };
    const off = $("#npOff");
    if (off) off.onclick = async () => { await turnOff(); toast("Turned off on this phone"); PM.render(); };
    const test = $("#npTest");
    if (test) test.onclick = async () => { try { const r = await post("pushTest"); toast(r.sent ? "Test sent — check your notifications" : "Nothing was sent — try turning it off and on again on this phone", !r.sent); } catch (e) { toast(e.message, true); } };
    $$("[data-np]").forEach(c => c.onchange = async () => {
      const prefs = Object.fromEntries($$("[data-np]").map(x => [x.dataset.np, x.checked]));
      try { await post("pushPrefs", { prefs }); toast("Saved"); } catch (e) { toast(e.message, true); c.checked = !c.checked; }
    });
  }

  PM.push = { page, supported };
})();

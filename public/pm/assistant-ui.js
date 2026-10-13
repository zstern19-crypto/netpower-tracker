// NetPower PM — AI assistant chat panel (talks to /api/assistant).
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast } = PM;
  const KEY = "netpower_pm_ai_chat";
  let status = null, busy = false;
  // Conversation in this browser tab: { messages: [...full API history...], view: [{role, text, actions}] }
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || { messages: [], view: [] }; } catch (e) { return { messages: [], view: [] }; } };
  const store = c => { try { sessionStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* too big or blocked: keep in memory only */ } };
  let chat = load();

  // Plain text → safe HTML with links, **bold** and line breaks
  const fmt = t => esc(t).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, u => `<a href="${u}" ${/\/pm#\//.test(u) ? "" : 'target="_blank" rel="noopener"'}>${u.replace(/^https?:\/\/[^/]+\/pm/, "") || u}</a>`)
    .replace(/\n/g, "<br>");

  async function refreshStatus() {
    if (PM.Store.mode === "local" || !PM.session) return null;
    try { status = await PM.api("/api/assistant"); } catch (e) { status = null; }
    return status;
  }

  function decorateTopbar() {
    const ub = $("#userBtn");
    if (!ub || $("#aiBtn")) { syncBtn(); return; }
    ub.insertAdjacentHTML("beforebegin", `<button class="ai-btn" id="aiBtn" hidden title="Ask the NetPower assistant">✦ Ask AI</button>`);
    $("#aiBtn").onclick = togglePanel;
    refreshStatus().then(syncBtn);
  }
  function syncBtn() { const b = $("#aiBtn"); if (b) b.hidden = !(status && (status.allowed || (status.isAdmin && !status.configured))); }

  function togglePanel() {
    let p = $("#aiPanel");
    if (p) { p.remove(); return; }
    document.body.insertAdjacentHTML("beforeend", `
      <section class="ai-panel" id="aiPanel" role="dialog" aria-label="NetPower assistant">
        <header><strong>✦ NetPower Assistant</strong><span class="spacer"></span>
          ${status && status.isAdmin ? `<button class="btn small" id="aiSettings" title="Who can use it and monthly limit">Settings</button>` : ""}
          <button class="btn small" id="aiNew">New chat</button><button class="btn small" id="aiClose" aria-label="Close">✕</button></header>
        <div class="ai-log" id="aiLog" aria-live="polite"></div>
        <form class="ai-input" id="aiForm"><textarea id="aiText" rows="2" placeholder="Ask about your projects, or say “Create an RFI on Riverside…”"></textarea>
          ${PM.forms && PM.forms.micBtn ? PM.forms.micBtn("aiText") : ""}<button class="btn primary" type="submit" id="aiSend">Send</button></form>
        <footer id="aiFoot"></footer>
      </section>`);
    $("#aiClose").onclick = togglePanel;
    $("#aiNew").onclick = () => { chat = { messages: [], view: [] }; store(chat); draw(); };
    const s = $("#aiSettings"); if (s) s.onclick = settingsModal;
    $("#aiForm").onsubmit = e => { e.preventDefault(); send(); };
    $("#aiText").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
    draw();
    setTimeout(() => $("#aiText").focus(), 30);
  }

  function draw() {
    const log = $("#aiLog");
    if (!log) return;
    if (status && !status.configured) {
      log.innerHTML = `<div class="ai-msg sys">The assistant needs an Anthropic API key on the server (the <code>ANTHROPIC_API_KEY</code> setting in Vercel — the same one the invoice reader uses). It isn't set right now.</div>`;
    } else {
      log.innerHTML = (chat.view.length ? "" : `<div class="ai-msg sys">Hi${PM.session ? " " + esc(PM.session.user.name.split(" ")[0]) : ""}! Try:<br>• “What RFIs are overdue on my projects?”<br>• “Create an RFI on Riverside: conduit conflicts with duct at C4, assign Alex”<br>• “Add to today's daily log: inspector passed rough-in”</div>`) +
        chat.view.map(m => `<div class="ai-msg ${m.role}">${fmt(m.text)}${(m.actions || []).length ? `<div class="ai-actions">${m.actions.map(a => `<span class="ai-act">✓ ${esc(a.text)}</span>`).join("")}</div>` : ""}</div>`).join("") +
        (busy ? `<div class="ai-msg assistant typing">Thinking…</div>` : "");
    }
    log.scrollTop = log.scrollHeight;
    const foot = $("#aiFoot");
    if (foot && status) foot.textContent = `This month: $${(status.monthCostUsd || 0).toFixed(2)} of $${status.capUsd} limit · ${status.access === "everyone" ? "everyone can use it" : "company admins only"}`;
    const send = $("#aiSend"); if (send) send.disabled = busy || !(status && status.allowed);
  }

  async function send() {
    const ta = $("#aiText");
    const text = ta.value.trim();
    if (!text || busy) return;
    ta.value = "";
    chat.view.push({ role: "user", text });
    busy = true; draw();
    try {
      const cur = PM.current && PM.current();
      const d = await PM.api("/api/assistant", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: chat.messages, text, projectId: cur && cur.project ? cur.project.id : "" }) });
      chat.messages = d.messages;
      chat.view.push({ role: "assistant", text: d.reply || "(no answer)", actions: d.actions });
      if (status) { status.monthCostUsd = d.usage.monthCostUsd; status.capUsd = d.usage.capUsd; }
      if ((d.actions || []).length) { PM.Store.loaded.clear(); PM.render(); }  // show what it created
    } catch (e) {
      chat.view.push({ role: "sys", text: e.message });
    }
    busy = false; store(chat); draw();
  }

  function settingsModal() {
    PM.openModal({
      title: "Assistant Settings",
      noRender: true,
      body: `<div class="field"><label>Who can use the assistant</label><div class="radio-list">
          <label><input type="radio" name="aiAccess" value="admins" ${status.access !== "everyone" ? "checked" : ""}> Company admins only</label>
          <label><input type="radio" name="aiAccess" value="everyone" ${status.access === "everyone" ? "checked" : ""}> Everyone signed in (each person only sees and does what their permissions allow)</label></div></div>
        <div class="field"><label for="aiCap">Monthly spending limit ($)</label><input id="aiCap" type="number" min="0" step="1" value="${esc(status.capUsd)}" style="width:140px">
          <div class="muted help">Spent so far this month: $${(status.monthCostUsd || 0).toFixed(2)}. When the limit is reached the assistant stops until next month. Costs are estimated from the AI service's published prices and billed by Anthropic on your API account.</div></div>`,
      onSave: async root => {
        const access = $("input[name=aiAccess]:checked", root).value, capUsd = Number($("#aiCap", root).value);
        try { const d = await PM.api("/api/assistant?action=settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access, capUsd }) }); status.access = d.access; status.capUsd = d.capUsd; }
        catch (e) { toast(e.message, true); return false; }
        toast("Assistant settings saved"); draw();
        return true;
      }
    });
  }

  PM.assistant = { decorateTopbar, refreshStatus };
})();

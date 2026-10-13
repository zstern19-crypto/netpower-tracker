// NetPower PM — AI assistant chat panel (talks to /api/assistant).
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast } = PM;
  const KEY = "netpower_pm_ai_chat";
  let status = null, busy = false;
  // Conversation in this browser tab: { messages: [...full API history...], view: [{role, text, actions}] }
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || { messages: [], view: [] }; } catch (e) { return { messages: [], view: [] }; } };
  // Files: `pending` = picked for the next message; `sent` = the originals sent in this chat (kept in memory so they
  // can be attached to an RFI the assistant creates)
  let pending = [], sent = [];
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
        <div class="ai-files" id="aiFiles"></div>
        <form class="ai-input" id="aiForm"><textarea id="aiText" rows="2" placeholder="Ask about your projects, or say “Create an RFI on Riverside…”"></textarea>
          <label class="btn ai-clip" title="Attach photos or PDFs" aria-label="Attach photos or PDFs">📎<input type="file" id="aiFile" accept="image/*,application/pdf" multiple hidden></label>
          ${PM.forms && PM.forms.micBtn ? PM.forms.micBtn("aiText") : ""}<button class="btn primary" type="submit" id="aiSend">Send</button></form>
        <footer id="aiFoot"></footer>
      </section>`);
    $("#aiClose").onclick = togglePanel;
    $("#aiNew").onclick = () => { chat = { messages: [], view: [] }; pending = []; sent = []; store(chat); draw(); };
    $("#aiFile").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
    $("#aiLog").onclick = e => { const b = e.target.closest("[data-attach-rfi]"); if (b) attachToRecord(b); };
    const panel = $("#aiPanel");
    panel.addEventListener("dragover", e => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); panel.classList.add("drop"); } });
    panel.addEventListener("dragleave", () => panel.classList.remove("drop"));
    panel.addEventListener("drop", e => { e.preventDefault(); panel.classList.remove("drop"); addFiles([...e.dataTransfer.files]); });
    $("#aiText").addEventListener("paste", e => { const f = [...(e.clipboardData || {}).files || []]; if (f.length) { e.preventDefault(); addFiles(f); } });
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
        chat.view.map((m, i) => `<div class="ai-msg ${m.role}">${fmt(m.text)}${(m.files || []).length ? `<div class="ai-msg-files">${m.files.map(f => `<span class="ai-chip">📎 ${esc(f)}</span>`).join("")}</div>` : ""}${(m.actions || []).length ? `<div class="ai-actions">${m.actions.map((a, j) => `<span class="ai-act">✓ ${esc(a.text)}</span>${
          a.tool === "create_rfi" && a.recordId && sent.length && !a.attached ? `<button class="btn small" data-attach-rfi="${i}|${j}">📎 Attach the ${sent.length} file${sent.length === 1 ? "" : "s"} from this chat to the RFI</button>` : a.attached ? `<span class="muted" style="font-size:12px">Files attached ✓</span>` : ""}`).join("")}</div>` : ""}</div>`).join("") +
        (busy ? `<div class="ai-msg assistant typing">Thinking…</div>` : "");
    }
    log.scrollTop = log.scrollHeight;
    const foot = $("#aiFoot");
    if (foot && status) foot.textContent = `This month: $${(status.monthCostUsd || 0).toFixed(2)} of $${status.capUsd} limit · ${status.access === "everyone" ? "everyone can use it" : "company admins only"}`;
    const send = $("#aiSend"); if (send) send.disabled = busy || !(status && status.allowed) || pending.some(f => f.state === "up");
    drawFiles();
  }
  function drawFiles() {
    const box = $("#aiFiles"); if (!box) return;
    box.innerHTML = pending.map((f, i) => `<span class="ai-chip ${f.state}">${f.state === "up" ? "⏳" : f.state === "err" ? "⚠" : "📎"} ${esc(f.name)}${f.state === "err" ? ` — ${esc(f.error)}` : ""}<button type="button" data-rmfile="${i}" aria-label="Remove ${esc(f.name)}">✕</button></span>`).join("");
    $$("[data-rmfile]", box).forEach(b => b.onclick = () => { pending.splice(Number(b.dataset.rmfile), 1); draw(); });
  }

  // Photos are shrunk (and HEIC etc. turned into JPEG) in the browser before upload
  async function prepare(file) {
    if (file.type === "application/pdf") return { blob: file, type: file.type };
    if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) throw new Error("Only photos and PDFs");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("This photo format can't be read here")); i.src = url; });
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      return { blob: await new Promise(res => c.toBlob(res, "image/jpeg", 0.85)), type: "image/jpeg" };
    } finally { URL.revokeObjectURL(url); }
  }
  const toB64 = async blob => { const a = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  function addFiles(list) {
    for (const file of list.slice(0, 10 - pending.length)) {
      const f = { name: file.name || "photo.jpg", file, state: "up" };
      pending.push(f);
      (async () => {
        try {
          const { blob, type } = await prepare(file);
          if (blob.size > 3 * 1024 * 1024) throw new Error("too big (3 MB max)");
          const d = await PM.api("/api/assistant?action=upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.name.replace(/\.(heic|heif|png|webp|gif)$/i, type === "image/jpeg" ? ".jpg" : "$&"), type, data: await toB64(blob) }) });
          Object.assign(f, { state: "ok", fileId: d.fileId, kind: d.kind, sig: d.sig, sentName: d.name });
          chat.fileSigs = { ...(chat.fileSigs || {}), [d.fileId]: d.sig };
          store(chat);
        } catch (e) { Object.assign(f, { state: "err", error: e.message }); }
        draw();
      })();
    }
    draw();
  }

  // After the assistant creates an RFI, attach the original files from this chat to it (same upload as the RFI page)
  async function attachToRecord(btn) {
    const [i, j] = btn.dataset.attachRfi.split("|").map(Number);
    const a = chat.view[i].actions[j];
    btn.disabled = true; btn.textContent = "Attaching…";
    try {
      await PM.Store.load("rfi", a.projectId);
      const r = PM.Store.get(a.recordId);
      if (!r) throw new Error("RFI not found");
      const added = [];
      for (const f of sent) added.push({ name: f.name, url: await PM.files.upload(`attachments/${a.projectId}/rfis`, f.file), size: f.file.size, type: f.file.type });
      if (!(await PM.saveRec(PM.withHistory({ ...r, data: { ...r.data, attachments: [...(r.data.attachments || []), ...added] } }, `${added.length} file(s) attached from the assistant chat`), `Attached to RFI #${r.data.number}`))) throw new Error("not saved");
      a.attached = true; store(chat); draw(); PM.render();
    } catch (e) { toast("Couldn't attach: " + e.message, true); btn.disabled = false; btn.textContent = "Try again"; }
  }

  async function send() {
    const ta = $("#aiText");
    const text = ta.value.trim();
    if (pending.some(f => f.state === "up")) { toast("Wait for the files to finish uploading", true); return; }
    const files = pending.filter(f => f.state === "ok");
    if ((!text && !files.length) || busy) return;
    ta.value = "";
    pending = [];
    sent.push(...files);
    chat.view.push({ role: "user", text, files: files.map(f => f.name) });
    busy = true; draw();
    try {
      const cur = PM.current && PM.current();
      const d = await PM.api("/api/assistant", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: chat.messages, text, projectId: cur && cur.project ? cur.project.id : "",
          files: files.map(f => ({ fileId: f.fileId, kind: f.kind, name: f.sentName })), fileSigs: chat.fileSigs || {} }) });
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

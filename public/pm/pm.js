/* NetPower PM — a Procore-style project management app.
 * Vanilla JS, hash-routed single page. Data goes to /api/pm (Airtable);
 * if the API is not configured it falls back to browser-only local mode. */
(function () {
  "use strict";

  const PM = window.NetPowerPM = window.NetPowerPM || {};

  // ───────────────────────── Helpers ─────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const uid = p => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = n => String(n).padStart(2, "0");
  const isoDate = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const today = () => isoDate(new Date());
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDate(d); };
  const fmtDate = iso => {
    if (!iso) return "";
    const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  const fmtDateTime = iso => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const money = n => (n === "" || n == null || isNaN(n)) ? "" : Number(n).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const pill = s => s ? `<span class="pill ${slug(s)}">${esc(s)}</span>` : "";
  const lsGet = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  function toast(msg, isErr) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2500);
  }

  function downloadCSV(name, rows) {
    const csv = rows.map(r => r.map(c => {
      const s = String(c == null ? "" : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ───────────────────────── Data store ─────────────────────────
  const LOCAL_KEY = "netpower_pm_records";

  // All API calls go through here: a 401 means the session ended → show the sign-in screen
  async function api(path, opts) {
    const r = await fetch(path, opts);
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && (d.code === "AUTH_REQUIRED" || d.code === "SETUP_REQUIRED")) {
      if (PM.auth) PM.auth.showLogin(d.code);
      throw new Error("Please sign in again");
    }
    if (!d.ok) throw new Error(d.error || "Request failed (HTTP " + r.status + ")");
    return d;
  }
  const Store = {
    mode: "cloud",
    cache: {},            // id -> {id, type, projectId, data}
    loaded: new Set(),    // "type|projectId" keys already fetched

    // Returns "SETUP_REQUIRED" / "AUTH_REQUIRED" when a sign-in screen is needed
    async init() {
      try {
        const r = await fetch("/api/pm?action=me");
        const d = await r.json().catch(() => ({}));
        if (r.status === 503 && d.code === "NOT_CONFIGURED") return this.useLocal();
        if (r.status === 401) { PM.session = null; return d.code || "AUTH_REQUIRED"; }
        if (!d.ok) throw new Error(d.error || "HTTP " + r.status);
        PM.session = d;
        await this.load("project");
      } catch (e) {
        if (location.protocol === "file:" || /Failed to fetch|Unexpected token|JSON/.test(e.message)) return this.useLocal();
        throw e;
      }
    },

    useLocal() {
      this.mode = "local";
      this.cache = lsGet(LOCAL_KEY, {}) || {};
    },

    persistLocal() {
      if (!lsSet(LOCAL_KEY, this.cache)) toast("Browser storage is full or blocked — changes may not persist.", true);
    },

    async load(type, projectId) {
      const key = type + "|" + (projectId || "");
      if (this.mode === "local" || this.loaded.has(key) || this.loaded.has(type + "|")) return;
      const q = new URLSearchParams({ type });
      if (projectId) q.set("project", projectId);
      const d = await api("/api/pm?" + q);
      d.records.forEach(rec => { this.cache[rec.id] = rec; });
      this.loaded.add(key);
    },

    all(type, projectId) {
      return Object.values(this.cache).filter(r => r.type === type && (projectId == null || r.projectId === projectId));
    },

    get(id) { return this.cache[id] || null; },

    async save(rec) {
      const prev = this.cache[rec.id];
      this.cache[rec.id] = rec;
      if (this.mode === "local") { this.persistLocal(); return rec; }
      try {
        await api("/api/pm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: [rec] }) });
      } catch (e) {
        if (prev) this.cache[rec.id] = prev; else delete this.cache[rec.id];
        throw e;
      }
      return rec;
    },

    // Saves many records, sequentially in batches to stay within Airtable rate limits.
    async saveMany(records, onProgress) {
      records.forEach(r => { this.cache[r.id] = r; });
      if (this.mode === "local") { this.persistLocal(); return; }
      for (let i = 0; i < records.length; i += 20) {
        const batch = records.slice(i, i + 20);
        try {
          await api("/api/pm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: batch }) });
        } catch (e) { throw new Error(e.message + ` (saved ${i} of ${records.length})`); }
        if (onProgress) onProgress(Math.min(i + 20, records.length), records.length);
      }
    },

    async remove(id, children) {
      const removed = Object.values(this.cache).filter(r => r.id === id || (children && r.projectId === id));
      removed.forEach(r => delete this.cache[r.id]);
      if (this.mode === "local") { this.persistLocal(); return; }
      try {
        await api("/api/pm?id=" + encodeURIComponent(id) + (children ? "&children=1" : ""), { method: "DELETE" });
      } catch (e) {
        removed.forEach(r => { this.cache[r.id] = r; });
        throw e;
      }
    }
  };

  // ───────────────────────── Domain constants ─────────────────────────
  const PROJECT_STATUSES = ["Bidding", "Active", "On Hold", "Completed", "Archived"];
  const COMPANY_TYPES = ["General Contractor", "Subcontractor", "Supplier", "Owner", "Architect", "Engineer", "Inspector", "Other"];
  const RFI_STATUSES = ["Draft", "Open", "Closed"];
  const SUB_STATUSES = ["Draft", "Open", "Approved", "Approved as Noted", "Revise and Resubmit", "Rejected", "Closed"];
  const SUB_TYPES = ["Shop Drawing", "Product Data", "Sample", "Mock-up", "O&M Manual", "Warranty", "Certificate", "Other"];
  const SUB_RESPONSES = ["Pending", "Approved", "Approved as Noted", "Revise and Resubmit", "Rejected", "For Record Only"];
  const PUNCH_STATUSES = ["Open", "Ready for Review", "Work Not Accepted", "Closed"];
  const PRIORITIES = ["Low", "Medium", "High"];
  const WEATHER = ["Clear", "Partly Cloudy", "Overcast", "Rain", "Heavy Rain", "Snow", "Fog", "Windy", "Extreme Heat", "Extreme Cold"];
  const TRADES = ["Electrical", "Low Voltage", "Fire Alarm", "Mechanical", "Plumbing", "Fire Protection", "Concrete", "Framing", "Drywall", "Painting", "Roofing", "Sitework", "General", "Other"];

  // ───────────────────────── Current user ─────────────────────────
  // Signed in → the session's user; local demo mode → the name picked in this browser
  const me = () => (PM.session ? PM.session.user.contactId : lsGet("netpower_pm_user", null));  // contact id
  const meName = () => {
    if (PM.session) return PM.session.user.name;
    const c = Store.get(me()); return c ? c.data.name : (lsGet("netpower_pm_username", "") || "Guest");
  };

  // ───────────────────────── Permissions ─────────────────────────
  // Levels per project and tool: none < read < standard < admin (enforced by the server too)
  const LEVEL_RANK = { none: 0, read: 1, standard: 2, admin: 3 };
  const isCompanyAdmin = () => Store.mode === "local" || !!(PM.session && PM.session.isAdmin);
  function level(projectId, tool) {
    if (isCompanyAdmin()) return "admin";
    if (tool === "company") return "none";
    return ((PM.session && PM.session.perms[projectId]) || {})[tool] || "none";
  }
  const can = (projectId, tool, min = "read") => LEVEL_RANK[level(projectId, tool)] >= LEVEL_RANK[min];
  // Remove controls the user may not use: data-perm="tool:level" (tool "company" = company admin)
  function applyPerms(root) {
    $$("[data-perm]", root).forEach(el => {
      const [tool, min] = el.dataset.perm.split(":");
      const ok = tool === "company" ? isCompanyAdmin() : current.project && can(current.project.id, tool, min);
      if (!ok) el.remove();
    });
  }
  // Route segment → permission tool
  const ROUTE_TOOL = { rfis: "rfis", submittals: "submittals", dailylog: "dailylog", punch: "punch", drawings: "drawings", specs: "specs", photos: "photos", team: "directory" };

  function contactName(id) { const c = Store.get(id); return c ? c.data.name : ""; }
  function companyName(id) { const c = Store.get(id); return c ? c.data.name : ""; }
  function contactLabel(id) {
    const c = Store.get(id);
    if (!c) return "";
    const co = companyName(c.data.companyId);
    return c.data.name + (co ? " (" + co + ")" : "");
  }
  function contacts() { return Store.all("contact").sort((a, b) => a.data.name.localeCompare(b.data.name)); }
  function companies() { return Store.all("company").sort((a, b) => a.data.name.localeCompare(b.data.name)); }
  function projectContacts(p) {
    const team = (p && p.data.team) || [];
    const list = team.length ? team.map(t => Store.get(t.contactId)).filter(Boolean) : contacts();
    return list.sort((a, b) => a.data.name.localeCompare(b.data.name));
  }

  function withHistory(rec, text) {
    rec.data.history = rec.data.history || [];
    rec.data.history.push({ at: new Date().toISOString(), by: meName(), text });
    rec.data.updatedAt = new Date().toISOString();
    return rec;
  }

  async function saveRec(rec, msg) {
    try {
      await Store.save(rec);
      if (msg) toast(msg);
      return true;
    } catch (e) {
      toast("Save failed: " + e.message, true);
      return false;
    }
  }

  function nextNumber(type, projectId) {
    return Store.all(type, projectId).reduce((m, r) => Math.max(m, Number(r.data.number) || 0), 0) + 1;
  }

  // ───────────────────────── Forms ─────────────────────────
  // Field spec: {k, label, type, options, req, full, help}
  function fieldHTML(f, v, ctx) {
    const id = "f_" + f.k;
    const req = f.req ? ' <span class="req">*</span>' : "";
    let input;
    const val = v == null ? "" : v;
    switch (f.type) {
      case "textarea":
        input = `<textarea id="${id}" name="${f.k}">${esc(val)}</textarea>`; break;
      case "select":
        input = `<select id="${id}" name="${f.k}">${f.blank === false ? "" : '<option value=""></option>'}${f.options.map(o => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`; break;
      case "contact": {
        const list = ctx && ctx.project ? projectContacts(ctx.project) : contacts();
        input = `<select id="${id}" name="${f.k}"><option value=""></option>${list.map(c => `<option value="${c.id}" ${c.id === val ? "selected" : ""}>${esc(contactLabel(c.id))}</option>`).join("")}</select>`; break;
      }
      case "contacts": {
        const list = ctx && ctx.project ? projectContacts(ctx.project) : contacts();
        const sel = Array.isArray(val) ? val : [];
        // data-order remembers selection order (used for sequential approval workflows)
        input = `<div class="checks" id="${id}" data-multi="${f.k}" ${f.ordered ? "data-ordered" : ""}>${list.length ? list.map(c => `<label><input type="checkbox" value="${c.id}" ${sel.includes(c.id) ? `checked data-order="${sel.indexOf(c.id)}"` : ""}> <span class="ord"></span>${esc(contactLabel(c.id))}</label>`).join("") : '<span class="muted">No contacts yet — add people in the Directory.</span>'}</div>`; break;
      }
      case "company":
        input = `<select id="${id}" name="${f.k}"><option value=""></option>${companies().map(c => `<option value="${c.id}" ${c.id === val ? "selected" : ""}>${esc(c.data.name)}</option>`).join("")}</select>`; break;
      case "checkbox":
        return `<div class="field ${f.full ? "full" : ""}"><label class="inline-check"><input type="checkbox" id="${id}" name="${f.k}" ${val ? "checked" : ""}> ${esc(f.label)}</label></div>`;
      case "number":
      case "money":
        input = `<input type="number" step="any" id="${id}" name="${f.k}" value="${esc(val)}">`; break;
      case "date":
        input = `<input type="date" id="${id}" name="${f.k}" value="${esc(val)}">`; break;
      default:
        input = `<input type="${f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text"}" id="${id}" name="${f.k}" value="${esc(val)}">`;
    }
    return `<div class="field ${f.full || f.type === "textarea" || f.type === "contacts" ? "full" : ""}"><label for="${id}">${esc(f.label)}${req}</label>${input}${f.help ? `<div class="muted" style="font-size:12px;margin-top:3px">${esc(f.help)}</div>` : ""}</div>`;
  }

  function numberOrderedChecks(box) {
    $$("input:checked", box)
      .sort((a, b) => Number(a.dataset.order || 0) - Number(b.dataset.order || 0))
      .forEach((i, n) => { i.parentNode.querySelector(".ord").textContent = (n + 1) + ". "; });
    $$("input:not(:checked)", box).forEach(i => { i.parentNode.querySelector(".ord").textContent = ""; });
  }
  document.addEventListener("change", e => {
    const box = e.target.closest && e.target.closest(".checks[data-multi]");
    if (!box || e.target.type !== "checkbox") return;
    if (e.target.checked) e.target.dataset.order = String(Date.now());
    else delete e.target.dataset.order;
    if (box.hasAttribute("data-ordered")) numberOrderedChecks(box);
  });

  function formHTML(fields, values, ctx) {
    return `<div class="form-grid">${fields.map(f => fieldHTML(f, values[f.k], ctx)).join("")}</div>`;
  }

  function readForm(root, fields) {
    const out = {};
    for (const f of fields) {
      if (f.type === "contacts") {
        out[f.k] = $$(`[data-multi="${f.k}"] input:checked`, root)
          .sort((a, b) => Number(a.dataset.order || 0) - Number(b.dataset.order || 0))
          .map(i => i.value);
        continue;
      }
      const el = root.querySelector(`[name="${f.k}"]`);
      if (!el) continue;
      if (f.type === "checkbox") out[f.k] = el.checked;
      else if (f.type === "number" || f.type === "money") out[f.k] = el.value === "" ? "" : Number(el.value);
      else out[f.k] = el.value.trim();
    }
    const missing = fields.filter(f => f.req && (out[f.k] === "" || out[f.k] == null || (Array.isArray(out[f.k]) && !out[f.k].length)));
    if (missing.length) throw new Error("Required: " + missing.map(f => f.label).join(", "));
    return out;
  }

  // ───────────────────────── Modal ─────────────────────────
  function closeModal() { $("#modalRoot").innerHTML = ""; document.removeEventListener("keydown", modalKey); }
  function modalKey(e) { if (e.key === "Escape") closeModal(); }

  // opts: {title, body, saveLabel, onSave(root) → truthy to close, wide, hideSave}
  function openModal(opts) {
    $("#modalRoot").innerHTML = `
      <div class="modal-bg">
        <div class="modal ${opts.wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
          <div class="modal-head"><h2>${esc(opts.title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
          <div class="modal-body">${opts.body}</div>
          ${opts.hideSave ? "" : `<div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>${esc(opts.saveLabel || "Save")}</button></div>`}
        </div>
      </div>`;
    const root = $(".modal", $("#modalRoot"));
    $$("[data-close]", $("#modalRoot")).forEach(b => b.onclick = closeModal);
    $(".modal-bg").addEventListener("mousedown", e => { if (e.target.classList.contains("modal-bg")) closeModal(); });
    document.addEventListener("keydown", modalKey);
    const save = $("[data-save]", root);
    if (save) save.onclick = async () => {
      save.disabled = true;
      try {
        const ok = await opts.onSave(root);
        if (ok !== false) { closeModal(); if (!opts.noRender) render(); }
      } catch (e) {
        toast(e.message, true);
      } finally {
        save.disabled = false;
      }
    };
    $$(".checks[data-ordered]", root).forEach(numberOrderedChecks);
    const first = $("input, select, textarea", root);
    if (first) first.focus();
    if (opts.onOpen) opts.onOpen(root);
    return root;
  }

  function confirmDialog(text) {
    return window.confirm(text);
  }

  // ───────────────────────── Shell ─────────────────────────
  let current = { project: null, tool: null };

  function renderTopbar() {
    const picker = $("#projectPicker");
    const projects = Store.all("project").filter(p => p.data.status !== "Archived").sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));
    picker.innerHTML = `<option value="">Select a project…</option>` + projects.map(p => `<option value="${p.id}" ${current.project && current.project.id === p.id ? "selected" : ""}>${esc((p.data.number ? p.data.number + " · " : "") + p.data.name)}</option>`).join("");
    $("#userBtn").textContent = "👤 " + meName() + (PM.session ? " ▾" : "");
    renderProjectMenu();
    const badge = $("#modeBadge");
    badge.hidden = Store.mode !== "local";
    badge.textContent = "Local demo mode";
    badge.title = "Airtable is not configured. Data is saved only in this browser.";
    if (PM.people) PM.people.decorateTopbar();
    $$(".topnav a").forEach(a => a.classList.toggle("on", a.dataset.nav === current.nav));
  }

  // Tools inside a project, in Procore's order: [route, label, permission tool, quick-create route]
  const PROJECT_TOOLS = [
    ["rfis", "RFIs", "rfis", "rfis/new"],
    ["submittals", "Submittals", "submittals", "submittals/new"],
    ["punch", "Punch List", "punch", "punch?new=1"],
    ["dailylog", "Daily Log", "dailylog", null],
    ["drawings", "Drawings", "drawings", null],
    ["photos", "Photos", "photos", "photos?upload=1"],
    ["specs", "Specifications", "specs", null]
  ];

  // "Project Management ▾" dropdown in the top bar (inside a project)
  function renderProjectMenu() {
    const wrap = $("#pmMenuWrap");
    if (!wrap) return;
    const p = current.project;
    if (!p) { wrap.innerHTML = ""; return; }
    const items = PROJECT_TOOLS.filter(([, , tool]) => can(p.id, tool));
    wrap.innerHTML = `<button class="pm-menu-btn" id="pmMenuBtn" aria-haspopup="true" aria-expanded="false">Project Management ▾</button>
      <div class="pm-menu" id="pmMenu" hidden role="menu">
        <div class="pm-menu-h">Project Management</div>
        ${items.map(([route, label, tool, quick]) => `<div class="pm-menu-row"><a role="menuitem" href="#/p/${p.id}/${route}">${label}</a>${quick && can(p.id, tool, "standard") ? `<a class="pm-quick" href="#/p/${p.id}/${quick}" title="${label === "Photos" ? "Upload photos" : "Create " + (label === "Punch List" ? "punch item" : label.slice(0, -1))}" aria-label="Create ${label}">+</a>` : ""}</div>`).join("")}
        <div class="pm-menu-sep"></div>
        <div class="pm-menu-row"><a href="#/p/${p.id}">Project Home</a></div>
        ${can(p.id, "directory") ? `<div class="pm-menu-row"><a href="#/p/${p.id}/team">Project Directory</a></div>` : ""}
        ${isCompanyAdmin() && Store.mode !== "local" ? `<div class="pm-menu-row"><a href="#/p/${p.id}/permissions">Permissions</a></div>` : ""}
      </div>`;
    const btn = $("#pmMenuBtn"), menu = $("#pmMenu");
    btn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
    menu.onclick = () => { menu.hidden = true; };
  }
  document.addEventListener("click", e => {
    const m = $("#pmMenu");
    if (m && !m.hidden && !e.target.closest("#pmMenuWrap")) m.hidden = true;
  });

  function renderSidebar() {
    const sb = $("#sidebar");
    const p = current.project;
    if (!p) {
      const projects = Store.all("project").filter(x => x.data.status !== "Archived").sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));
      const adminLinks = isCompanyAdmin() && Store.mode !== "local" ? `
        <div class="grp">Admin</div>
        <a href="#/admin/users" class="${location.hash.startsWith("#/admin/users") ? "on" : ""}">Users</a>
        <a href="#/admin/templates" class="${location.hash.startsWith("#/admin/templates") ? "on" : ""}">Permission Templates</a>` : "";
      sb.innerHTML = `
        <div class="grp">Company</div>
        <a href="#/" class="${current.nav === "portfolio" ? "on" : ""}">Portfolio</a>
        <a href="#/directory" class="${current.nav === "directory" ? "on" : ""}">Directory</a>
        ${adminLinks}
        <div class="grp">Projects</div>
        ${projects.map(x => `<a href="#/p/${x.id}">${esc(x.data.name)}</a>`).join("") || '<div class="muted" style="padding:4px 10px;font-size:13px">No projects yet</div>'}`;
      return;
    }
    const open = (type, statuses) => Store.all(type, p.id).filter(r => statuses.includes(r.data.status)).length;
    const tools = [
      ["home", "Home", ""],
      ["drawings", "Drawings", Store.all("drawing", p.id).length || ""],
      ["rfis", "RFIs", open("rfi", ["Open"])],
      ["submittals", "Submittals", open("submittal", ["Open", "Revise and Resubmit"])],
      ["dailylog", "Daily Log", ""],
      ["punch", "Punch List", open("punch", ["Open", "Ready for Review", "Work Not Accepted"])],
      ["photos", "Photos", Store.all("jphoto", p.id).length || ""],
      ["specs", "Specifications", Store.all("spec", p.id).length || ""],
      ["team", "Project Directory", ((p.data.team || []).length) || ""],
      ...(isCompanyAdmin() && Store.mode !== "local" ? [["permissions", "Permissions", ""]] : [])
    ].filter(([k]) => !ROUTE_TOOL[k] || can(p.id, ROUTE_TOOL[k]));
    sb.innerHTML = `
      <div class="proj-name">${esc(p.data.name)}</div>
      <div class="proj-num">${esc(p.data.number || "")} ${pill(p.data.status)}</div>
      <div class="grp">Project Tools</div>
      ${tools.map(([k, label, n]) => `<a href="#/p/${p.id}${k === "home" ? "" : "/" + k}" class="${current.tool === k ? "on" : ""}">${label}<span class="count">${n || ""}</span></a>`).join("")}
      <div class="grp">Company</div>
      <a href="#/">← All Projects</a>
      <a href="#/directory">Company Directory</a>`;
  }

  // ───────────────────────── Router ─────────────────────────
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    document.body.classList.remove("menu-open", "viewer-mode");
    if (PM.cleanup) { try { PM.cleanup(); } catch (e) { /* ignore */ } PM.cleanup = null; }
    const hash = location.hash.replace(/^#\/?/, "");
    const parts = hash.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
    const query = new URLSearchParams(hash.split("?")[1] || "");
    const main = $("#main");
    current = { project: null, tool: null, nav: null };
    try {
      await Promise.all([Store.load("company"), Store.load("contact")]);
      let view;
      if (parts[0] === "p" && parts[1]) {
        const p = Store.get(parts[1]);
        if (!p || p.type !== "project") { view = () => `<div class="empty">Project not found. <a href="#/">Back to portfolio</a></div>`; }
        else {
          current.project = p;
          current.tool = parts[2] || "home";
          // Load only what this user may see
          const LOADS = [["rfi", "rfis"], ["submittal", "submittals"], ["dailylog", "dailylog"], ["punch", "punch"],
            ["drawing", "drawings"], ["markup", "drawings"], ["drawset", "drawings"], ["spec", "specs"], ["subpackage", "submittals"], ["jphoto", "photos"], ["logsetting", "dailylog"], ["lookup", null]];
          await Promise.all(LOADS.filter(([, tool]) => !tool || can(p.id, tool)).map(([t]) => Store.load(t, p.id)));
          const sub = parts[3];
          const F = PM.forms;
          const guardTool = ROUTE_TOOL[current.tool];
          const noAccess = (guardTool && !can(p.id, guardTool)) || (current.tool === "permissions" && !isCompanyAdmin());
          view = noAccess ? () => `<div class="empty">You don't have access to this part of the project. Ask a company admin if you need it.</div>` : {
            home: () => projectHome(p),
            rfis: () => sub === "new" ? F.rfiPage(p, null) : parts[4] === "edit" ? F.rfiPage(p, Store.get(sub)) : sub ? rfiDetail(p, sub) : rfiList(p),
            submittals: () => sub === "packages" ? (parts[4] ? F.packageDetail(p, parts[4]) : F.packagesPage(p)) : sub === "new" ? F.submittalPage(p, null, query) : parts[4] === "edit" ? F.submittalPage(p, Store.get(sub)) : sub ? submittalDetail(p, sub) : submittalList(p),
            specs: () => F.specsPage(p, sub),
            permissions: () => PM.auth.projectPermissions(p),
            dailylog: () => dailyLog(p, sub),
            punch: () => {
              if (sub) return punchDetail(p, sub);
              if (query.get("new") && can(p.id, "punch", "standard")) setTimeout(() => editPunch(p, null), 0);
              return punchList(p);
            },
            team: () => projectTeam(p),
            photos: () => PM.photos ? PM.photos.page(p, query) : `<div class="empty">Photos module failed to load.</div>`,
            drawings: () => PM.drawings ? (sub ? PM.drawings.viewer(p, sub, query) : PM.drawings.log(p)) : `<div class="empty">Drawings module failed to load.</div>`
          }[current.tool] || (() => `<div class="empty">Unknown tool.</div>`);
        }
      } else if (parts[0] === "admin" && PM.auth) {
        current.nav = "admin";
        view = () => (isCompanyAdmin() ? PM.auth.adminPage(parts[1] || "users", parts[2]) : `<div class="empty">Only company admins can open this page.</div>`);
      } else if (parts[0] === "manpower" && PM.people) {
        current.nav = "manpower";
        view = () => PM.people.page(parts[1], query);
      } else if (parts[0] === "directory") {
        current.nav = "directory";
        view = () => directory(parts[1] || "companies");
      } else {
        current.nav = "portfolio";
        view = portfolio;
      }
      if (seq !== renderSeq) return;
      const html = await view();
      if (seq !== renderSeq) return;
      if (typeof html === "string") main.innerHTML = html;
      renderTopbar();
      renderSidebar();
      bind(main);
    } catch (e) {
      if (seq !== renderSeq) return;
      main.innerHTML = `<div class="panel"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
    }
  }

  // Generic delegated actions: elements with data-act="name" call ACTIONS[name](el)
  const ACTIONS = {};
  function bind(root) {
    applyPerms(root);
    if (PM.forms && PM.forms.hydrateImages) PM.forms.hydrateImages(root);
    $$("[data-act]", root).forEach(el => {
      const ev = el.tagName === "SELECT" || el.tagName === "INPUT" ? (el.type === "search" ? "input" : "change") : "click";
      el.addEventListener(ev, e => {
        if (el.tagName === "A" || el.tagName === "BUTTON") e.preventDefault();
        const fn = ACTIONS[el.dataset.act];
        if (fn) fn(el, e);
      });
    });
    $$("tr[data-href]", root).forEach(tr => tr.addEventListener("click", e => {
      if (e.target.closest("a, button, input, select")) return;
      location.hash = tr.dataset.href;
    }));
  }

  // List filter state per list key
  const filters = {};
  function getFilter(key) { return filters[key] || (filters[key] = { q: "", status: "", mine: false }); }
  ACTIONS.filter = el => {
    const f = getFilter(el.dataset.key);
    if (el.type === "checkbox") f[el.name] = el.checked; else f[el.name] = el.value;
    if (el.type === "search") {
      // Re-render just the table body to keep input focus
      const fn = LIST_RENDERERS[el.dataset.key];
      if (fn) { $("#listBody").innerHTML = fn(); bind($("#listBody")); }
    } else render();
  };
  const LIST_RENDERERS = {};

  function toolbarHTML(key, statuses, extra) {
    const f = getFilter(key);
    return `<div class="toolbar">
      <input type="search" name="q" data-act="filter" data-key="${key}" placeholder="Search…" value="${esc(f.q)}">
      ${statuses ? `<select name="status" data-act="filter" data-key="${key}"><option value="">All statuses</option><option value="__open" ${f.status === "__open" ? "selected" : ""}>All open</option>${statuses.map(s => `<option ${f.status === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>` : ""}
      ${me() ? `<label class="inline-check"><input type="checkbox" name="mine" data-act="filter" data-key="${key}" ${f.mine ? "checked" : ""}> Ball in my court</label>` : ""}
      ${extra || ""}
    </div>`;
  }

  function matchFilter(key, rec, text, isOpen, bic) {
    const f = getFilter(key);
    if (f.q && !text.toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.status === "__open" && !isOpen) return false;
    if (f.status && f.status !== "__open" && rec.data.status !== f.status) return false;
    if (f.mine && !(bic || []).includes(me())) return false;
    return true;
  }

  // ───────────────────────── Portfolio ─────────────────────────
  const PROJECT_FIELDS = [
    { k: "name", label: "Project Name", req: true },
    { k: "number", label: "Project Number" },
    { k: "status", label: "Status", type: "select", options: PROJECT_STATUSES, blank: false },
    { k: "type", label: "Project Type", type: "select", options: ["Commercial", "Residential", "Industrial", "Institutional", "Healthcare", "Data Center", "Service", "Other"] },
    { k: "address", label: "Address", full: true },
    { k: "city", label: "City" },
    { k: "state", label: "State" },
    { k: "start", label: "Start Date", type: "date" },
    { k: "end", label: "Completion Date", type: "date" },
    { k: "value", label: "Contract Value ($)", type: "money" },
    { k: "ownerId", label: "Owner / Client", type: "company" },
    { k: "pmId", label: "Project Manager", type: "contact" },
    { k: "superId", label: "Superintendent / Foreman", type: "contact" },
    { k: "description", label: "Description", type: "textarea" }
  ];

  function editProject(p) {
    const isNew = !p;
    openModal({
      title: isNew ? "New Project" : "Edit Project",
      body: formHTML(PROJECT_FIELDS, p ? p.data : { status: "Active" }),
      saveLabel: isNew ? "Create Project" : "Save",
      onSave: async root => {
        const vals = readForm(root, PROJECT_FIELDS);
        const rec = p ? { ...p, data: { ...p.data, ...vals } } : { id: uid("prj"), type: "project", projectId: "", data: { ...vals, team: [], createdAt: new Date().toISOString(), createdBy: meName() } };
        // Make PM and superintendent part of the team automatically
        rec.data.team = rec.data.team || [];
        [["pmId", "Project Manager"], ["superId", "Superintendent"]].forEach(([k, role]) => {
          if (rec.data[k] && !rec.data.team.some(t => t.contactId === rec.data[k])) rec.data.team.push({ contactId: rec.data[k], role });
        });
        withHistory(rec, isNew ? "Project created" : "Project details updated");
        if (!(await saveRec(rec, isNew ? "Project created" : "Project saved"))) return false;
        if (isNew) location.hash = "#/p/" + rec.id;
      }
    });
  }
  ACTIONS.newProject = () => editProject(null);
  ACTIONS.editProject = el => editProject(Store.get(el.dataset.id));

  function portfolio() {
    const key = "portfolio";
    LIST_RENDERERS[key] = () => {
      const rows = Store.all("project")
        .filter(p => matchFilter(key, p, [p.data.name, p.data.number, p.data.address, p.data.city].join(" "), !["Completed", "Archived"].includes(p.data.status)))
        .sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));
      if (!rows.length) return `<tr><td colspan="7" class="empty">No projects match. ${Store.all("project").length ? "" : "Create your first project to get started."}</td></tr>`;
      return rows.map(p => `<tr class="click" data-href="#/p/${p.id}">
        <td class="nowrap">${esc(p.data.number)}</td>
        <td><a href="#/p/${p.id}">${esc(p.data.name)}</a></td>
        <td>${esc([p.data.address, p.data.city, p.data.state].filter(Boolean).join(", "))}</td>
        <td>${pill(p.data.status)}</td>
        <td class="nowrap">${esc(contactName(p.data.pmId))}</td>
        <td class="nowrap">${fmtDate(p.data.start)}${p.data.end ? " – " + fmtDate(p.data.end) : ""}</td>
        <td class="nowrap">${money(p.data.value)}</td></tr>`).join("");
    };
    const all = Store.all("project");
    const by = s => all.filter(p => p.data.status === s).length;
    const totalValue = all.filter(p => p.data.status === "Active").reduce((s, p) => s + (Number(p.data.value) || 0), 0);
    return `
      <div class="page-head"><h1>Portfolio</h1><span class="sub">${all.length} project${all.length === 1 ? "" : "s"}</span>
        <div class="actions"><button class="btn primary" data-perm="company:admin" data-act="newProject">+ Create Project</button></div></div>
      <div class="cards">
        <div class="card"><div class="num">${by("Active")}</div><div class="lbl">Active projects</div></div>
        <div class="card"><div class="num">${by("Bidding")}</div><div class="lbl">Bidding</div></div>
        <div class="card"><div class="num">${by("On Hold")}</div><div class="lbl">On hold</div></div>
        <div class="card"><div class="num">${money(totalValue) || "$0"}</div><div class="lbl">Active contract value</div></div>
      </div>
      <div class="panel flush">
        ${toolbarHTML(key, PROJECT_STATUSES).replace(/<label class="inline-check">.*?<\/label>/s, "")}
        <div class="table-wrap"><table class="list"><thead><tr><th>Number</th><th>Name</th><th>Location</th><th>Status</th><th>PM</th><th>Schedule</th><th>Value</th></tr></thead>
        <tbody id="listBody">${LIST_RENDERERS[key]()}</tbody></table></div>
      </div>`;
  }

  // ───────────────────────── Directory ─────────────────────────
  const COMPANY_FIELDS = [
    { k: "name", label: "Company Name", req: true },
    { k: "companyType", label: "Type", type: "select", options: COMPANY_TYPES },
    { k: "trade", label: "Trade", type: "select", options: TRADES },
    { k: "phone", label: "Phone", type: "tel" },
    { k: "email", label: "Email", type: "email" },
    { k: "website", label: "Website" },
    { k: "address", label: "Address", full: true },
    { k: "license", label: "License #" },
    { k: "notes", label: "Notes", type: "textarea" }
  ];
  const CONTACT_FIELDS = [
    { k: "name", label: "Full Name", req: true },
    { k: "companyId", label: "Company", type: "company" },
    { k: "title", label: "Job Title" },
    { k: "trade", label: "Trade", type: "select", options: TRADES },
    { k: "email", label: "Email", type: "email" },
    { k: "phone", label: "Phone", type: "tel" },
    { k: "notes", label: "Notes", type: "textarea" }
  ];

  function editCompany(c) {
    openModal({
      title: c ? "Edit Company" : "Add Company",
      body: formHTML(COMPANY_FIELDS, c ? c.data : {}),
      onSave: async root => {
        const vals = readForm(root, COMPANY_FIELDS);
        const rec = c ? { ...c, data: { ...c.data, ...vals } } : { id: uid("co"), type: "company", projectId: "", data: vals };
        return saveRec(rec, "Company saved");
      }
    });
  }
  function editContact(c, after) {
    openModal({
      title: c ? "Edit Person" : "Add Person",
      body: formHTML(CONTACT_FIELDS, c ? c.data : {}),
      onSave: async root => {
        const vals = readForm(root, CONTACT_FIELDS);
        const rec = c ? { ...c, data: { ...c.data, ...vals } } : { id: uid("ct"), type: "contact", projectId: "", data: vals };
        const ok = await saveRec(rec, "Person saved");
        if (ok && after) after(rec);
        return ok;
      }
    });
  }
  ACTIONS.newCompany = () => editCompany(null);
  ACTIONS.editCompany = el => editCompany(Store.get(el.dataset.id));
  ACTIONS.newContact = () => editContact(null);
  ACTIONS.editContact = el => editContact(Store.get(el.dataset.id));
  ACTIONS.deleteRecord = async el => {
    const rec = Store.get(el.dataset.id);
    if (!rec || !confirmDialog(`Delete this ${el.dataset.label || rec.type}? This cannot be undone.`)) return;
    try {
      await Store.remove(rec.id, el.dataset.children === "1");
      toast("Deleted");
      if (el.dataset.back) location.hash = el.dataset.back; else render();
    } catch (e) { toast("Delete failed: " + e.message, true); }
  };

  function directory(tab) {
    const key = "dir_" + tab;
    if (tab === "people") {
      LIST_RENDERERS[key] = () => {
        const rows = contacts().filter(c => matchFilter(key, c, [c.data.name, companyName(c.data.companyId), c.data.title, c.data.email, c.data.trade].join(" "), true));
        if (!rows.length) return `<tr><td colspan="7" class="empty">No people yet.</td></tr>`;
        return rows.map(c => `<tr>
          <td><strong>${esc(c.data.name)}</strong></td><td>${esc(companyName(c.data.companyId))}</td><td>${esc(c.data.title)}</td><td>${esc(c.data.trade)}</td>
          <td>${c.data.email ? `<a href="mailto:${esc(c.data.email)}">${esc(c.data.email)}</a>` : ""}</td>
          <td class="nowrap">${c.data.phone ? `<a href="tel:${esc(c.data.phone)}">${esc(c.data.phone)}</a>` : ""}</td>
          <td class="nowrap"><button class="btn small" data-perm="company:admin" data-act="editContact" data-id="${c.id}">Edit</button> <button class="btn small danger" data-perm="company:admin" data-act="deleteRecord" data-id="${c.id}" data-label="person">Delete</button></td></tr>`).join("");
      };
    } else {
      LIST_RENDERERS[key] = () => {
        const rows = companies().filter(c => matchFilter(key, c, [c.data.name, c.data.companyType, c.data.trade, c.data.email].join(" "), true));
        if (!rows.length) return `<tr><td colspan="7" class="empty">No companies yet.</td></tr>`;
        return rows.map(c => {
          const n = Store.all("contact").filter(x => x.data.companyId === c.id).length;
          return `<tr>
          <td><strong>${esc(c.data.name)}</strong></td><td>${esc(c.data.companyType)}</td><td>${esc(c.data.trade)}</td>
          <td class="nowrap">${esc(c.data.phone)}</td><td>${c.data.email ? `<a href="mailto:${esc(c.data.email)}">${esc(c.data.email)}</a>` : ""}</td><td>${n}</td>
          <td class="nowrap"><button class="btn small" data-perm="company:admin" data-act="editCompany" data-id="${c.id}">Edit</button> <button class="btn small danger" data-perm="company:admin" data-act="deleteRecord" data-id="${c.id}" data-label="company">Delete</button></td></tr>`;
        }).join("");
      };
    }
    const head = tab === "people"
      ? "<th>Name</th><th>Company</th><th>Title</th><th>Trade</th><th>Email</th><th>Phone</th><th></th>"
      : "<th>Company</th><th>Type</th><th>Trade</th><th>Phone</th><th>Email</th><th>People</th><th></th>";
    return `
      <div class="page-head"><h1>Company Directory</h1>
        <div class="actions"><button class="btn" data-perm="company:admin" data-act="newCompany">+ Add Company</button><button class="btn primary" data-perm="company:admin" data-act="newContact">+ Add Person</button></div></div>
      <div class="panel flush">
        <div class="toolbar">
          <a class="btn ${tab === "companies" ? "primary" : ""}" href="#/directory/companies">Companies (${Store.all("company").length})</a>
          <a class="btn ${tab === "people" ? "primary" : ""}" href="#/directory/people">People (${Store.all("contact").length})</a>
          <input type="search" name="q" data-act="filter" data-key="${key}" placeholder="Search…" value="${esc(getFilter(key).q)}">
        </div>
        <div class="table-wrap"><table class="list"><thead><tr>${head}</tr></thead><tbody id="listBody">${LIST_RENDERERS[key]()}</tbody></table></div>
      </div>`;
  }

  // ───────────────────────── Project team ─────────────────────────
  ACTIONS.addTeam = el => {
    const p = Store.get(el.dataset.id);
    const inTeam = new Set((p.data.team || []).map(t => t.contactId));
    const avail = contacts().filter(c => !inTeam.has(c.id));
    openModal({
      title: "Add People to Project",
      body: avail.length
        ? `<div class="field"><label>Role on this project</label><input name="role" placeholder="e.g. Foreman, Architect, Owner's Rep"></div>
           <div class="field" style="margin-top:12px"><label>People</label><div class="checks" style="max-height:300px">${avail.map(c => `<label><input type="checkbox" value="${c.id}"> ${esc(contactLabel(c.id))}</label>`).join("")}</div></div>
           <p class="muted">Don't see someone? <a href="#" data-newperson>Add a new person</a>.</p>`
        : `<p>Everyone in the directory is already on this project.</p><p><a href="#" data-newperson>Add a new person</a></p>`,
      onOpen: root => {
        const link = $("[data-newperson]", root);
        if (link) link.onclick = e => { e.preventDefault(); closeModal(); editContact(null, () => setTimeout(() => ACTIONS.addTeam(el), 0)); };
      },
      onSave: async root => {
        const ids = $$(".checks input:checked", root).map(i => i.value);
        if (!ids.length) return true;
        const role = ($("[name=role]", root) || {}).value || "";
        const rec = { ...p, data: { ...p.data, team: [...(p.data.team || []), ...ids.map(id => ({ contactId: id, role }))] } };
        withHistory(rec, `Added ${ids.map(contactName).join(", ")} to project team`);
        return saveRec(rec, "Team updated");
      }
    });
  };
  ACTIONS.removeTeam = async el => {
    const p = Store.get(el.dataset.id);
    if (!confirmDialog(`Remove ${contactName(el.dataset.contact)} from this project?`)) return;
    const rec = { ...p, data: { ...p.data, team: (p.data.team || []).filter(t => t.contactId !== el.dataset.contact) } };
    withHistory(rec, `Removed ${contactName(el.dataset.contact)} from project team`);
    if (await saveRec(rec, "Removed")) render();
  };

  function projectTeam(p) {
    const team = (p.data.team || []).map(t => ({ ...t, c: Store.get(t.contactId) })).filter(t => t.c);
    return `
      <div class="page-head"><h1>Project Directory</h1><span class="sub">${team.length} people</span>
        <div class="actions"><button class="btn primary" data-perm="directory:admin" data-act="addTeam" data-id="${p.id}">+ Add People</button></div></div>
      <div class="panel flush"><div class="table-wrap"><table class="list"><thead><tr><th>Name</th><th>Role</th><th>Company</th><th>Email</th><th>Phone</th><th></th></tr></thead><tbody>
        ${team.length ? team.map(t => `<tr><td><strong>${esc(t.c.data.name)}</strong><div class="muted">${esc(t.c.data.title || "")}</div></td><td>${esc(t.role)}</td><td>${esc(companyName(t.c.data.companyId))}</td>
          <td>${t.c.data.email ? `<a href="mailto:${esc(t.c.data.email)}">${esc(t.c.data.email)}</a>` : ""}</td><td class="nowrap">${t.c.data.phone ? `<a href="tel:${esc(t.c.data.phone)}">${esc(t.c.data.phone)}</a>` : ""}</td>
          <td><button class="btn small danger" data-perm="directory:admin" data-act="removeTeam" data-id="${p.id}" data-contact="${t.contactId}">Remove</button></td></tr>`).join("")
          : `<tr><td colspan="6" class="empty">No one is on this project yet. When the team is empty, assignee pickers show the whole company directory.</td></tr>`}
      </tbody></table></div></div>`;
  }

  // ───────────────────────── Ball-in-court logic ─────────────────────────
  function rfiBIC(r) { return r.data.status === "Open" ? (r.data.assignees || []) : r.data.status === "Draft" ? [r.data.managerId].filter(Boolean) : []; }
  function submittalBIC(s) {
    if (["Closed", "Draft"].includes(s.data.status)) return s.data.status === "Draft" ? [s.data.managerId].filter(Boolean) : [];
    const steps = s.data.workflow || [];
    const pending = steps.find(st => !st.response || st.response === "Pending");
    if (s.data.status === "Revise and Resubmit" || s.data.status === "Rejected") return [s.data.responsibleId || s.data.receivedFromId].filter(Boolean);
    if (pending) return [pending.contactId].filter(Boolean);
    return [s.data.managerId].filter(Boolean);
  }
  function punchBIC(x) {
    if (["Open", "Work Not Accepted"].includes(x.data.status)) return [x.data.assigneeId].filter(Boolean);
    if (x.data.status === "Ready for Review") return [x.data.managerId].filter(Boolean);
    return [];
  }
  const isOverdue = (due, open) => open && due && due < today();
  const bicNames = ids => ids.map(contactName).filter(Boolean).join(", ");

  // ───────────────────────── Project home ─────────────────────────
  function projectHome(p) {
    const rfis = Store.all("rfi", p.id), subs = Store.all("submittal", p.id), punch = Store.all("punch", p.id), logs = Store.all("dailylog", p.id);
    const openR = rfis.filter(r => r.data.status === "Open");
    const openS = subs.filter(s => !["Closed", "Draft", "Approved", "Approved as Noted"].includes(s.data.status));
    const openP = punch.filter(x => x.data.status !== "Closed");
    const overR = openR.filter(r => isOverdue(r.data.due, true)).length;
    const overS = openS.filter(s => isOverdue(s.data.due, true)).length;
    const overP = openP.filter(x => isOverdue(x.data.due, true)).length;
    const todayLog = logs.find(l => l.data.date === today());
    const todayWorkers = todayLog ? (todayLog.data.manpower || []).reduce((s, m) => s + (Number(m.workers) || 0), 0) : 0;

    const mine = [];
    if (me()) {
      openR.filter(r => rfiBIC(r).includes(me())).forEach(r => mine.push({ t: "RFI #" + r.data.number, s: r.data.subject, due: r.data.due, href: `#/p/${p.id}/rfis/${r.id}` }));
      subs.filter(s => submittalBIC(s).includes(me())).forEach(s => mine.push({ t: "Submittal #" + s.data.number + "." + (s.data.revision || 0), s: s.data.title, due: s.data.due, href: `#/p/${p.id}/submittals/${s.id}` }));
      punch.filter(x => punchBIC(x).includes(me())).forEach(x => mine.push({ t: "Punch #" + x.data.number, s: x.data.title, due: x.data.due, href: `#/p/${p.id}/punch/${x.id}` }));
      mine.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    }

    const activity = [];
    [["RFI", rfis, "rfis", r => "#" + r.data.number + " " + r.data.subject], ["Submittal", subs, "submittals", s => "#" + s.data.number + " " + s.data.title], ["Punch", punch, "punch", x => "#" + x.data.number + " " + x.data.title], ["Daily Log", logs, "dailylog", l => fmtDate(l.data.date)], ["Drawing", Store.all("drawing", p.id), "drawings", g => g.data.number + " " + (g.data.title || "")]]
      .forEach(([label, list, tool, name]) => list.forEach(r => (r.data.history || []).forEach(h => activity.push({ ...h, label, name: name(r), href: `#/p/${p.id}/${tool}/${tool === "dailylog" ? r.data.date : r.id}` }))));
    (p.data.history || []).forEach(h => activity.push({ ...h, label: "Project", name: "", href: `#/p/${p.id}` }));
    activity.sort((a, b) => b.at.localeCompare(a.at));

    const d = p.data;
    return `
      <div class="page-head"><div><div class="crumb">${esc(d.number || "")}</div><h1>${esc(d.name)}</h1></div>${pill(d.status)}
        <div class="actions"><button class="btn" data-perm="admin:admin" data-act="editProject" data-id="${p.id}">Edit Project</button><a class="btn primary" data-perm="dailylog:read" href="#/p/${p.id}/dailylog/${today()}">Today's Daily Log</a></div></div>
      <div class="cards">
        <a class="card" data-perm="rfis:read" href="#/p/${p.id}/rfis"><div class="num">${openR.length}</div><div class="lbl">Open RFIs${overR ? ` · <span class="overdue">${overR} overdue</span>` : ""}</div></a>
        <a class="card" data-perm="submittals:read" href="#/p/${p.id}/submittals"><div class="num">${openS.length}</div><div class="lbl">Open submittals${overS ? ` · <span class="overdue">${overS} overdue</span>` : ""}</div></a>
        <a class="card" data-perm="punch:read" href="#/p/${p.id}/punch"><div class="num">${openP.length}</div><div class="lbl">Open punch items${overP ? ` · <span class="overdue">${overP} overdue</span>` : ""}</div></a>
        <a class="card" data-perm="dailylog:read" href="#/p/${p.id}/dailylog/${today()}"><div class="num">${todayWorkers}</div><div class="lbl">Workers on site today</div></a>
      </div>
      <div class="grid cols-2">
        <div>
          <div class="panel"><h2>My Open Items</h2>
            ${!me() ? `<p class="muted">Pick who you are (top right) to see items where the ball is in your court.</p>`
              : mine.length ? `<table class="list"><tbody>${mine.map(m => `<tr class="click" data-href="${m.href}"><td class="nowrap"><a href="${m.href}">${esc(m.t)}</a></td><td>${esc(m.s)}</td><td class="nowrap ${isOverdue(m.due, true) ? "overdue" : ""}">${fmtDate(m.due)}</td></tr>`).join("")}</tbody></table>`
              : `<p class="muted">Nothing waiting on you. 🎉</p>`}
          </div>
          <div class="panel"><h2>Recent Activity</h2>
            ${activity.length ? `<ul class="history">${activity.slice(0, 20).map(a => `<li><a href="${a.href}">${esc(a.label)}${a.name ? " " + esc(a.name) : ""}</a> — ${esc(a.text)} <span class="muted">· ${esc(a.by)} · ${fmtDateTime(a.at)}</span></li>`).join("")}</ul>` : `<p class="muted">No activity yet.</p>`}
          </div>
        </div>
        <div>
          ${PM.people ? PM.people.crewPanel(p, today(), { title: "Crew on site today" }) : ""}
          <div class="panel"><h2>Project Information</h2>
            <div class="info-grid" style="grid-template-columns:1fr">
              <div><div class="k">Address</div><div class="v">${esc([d.address, d.city, d.state].filter(Boolean).join(", ")) || "—"}</div></div>
              <div><div class="k">Owner / Client</div><div class="v">${esc(companyName(d.ownerId)) || "—"}</div></div>
              <div><div class="k">Project Manager</div><div class="v">${esc(contactName(d.pmId)) || "—"}</div></div>
              <div><div class="k">Superintendent</div><div class="v">${esc(contactName(d.superId)) || "—"}</div></div>
              <div><div class="k">Schedule</div><div class="v">${d.start ? fmtDate(d.start) : "—"} → ${d.end ? fmtDate(d.end) : "—"}</div></div>
              <div><div class="k">Contract Value</div><div class="v">${money(d.value) || "—"}</div></div>
              ${d.description ? `<div><div class="k">Description</div><div class="v prose">${esc(d.description)}</div></div>` : ""}
            </div>
          </div>
          <div class="panel"><div class="section-head"><h2 style="margin:0">Team</h2><a data-perm="directory:read" href="#/p/${p.id}/team">Manage</a></div>
            ${(d.team || []).length ? (d.team || []).slice(0, 12).map(t => `<div style="margin:6px 0"><strong>${esc(contactName(t.contactId))}</strong> <span class="muted">${esc(t.role || "")}</span></div>`).join("") : `<p class="muted">No team members yet.</p>`}
          </div>
        </div>
      </div>`;
  }

  // ───────────────────────── RFIs ─────────────────────────
  // RFIs are created and edited on full pages (forms.js); from a drawing pin they open in a modal
  function editRFI(p, r, opts = {}) {
    if (opts.onCreated) return PM.forms.rfiModal(p, opts);
    location.hash = r ? `#/p/${p.id}/rfis/${r.id}/edit` : `#/p/${p.id}/rfis/new`;
  }
  ACTIONS.newRFI = el => editRFI(Store.get(el.dataset.project), null);
  ACTIONS.editRFI = el => { const r = Store.get(el.dataset.id); editRFI(Store.get(r.projectId), r); };
  ACTIONS.rfiStatus = async el => {
    const r = Store.get(el.dataset.id);
    const status = el.dataset.status;
    const rec = withHistory({ ...r, data: { ...r.data, status, ...(status === "Closed" ? { closedAt: new Date().toISOString() } : {}), ...(status === "Open" && !r.data.openedAt ? { openedAt: new Date().toISOString() } : {}) } }, `Status changed to ${status}`);
    if (await saveRec(rec, "RFI " + status.toLowerCase())) render();
  };
  ACTIONS.rfiSetStatus = async el => {
    const r = Store.get(el.dataset.id);
    if (!r || el.value === r.data.status) return;
    el.dataset.status = el.value;
    await ACTIONS.rfiStatus(el);
  };
  ACTIONS.rfiRespond = async el => {
    const r = Store.get(el.dataset.id);
    const box = $("#respText");
    const text = box.value.trim();
    if (!text) { toast("Write a response first", true); return; }
    const official = $("#respOfficial").checked;
    const close = $("#respClose").checked;
    const responses = [...(r.data.responses || []), { id: uid("rsp"), by: meName(), byId: me() || "", at: new Date().toISOString(), text, official }];
    const rec = withHistory({ ...r, data: { ...r.data, responses, ...(close ? { status: "Closed", closedAt: new Date().toISOString() } : {}) } }, official ? "Official response added" + (close ? " and RFI closed" : "") : "Response added" + (close ? " and RFI closed" : ""));
    if (await saveRec(rec, "Response posted")) render();
  };
  ACTIONS.rfiOfficial = async el => {
    const r = Store.get(el.dataset.id);
    const responses = (r.data.responses || []).map(x => x.id === el.dataset.resp ? { ...x, official: !x.official } : x);
    const rec = withHistory({ ...r, data: { ...r.data, responses } }, "Official response flag changed");
    if (await saveRec(rec)) render();
  };
  ACTIONS.exportRFIs = el => {
    const p = Store.get(el.dataset.project);
    const rows = [["#", "Subject", "Status", "Ball In Court", "Received From", "Due", "Spec Section", "Location", "Cost Impact", "Cost $", "Schedule Impact", "Days", "Created", "Closed", "Official Answer"]];
    Store.all("rfi", p.id).sort((a, b) => a.data.number - b.data.number).forEach(r => {
      const off = (r.data.responses || []).filter(x => x.official).map(x => x.text).join(" | ");
      rows.push([r.data.number, r.data.subject, r.data.status, bicNames(rfiBIC(r)), contactName(r.data.receivedFromId), r.data.due, r.data.specSection, r.data.location, r.data.costImpact, r.data.costAmount, r.data.scheduleImpact, r.data.scheduleDays, (r.data.createdAt || "").slice(0, 10), (r.data.closedAt || "").slice(0, 10), off]);
    });
    downloadCSV(`${slug(p.data.name)}-rfis.csv`, rows);
  };

  function rfiList(p) {
    const key = "rfi_" + p.id;
    LIST_RENDERERS[key] = () => {
      const rows = Store.all("rfi", p.id)
        .filter(r => matchFilter(key, r, ["#" + r.data.number, r.data.subject, r.data.question, r.data.specSection, r.data.location, bicNames(rfiBIC(r))].join(" "), r.data.status !== "Closed", rfiBIC(r)))
        .sort((a, b) => b.data.number - a.data.number);
      if (!rows.length) return `<tr><td colspan="7" class="empty">No RFIs found.</td></tr>`;
      return rows.map(r => {
        const open = r.data.status !== "Closed";
        return `<tr class="click" data-href="#/p/${p.id}/rfis/${r.id}">
          <td class="nowrap"><a href="#/p/${p.id}/rfis/${r.id}">#${r.data.number}</a></td>
          <td>${esc(r.data.subject)}${r.data.private ? ' <span class="muted">🔒</span>' : ""}</td>
          <td>${pill(r.data.status)}</td>
          <td>${esc(bicNames(rfiBIC(r)))}</td>
          <td class="nowrap ${isOverdue(r.data.due, open) ? "overdue" : ""}">${fmtDate(r.data.due)}</td>
          <td>${(r.data.responses || []).length}</td>
          <td class="nowrap">${esc(r.data.costImpact === "Yes" ? "$ " : "")}${esc(r.data.scheduleImpact === "Yes" ? "⏱" : "")}</td></tr>`;
      }).join("");
    };
    return `
      <div class="page-head"><h1>RFIs</h1><span class="sub">Requests for Information</span>
        <div class="actions"><button class="btn" id="rfiListExportBtn" data-act="rfiExportList" data-project="${p.id}" aria-haspopup="true">Export ▾</button><button class="btn primary" data-perm="rfis:standard" data-act="newRFI" data-project="${p.id}">+ Create RFI</button></div></div>
      <div class="panel flush">${toolbarHTML(key, RFI_STATUSES)}
        <div class="table-wrap"><table class="list"><thead><tr><th>#</th><th>Subject</th><th>Status</th><th>Ball In Court</th><th>Due</th><th>Responses</th><th>Impact</th></tr></thead>
        <tbody id="listBody">${LIST_RENDERERS[key]()}</tbody></table></div></div>`;
  }

  function rfiDetail(p, id) {
    const r = Store.get(id);
    if (!r || r.type !== "rfi") return `<div class="empty">RFI not found. <a href="#/p/${p.id}/rfis">Back to RFIs</a></div>`;
    const d = r.data;
    const open = d.status !== "Closed";
    const info = [
      ["Status", pill(d.status)], ["Ball In Court", esc(bicNames(rfiBIC(r))) || "—"], ["Due Date", `<span class="${isOverdue(d.due, open) ? "overdue" : ""}">${fmtDate(d.due) || "—"}</span>`],
      ["RFI Manager", esc(contactName(d.managerId)) || "—"], ["Received From", esc(contactLabel(d.receivedFromId)) || "—"], ["Assignees", esc((d.assignees || []).map(contactName).join(", ")) || "—"],
      ["Distribution List", esc((d.distribution || []).map(contactName).join(", ")) || "—"], ["Responsible Contractor", esc(companyName(d.responsibleCompanyId)) || "—"],
      ["Spec Section", esc(d.specSection) || "—"], ["Drawing Number", esc(d.drawing) || "—"], ["Location", esc(d.location) || "—"],
      ["Cost Impact", esc(d.costImpact || "—") + (d.costAmount !== "" && d.costAmount != null ? " · " + money(d.costAmount) : "")],
      ["Schedule Impact", esc(d.scheduleImpact || "—") + (d.scheduleDays ? ` · ${esc(d.scheduleDays)} days` : "")],
      ["Created", `${fmtDate(d.createdAt)} by ${esc(d.createdBy || "")}`]
    ];
    return `
      <div class="crumb"><a href="#/p/${p.id}/rfis">RFIs</a> / #${d.number}</div>
      <div class="page-head"><h1>RFI #${d.number}: ${esc(d.subject)}</h1>
        <div class="actions">
          ${d.status === "Draft" ? `<button class="btn primary" data-perm="rfis:standard" data-act="rfiStatus" data-id="${r.id}" data-status="Open">Open RFI</button>` : ""}
          ${d.status === "Open" ? `<button class="btn" data-perm="rfis:standard" data-act="rfiStatus" data-id="${r.id}" data-status="Closed">Close</button>` : ""}
          ${d.status === "Closed" ? `<button class="btn" data-perm="rfis:standard" data-act="rfiStatus" data-id="${r.id}" data-status="Open">Reopen</button>` : ""}
          <select class="status-select" data-perm="rfis:standard" data-act="rfiSetStatus" data-id="${r.id}" aria-label="Change status" title="Change status">
            ${RFI_STATUSES.map(st => `<option value="${st}" ${st === d.status ? "selected" : ""}>Status: ${st}</option>`).join("")}</select>
          <button class="btn" data-perm="rfis:standard" data-act="editRFI" data-id="${r.id}">Edit</button>
          <button class="btn" id="rfiExportBtn" data-act="rfiExport" data-id="${r.id}" aria-haspopup="true">Export ▾</button>
          <button class="btn danger" data-perm="rfis:admin" data-act="deleteRecord" data-id="${r.id}" data-label="RFI" data-back="#/p/${p.id}/rfis">Delete</button>
        </div></div>
      <div class="panel"><div class="info-grid">${info.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div></div>
      <div class="panel"><h2>Question</h2>${PM.forms.richHTML(d.questionHtml, d.question)}
        ${(d.attachments || []).length ? `<h3 style="margin-top:14px">Attachments</h3>${PM.forms.attachmentsView(d.attachments)}` : ""}
        ${d.suggestion ? `<h3 style="margin-top:14px">Suggested Answer</h3><div class="prose">${esc(d.suggestion)}</div>` : ""}</div>
      <div class="panel"><h2>Responses (${(d.responses || []).length})</h2>
        ${(d.responses || []).map(x => `<div class="thread"><div class="meta"><strong>${esc(x.by)}</strong> · ${fmtDateTime(x.at)} ${x.official ? pill("Official") : ""}
          <button class="btn small no-print" data-perm="rfis:standard" data-act="rfiOfficial" data-id="${r.id}" data-resp="${x.id}">${x.official ? "Unmark official" : "Mark official"}</button></div><div class="prose">${esc(x.text)}</div></div>`).join("") || `<p class="muted">No responses yet.</p>`}
        ${d.status !== "Draft" ? `<div class="no-print" style="margin-top:14px" data-perm="rfis:standard">
          <div class="field"><label for="respText">Add a response</label><div class="with-mic top"><textarea id="respText" placeholder="Type or dictate your response…"></textarea>${PM.forms.micBtn("respText")}</div></div>
          <div style="display:flex;gap:16px;align-items:center;margin-top:8px;flex-wrap:wrap">
            <label class="inline-check"><input type="checkbox" id="respOfficial"> Official response</label>
            ${open ? `<label class="inline-check"><input type="checkbox" id="respClose"> Close RFI</label>` : `<input type="checkbox" id="respClose" hidden>`}
            <button class="btn primary" data-act="rfiRespond" data-id="${r.id}">Post Response</button></div></div>` : `<p class="muted no-print">Open the RFI to collect responses.</p>`}
      </div>
      ${drawingLinksPanel(p, r.id)}
      ${PM.drawings && PM.drawings.rfiMarkupsPanel ? PM.drawings.rfiMarkupsPanel(p, r) : ""}
      ${historyPanel(d)}`;
  }

  function drawingLinksPanel(p, targetId) {
    return PM.drawings ? PM.drawings.linksPanel(p, targetId) : "";
  }

  function historyPanel(d) {
    const h = (d.history || []).slice().reverse();
    return `<div class="panel no-print"><h2>Change History</h2>${h.length ? `<ul class="history">${h.map(x => `<li>${esc(x.text)} <span class="muted">· ${esc(x.by)} · ${fmtDateTime(x.at)}</span></li>`).join("")}</ul>` : `<p class="muted">No changes recorded.</p>`}</div>`;
  }

  // ───────────────────────── Submittals ─────────────────────────
  // Submittals are created and edited on full pages (forms.js)
  function editSubmittal(p, sub, revisionOf) {
    location.hash = revisionOf ? `#/p/${p.id}/submittals/new?revisionOf=${revisionOf.id}`
      : sub ? `#/p/${p.id}/submittals/${sub.id}/edit` : `#/p/${p.id}/submittals/new`;
  }

  function deriveSubStatus(s) {
    if (s.data.status === "Closed") return "Closed";
    const steps = s.data.workflow || [];
    if (!steps.length) return s.data.status === "Draft" ? "Draft" : s.data.status;
    const responses = steps.map(w => w.response || "Pending");
    if (responses.includes("Rejected")) return "Rejected";
    if (responses.includes("Revise and Resubmit")) return "Revise and Resubmit";
    if (responses.includes("Pending")) return s.data.status === "Draft" ? "Draft" : "Open";
    if (responses.includes("Approved as Noted")) return "Approved as Noted";
    return "Approved";
  }

  ACTIONS.newSubmittal = el => editSubmittal(Store.get(el.dataset.project), null);
  ACTIONS.editSubmittal = el => { const s = Store.get(el.dataset.id); editSubmittal(Store.get(s.projectId), s); };
  ACTIONS.reviseSubmittal = el => { const s = Store.get(el.dataset.id); editSubmittal(Store.get(s.projectId), null, s); };
  ACTIONS.subStatus = async el => {
    const s = Store.get(el.dataset.id);
    const status = el.dataset.status;
    const rec = withHistory({ ...s, data: { ...s.data, status, ...(status === "Closed" ? { closedAt: new Date().toISOString() } : {}) } }, `Status changed to ${status}`);
    if (status === "Open") rec.data.status = deriveSubStatus({ ...rec, data: { ...rec.data, status: "Open" } });
    if (await saveRec(rec, "Submittal updated")) render();
  };
  ACTIONS.subRespond = async el => {
    const s = Store.get(el.dataset.id);
    const idx = Number(el.dataset.step);
    const response = $("#stepResp").value;
    const comments = $("#stepComments").value.trim();
    if (!response || response === "Pending") { toast("Choose a response", true); return; }
    const workflow = (s.data.workflow || []).map((w, i) => i === idx ? { ...w, response, comments, at: new Date().toISOString(), by: meName() } : w);
    const rec = withHistory({ ...s, data: { ...s.data, workflow } }, `${contactName(s.data.workflow[idx].contactId)} responded: ${response}`);
    rec.data.status = deriveSubStatus(rec);
    if (await saveRec(rec, "Response recorded")) render();
  };
  ACTIONS.exportSubmittals = el => {
    const p = Store.get(el.dataset.project);
    const rows = [["#", "Rev", "Title", "Spec Section", "Type", "Status", "Ball In Court", "Responsible", "Submit By", "Received", "Due", "Required On Site", "Lead Time"]];
    Store.all("submittal", p.id).sort((a, b) => a.data.number - b.data.number || a.data.revision - b.data.revision).forEach(s => {
      const d = s.data;
      rows.push([d.number, d.revision || 0, d.title, d.specSection, d.subType, d.status, bicNames(submittalBIC(s)), subResponsible(d), d.submitBy, d.received, d.due, d.requiredOnSite, d.leadTime]);
    });
    downloadCSV(`${slug(p.data.name)}-submittals.csv`, rows);
  };

  function submittalList(p) {
    const key = "sub_" + p.id;
    LIST_RENDERERS[key] = () => {
      const trade = getFilter(key).trade || "";
      const pkgTrade = s => { const k = Store.get(s.data.packageId); return k ? k.data.trade || "" : ""; };
      const rows = Store.all("submittal", p.id)
        .filter(s => !trade || pkgTrade(s) === trade)
        .filter(s => matchFilter(key, s, ["#" + s.data.number, s.data.title, s.data.specSection, s.data.subType, bicNames(submittalBIC(s)), subResponsible(s.data), PM.forms.packageName(s.data.packageId) || s.data.package || ""].join(" "), s.data.status !== "Closed", submittalBIC(s)))
        .sort((a, b) => (a.data.specSection || "").localeCompare(b.data.specSection || "") || a.data.number - b.data.number || a.data.revision - b.data.revision);
      if (!rows.length) return `<tr><td colspan="9" class="empty">No submittals found.</td></tr>`;
      return rows.map(s => {
        const d = s.data;
        const open = !["Closed", "Approved", "Approved as Noted"].includes(d.status);
        return `<tr class="click" data-href="#/p/${p.id}/submittals/${s.id}">
          <td class="nowrap">${esc(d.specSection)}</td>
          <td class="nowrap"><a href="#/p/${p.id}/submittals/${s.id}">#${d.number}.${d.revision || 0}</a></td>
          <td>${esc(d.title)}</td>
          <td>${d.packageId && Store.get(d.packageId) ? `<a href="#/p/${p.id}/submittals/packages/${d.packageId}">${esc(PM.forms.packageName(d.packageId))}</a>` : esc(d.package || "")}</td>
          <td>${esc(d.subType)}</td><td>${pill(d.status)}</td>
          <td>${esc(bicNames(submittalBIC(s)))}</td>
          <td>${esc(subResponsible(d))}</td>
          <td class="nowrap ${isOverdue(d.due, open) ? "overdue" : ""}">${fmtDate(d.due)}</td></tr>`;
      }).join("");
    };
    return `
      <div class="page-head"><h1>Submittals</h1>
        <div class="actions"><button class="btn" data-act="exportSubmittals" data-project="${p.id}">Export CSV</button><button class="btn primary" data-perm="submittals:standard" data-act="newSubmittal" data-project="${p.id}">+ Create Submittal</button></div></div>
      ${PM.forms.subTabs(p, "items")}
      <div class="panel flush">${toolbarHTML(key, SUB_STATUSES, (() => { const trades = [...new Set(PM.forms.packagesOf(p).map(k => k.data.trade).filter(Boolean))].sort(); const f = getFilter(key); return trades.length ? `<select name="trade" data-act="filter" data-key="${key}" aria-label="Trade"><option value="">All trades</option>${trades.map(t => `<option ${f.trade === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>` : ""; })())}
        <div class="table-wrap"><table class="list"><thead><tr><th>Spec Section</th><th>#</th><th>Title</th><th>Package</th><th>Type</th><th>Status</th><th>Ball In Court</th><th>Responsible</th><th>Due</th></tr></thead>
        <tbody id="listBody">${LIST_RENDERERS[key]()}</tbody></table></div></div>`;
  }

  function subResponsible(d) { return companyName(d.responsibleCompanyId) || contactLabel(d.responsibleId); }

  function submittalDetail(p, id) {
    const s = Store.get(id);
    if (!s || s.type !== "submittal") return `<div class="empty">Submittal not found. <a href="#/p/${p.id}/submittals">Back to submittals</a></div>`;
    const d = s.data;
    const steps = d.workflow || [];
    const pendingIdx = steps.findIndex(w => !w.response || w.response === "Pending");
    const revisions = Store.all("submittal", p.id).filter(x => x.data.number === d.number && x.id !== s.id).sort((a, b) => a.data.revision - b.data.revision);
    const open = !["Closed", "Approved", "Approved as Noted"].includes(d.status);
    const info = [
      ["Status", pill(d.status)], ["Ball In Court", esc(bicNames(submittalBIC(s))) || "—"], ["Final Due", `<span class="${isOverdue(d.due, open) ? "overdue" : ""}">${fmtDate(d.due) || "—"}</span>`],
      ["Spec Section", esc(d.specSection) || "—"], ["Type", esc(d.subType) || "—"], ["Location", esc(d.location) || "—"],
      ["Submittal Manager", esc(contactName(d.managerId)) || "—"], ["Responsible Contractor", esc(subResponsible(d)) || "—"], ["Received From", esc(contactLabel(d.receivedFromId)) || "—"],
      ["Submittal Package", d.packageId && Store.get(d.packageId) ? `<a href="#/p/${p.id}/submittals/packages/${d.packageId}">${esc(PM.forms.packageName(d.packageId))}</a> <span class="muted">(${esc(Store.get(d.packageId).data.trade || "")})</span>` : esc(d.package) || "—"], ["Cost Code", esc(d.costCode) || "—"], ["Issue Date", fmtDate(d.issueDate) || "—"],
      ["Submit By", fmtDate(d.submitBy) || "—"], ["Received", fmtDate(d.received) || "—"], ["Required On Site", fmtDate(d.requiredOnSite) || "—"],
      ["Distribution List", esc((d.distribution || []).map(contactName).join(", ")) || "—"],
      ["Linked Drawings", (d.linkedDrawings || []).map(id => Store.get(id)).filter(Boolean).map(g => `<a href="#/p/${p.id}/drawings/${g.id}">${esc(g.data.number)}</a>`).join(", ") || "—"],
      ["Private", d.private ? "Yes" : "No"],
      ["Lead Time", d.leadTime ? esc(d.leadTime) + " days" : "—"],
      ["Order By", d.requiredOnSite && d.leadTime ? fmtDate(addDays(d.requiredOnSite, -Number(d.leadTime))) : "—"],
      ["Created", `${fmtDate(d.createdAt)} by ${esc(d.createdBy || "")}`]
    ];
    return `
      <div class="crumb"><a href="#/p/${p.id}/submittals">Submittals</a> / #${d.number}.${d.revision || 0}</div>
      <div class="page-head"><h1>Submittal #${d.number}.${d.revision || 0}: ${esc(d.title)}</h1>
        <div class="actions">
          ${d.status === "Draft" ? `<button class="btn primary" data-perm="submittals:standard" data-act="subStatus" data-id="${s.id}" data-status="Open">Send for Review</button>` : ""}
          ${["Revise and Resubmit", "Rejected"].includes(d.status) ? `<button class="btn primary" data-perm="submittals:standard" data-act="reviseSubmittal" data-id="${s.id}">Create Revision</button>` : ""}
          ${d.status !== "Closed" && d.status !== "Draft" ? `<button class="btn" data-perm="submittals:standard" data-act="subStatus" data-id="${s.id}" data-status="Closed">Close</button>` : ""}
          ${d.status === "Closed" ? `<button class="btn" data-perm="submittals:standard" data-act="subStatus" data-id="${s.id}" data-status="Open">Reopen</button>` : ""}
          <button class="btn" data-perm="submittals:standard" data-act="editSubmittal" data-id="${s.id}">Edit</button>
          <button class="btn" onclick="window.print()">Print / PDF</button>
          <button class="btn danger" data-perm="submittals:admin" data-act="deleteRecord" data-id="${s.id}" data-label="submittal" data-back="#/p/${p.id}/submittals">Delete</button>
        </div></div>
      <div class="panel"><div class="info-grid">${info.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
        ${d.description || d.descriptionHtml ? `<h3 style="margin-top:16px">Description</h3>${PM.forms.richHTML(d.descriptionHtml, d.description)}` : ""}
        ${(d.attachments || []).length ? `<h3 style="margin-top:16px">Attachments</h3>${PM.forms.attachmentsView(d.attachments)}` : ""}</div>
      <div class="panel"><h2>Approval Workflow</h2>
        ${steps.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Step</th><th>Approver</th><th>Response</th><th>Comments</th><th>Returned</th></tr></thead><tbody>
          ${steps.map((w, i) => `<tr><td>${i + 1}</td><td>${esc(contactLabel(w.contactId))}</td><td>${pill(w.response || "Pending")}</td><td class="prose">${esc(w.comments)}</td><td class="nowrap">${w.at ? fmtDate(w.at) : ""}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">No approvers. Edit the submittal to add a workflow.</p>`}
        ${pendingIdx >= 0 && d.status === "Open" ? `<div class="no-print" data-perm="submittals:standard" style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
          <h3>Respond as ${esc(contactName(steps[pendingIdx].contactId))} (step ${pendingIdx + 1})</h3>
          <div class="form-grid">
            <div class="field"><label for="stepResp">Response</label><select id="stepResp">${SUB_RESPONSES.map(x => `<option>${x}</option>`).join("")}</select></div>
            <div class="field full"><label for="stepComments">Comments</label><textarea id="stepComments"></textarea></div>
          </div>
          <button class="btn primary" style="margin-top:8px" data-act="subRespond" data-id="${s.id}" data-step="${pendingIdx}">Submit Response</button></div>` : ""}
      </div>
      ${revisions.length ? `<div class="panel"><h2>Other Revisions</h2>${revisions.map(x => `<div><a href="#/p/${p.id}/submittals/${x.id}">#${x.data.number}.${x.data.revision}</a> ${pill(x.data.status)} <span class="muted">${fmtDate(x.data.createdAt)}</span></div>`).join("")}</div>` : ""}
      ${historyPanel(d)}`;
  }

  // ───────────────────────── Daily log ─────────────────────────
  const LOG_SECTIONS = [
    { k: "manpower", title: "Manpower", cols: [{ k: "companyId", label: "Company", type: "company" }, { k: "workers", label: "Workers", type: "number", w: 90 }, { k: "hours", label: "Hours each", type: "number", w: 90 }, { k: "location", label: "Location" }, { k: "notes", label: "Comments" }] },
    { k: "work", title: "Work Performed", cols: [{ k: "area", label: "Area / Location" }, { k: "description", label: "Description of work" }, { k: "percent", label: "% Complete", type: "number", w: 100 }] },
    { k: "equipment", title: "Equipment", cols: [{ k: "name", label: "Equipment" }, { k: "hours", label: "Hours", type: "number", w: 90 }, { k: "idle", label: "Idle?", type: "select", options: ["", "No", "Yes"], w: 90 }, { k: "notes", label: "Comments" }] },
    { k: "deliveries", title: "Deliveries", cols: [{ k: "from", label: "Delivery From" }, { k: "tracking", label: "Tracking / PO #" }, { k: "contents", label: "Contents" }, { k: "time", label: "Time", w: 100 }] },
    { k: "visitors", title: "Visitors & Inspections", cols: [{ k: "name", label: "Visitor / Inspector" }, { k: "type", label: "Purpose", type: "select", options: ["", "Inspection", "Owner Visit", "Architect/Engineer", "Utility", "Vendor", "Other"] }, { k: "result", label: "Result", type: "select", options: ["", "Passed", "Failed", "Partial", "N/A"], w: 110 }, { k: "notes", label: "Comments" }] },
    { k: "safety", title: "Safety & Incidents", cols: [{ k: "type", label: "Type", type: "select", options: ["", "Toolbox Talk", "Observation", "Near Miss", "Incident", "Injury", "Property Damage"] }, { k: "description", label: "Description" }, { k: "action", label: "Corrective Action" }] },
    { k: "delays", title: "Delays", cols: [{ k: "type", label: "Type", type: "select", options: ["", "Weather", "Material", "Labor", "Inspection", "Owner", "Design", "Other"] }, { k: "hours", label: "Hours lost", type: "number", w: 100 }, { k: "description", label: "Description" }] }
  ];

  function logId(p, date) { return "log_" + p.id + "_" + date.replace(/-/g, ""); }

  function subRowHTML(sec, row) {
    return `<tr>${sec.cols.map(c => {
      const v = row[c.k] == null ? "" : row[c.k];
      let input;
      if (c.type === "company") input = `<select data-col="${c.k}"><option value=""></option>${companies().map(co => `<option value="${co.id}" ${co.id === v ? "selected" : ""}>${esc(co.data.name)}</option>`).join("")}</select>`;
      else if (c.type === "select") input = `<select data-col="${c.k}">${c.options.map(o => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      else input = `<input data-col="${c.k}" type="${c.type === "number" ? "number" : "text"}" step="any" value="${esc(v)}">`;
      return `<td ${c.w ? `style="width:${c.w}px"` : ""}>${input}</td>`;
    }).join("")}<td class="x"><button class="btn small" data-rmrow title="Remove row">✕</button></td></tr>`;
  }

  function dailyLog(p, date) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today();
    const rec = Store.get(logId(p, date));
    const d = rec ? rec.data : {};
    const w = d.weather || {};
    const logs = Store.all("dailylog", p.id).sort((a, b) => b.data.date.localeCompare(a.data.date));
    const totalWorkers = (d.manpower || []).reduce((s, m) => s + (Number(m.workers) || 0), 0);
    const totalHours = (d.manpower || []).reduce((s, m) => s + (Number(m.workers) || 0) * (Number(m.hours) || 0), 0);

    setTimeout(() => wireDailyLog(p, date), 0);
    return `
      <div class="page-head"><h1>Daily Log</h1>
        <div class="actions">
          <a class="btn" href="#/p/${p.id}/dailylog/${addDays(date, -1)}">‹ Prev</a>
          <input type="date" id="logDate" value="${date}" style="width:auto">
          <a class="btn" href="#/p/${p.id}/dailylog/${addDays(date, 1)}">Next ›</a>
          <a class="btn" href="#/p/${p.id}/dailylog/${today()}">Today</a>
          <button class="btn" data-act="exportLogs" data-project="${p.id}">Export CSV</button>
          <button class="btn" onclick="window.print()">Print / PDF</button>
        </div></div>
      <div class="grid cols-2">
        <div id="logForm">
          <div class="panel"><div class="section-head"><h2 style="margin:0">${new Date(date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</h2>
            ${rec ? `<span class="muted">Last saved ${fmtDateTime(d.updatedAt)}${d.updatedBy ? " by " + esc(d.updatedBy) : ""}</span>` : `<span class="muted">Not started</span>`}</div>
            ${d.locked ? `<p>${pill("Approved")} This log was approved by ${esc(d.lockedBy || "")} on ${fmtDateTime(d.lockedAt)}. Unlock to edit.</p>` : ""}
          </div>
          <div class="panel"><h2>Weather</h2>
            <div class="form-grid">
              <div class="field"><label>Conditions</label><select data-w="conditions"><option></option>${WEATHER.map(x => `<option ${w.conditions === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
              <div class="field"><label>Ground</label><select data-w="ground"><option></option>${["Dry", "Wet", "Muddy", "Frozen", "Snow-covered"].map(x => `<option ${w.ground === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
              <div class="field"><label>High (°F)</label><input type="number" data-w="high" value="${esc(w.high)}"></div>
              <div class="field"><label>Low (°F)</label><input type="number" data-w="low" value="${esc(w.low)}"></div>
              <div class="field"><label>Precipitation (in)</label><input type="number" step="any" data-w="precip" value="${esc(w.precip)}"></div>
              <div class="field"><label class="inline-check" style="margin-top:22px"><input type="checkbox" data-w="delay" ${w.delay ? "checked" : ""}> Weather delay</label></div>
            </div></div>
          ${LOG_SECTIONS.map(sec => `<div class="panel" data-sec="${sec.k}">
            <div class="section-head"><h2 style="margin:0">${sec.title}</h2>
              <span>${sec.k === "manpower" ? `<span class="muted" style="margin-right:8px">${totalWorkers} workers · ${totalHours} man-hours</span><button class="btn small" data-copyprev>Copy from previous log</button> ` : ""}<button class="btn small" data-addrow="${sec.k}">+ Add row</button></span></div>
            <div class="table-wrap"><table class="subtable"><thead><tr>${sec.cols.map(c => `<th>${c.label}</th>`).join("")}<th></th></tr></thead>
            <tbody>${(d[sec.k] || []).map(row => subRowHTML(sec, row)).join("")}</tbody></table></div></div>`).join("")}
          <div class="panel"><h2>General Notes</h2><textarea id="logNotes" placeholder="Notes, issues, instructions received…">${esc(d.notes || "")}</textarea></div>
          <div class="no-print" style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn primary" id="saveLog" data-perm="dailylog:standard">Save Daily Log</button>
            ${rec ? `<button class="btn" id="lockLog" data-perm="dailylog:admin">${d.locked ? "Unlock" : "Mark Approved"}</button>
            <button class="btn danger" data-perm="dailylog:admin" data-act="deleteRecord" data-id="${rec.id}" data-label="daily log" data-back="#/p/${p.id}/dailylog/${date}">Delete Log</button>` : ""}
          </div>
        </div>
        <div class="no-print">
          ${PM.people ? PM.people.dailyLogPanels(p, date, list => fillCrew(p, list)) : ""}
          ${PM.photos ? PM.photos.dayPanel(p, date) : ""}
          <div class="panel"><h2>Logs</h2>
            ${logs.length ? `<table class="list"><thead><tr><th>Date</th><th>Workers</th><th></th></tr></thead><tbody>${logs.slice(0, 40).map(l => `<tr class="click" data-href="#/p/${p.id}/dailylog/${l.data.date}" ${l.data.date === date ? 'style="background:var(--accent-soft)"' : ""}>
              <td class="nowrap"><a href="#/p/${p.id}/dailylog/${l.data.date}">${fmtDate(l.data.date)}</a></td><td>${(l.data.manpower || []).reduce((s, m) => s + (Number(m.workers) || 0), 0)}</td><td>${l.data.locked ? pill("Approved") : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No logs yet.</p>`}
          </div>
        </div>
      </div>`;
  }

  // Daily log → Manpower rows from the people deployed to this project that day (one row per company)
  function fillCrew(p, list) {
    const form = $("#logForm");
    if (!form || $("#saveLog").disabled) return;
    const byCo = {};
    list.forEach(x => { const c = Store.get(x.person.contactId); const co = (c && c.data.companyId) || ""; (byCo[co] = byCo[co] || []).push(x.person.name); });
    const sec = LOG_SECTIONS[0];
    Object.entries(byCo).forEach(([co, names]) => $(`[data-sec="manpower"] tbody`, form).insertAdjacentHTML("beforeend", subRowHTML(sec, { companyId: co, workers: names.length, hours: 8, notes: names.join(", ") })));
    toast(`Added ${list.length} crew member${list.length > 1 ? "s" : ""} — review hours and save`);
  }

  function collectLog() {
    const form = $("#logForm");
    const weather = {};
    $$("[data-w]", form).forEach(el => { weather[el.dataset.w] = el.type === "checkbox" ? el.checked : el.value; });
    const out = { weather, notes: $("#logNotes").value.trim() };
    LOG_SECTIONS.forEach(sec => {
      out[sec.k] = $$(`[data-sec="${sec.k}"] tbody tr`, form).map(tr => {
        const row = {};
        $$("[data-col]", tr).forEach(el => { row[el.dataset.col] = el.value.trim(); });
        return row;
      }).filter(row => Object.values(row).some(v => v !== ""));
    });
    return out;
  }

  function wireDailyLog(p, date) {
    const form = $("#logForm");
    if (!form) return;
    const rec = Store.get(logId(p, date));
    const locked = rec && rec.data.locked;
    $("#logDate").onchange = e => { if (e.target.value) location.hash = `#/p/${p.id}/dailylog/${e.target.value}`; };
    form.addEventListener("click", e => {
      const add = e.target.closest("[data-addrow]");
      if (add) {
        const sec = LOG_SECTIONS.find(s => s.k === add.dataset.addrow);
        $(`[data-sec="${sec.k}"] tbody`, form).insertAdjacentHTML("beforeend", subRowHTML(sec, {}));
        return;
      }
      const rm = e.target.closest("[data-rmrow]");
      if (rm) { rm.closest("tr").remove(); return; }
      if (e.target.closest("[data-copyprev]")) {
        const prev = Store.all("dailylog", p.id).filter(l => l.data.date < date && (l.data.manpower || []).length).sort((a, b) => b.data.date.localeCompare(a.data.date))[0];
        if (!prev) { toast("No earlier log with manpower to copy", true); return; }
        const sec = LOG_SECTIONS[0];
        $(`[data-sec="manpower"] tbody`, form).innerHTML = prev.data.manpower.map(m => subRowHTML(sec, m)).join("");
        toast("Copied manpower from " + fmtDate(prev.data.date) + " — review and save");
      }
    });
    if (locked || !can(p.id, "dailylog", "standard")) $$("input, select, textarea, [data-addrow], [data-rmrow], [data-copyprev]", form).forEach(el => { el.disabled = true; });
    const save = $("#saveLog");
    if (locked) save.disabled = true;
    save.onclick = async () => {
      save.disabled = true;
      const data = { ...(rec ? rec.data : { createdAt: new Date().toISOString(), createdBy: meName() }), ...collectLog(), date, updatedBy: meName() };
      const next = withHistory({ id: logId(p, date), type: "dailylog", projectId: p.id, data }, rec ? "Log updated" : "Log created");
      if (await saveRec(next, "Daily log saved")) render(); else save.disabled = false;
    };
    const lock = $("#lockLog");
    if (lock) lock.onclick = async () => {
      const next = withHistory({ ...rec, data: { ...rec.data, locked: !locked, lockedBy: locked ? "" : meName(), lockedAt: locked ? "" : new Date().toISOString() } }, locked ? "Log unlocked" : "Log approved");
      if (await saveRec(next, locked ? "Unlocked" : "Approved")) render();
    };
  }

  ACTIONS.exportLogs = el => {
    const p = Store.get(el.dataset.project);
    const rows = [["Date", "Conditions", "High", "Low", "Precip", "Weather Delay", "Total Workers", "Man-hours", "Manpower Detail", "Work Performed", "Deliveries", "Visitors/Inspections", "Safety", "Delays", "Notes", "Approved"]];
    Store.all("dailylog", p.id).sort((a, b) => a.data.date.localeCompare(b.data.date)).forEach(l => {
      const d = l.data, w = d.weather || {};
      const mp = d.manpower || [];
      rows.push([d.date, w.conditions, w.high, w.low, w.precip, w.delay ? "Yes" : "", mp.reduce((s, m) => s + (Number(m.workers) || 0), 0), mp.reduce((s, m) => s + (Number(m.workers) || 0) * (Number(m.hours) || 0), 0),
        mp.map(m => `${companyName(m.companyId) || "?"}: ${m.workers || 0}`).join("; "),
        (d.work || []).map(x => [x.area, x.description].filter(Boolean).join(" – ")).join("; "),
        (d.deliveries || []).map(x => [x.from, x.contents].filter(Boolean).join(" – ")).join("; "),
        (d.visitors || []).map(x => [x.name, x.type, x.result].filter(Boolean).join(" – ")).join("; "),
        (d.safety || []).map(x => [x.type, x.description].filter(Boolean).join(" – ")).join("; "),
        (d.delays || []).map(x => [x.type, x.hours && x.hours + "h", x.description].filter(Boolean).join(" – ")).join("; "),
        d.notes, d.locked ? "Yes" : ""]);
    });
    downloadCSV(`${slug(p.data.name)}-daily-logs.csv`, rows);
  };

  // ───────────────────────── Punch list ─────────────────────────
  const PUNCH_FIELDS = [
    { k: "title", label: "Title", req: true, full: true },
    { k: "description", label: "Description", type: "textarea" },
    { k: "location", label: "Location" },
    { k: "trade", label: "Trade", type: "select", options: TRADES },
    { k: "assigneeId", label: "Assignee (does the work)", type: "contact" },
    { k: "managerId", label: "Punch Item Manager (verifies)", type: "contact" },
    { k: "due", label: "Due Date", type: "date" },
    { k: "priority", label: "Priority", type: "select", options: PRIORITIES },
    { k: "costImpact", label: "Cost Impact ($)", type: "money" },
    { k: "reference", label: "Reference (drawing, spec, RFI #)" }
  ];

  function editPunch(p, x, opts = {}) {
    const isNew = !x;
    openModal({
      title: isNew ? "Create Punch Item" : `Edit Punch Item #${x.data.number}`,
      noRender: !!opts.onCreated,
      body: formHTML(PUNCH_FIELDS, x ? x.data : { managerId: me() || p.data.superId || "", priority: "Medium", due: addDays(today(), 7), ...(opts.defaults || {}) }, { project: p }),
      wide: true,
      onSave: async root => {
        const vals = readForm(root, PUNCH_FIELDS);
        if (isNew) {
          const rec = { id: uid("pch"), type: "punch", projectId: p.id, data: { ...vals, number: nextNumber("punch", p.id), status: "Open", comments: [], createdBy: meName(), createdAt: new Date().toISOString() } };
          withHistory(rec, "Created");
          if (!(await saveRec(rec, `Punch item #${rec.data.number} created`))) return false;
          if (opts.onCreated) opts.onCreated(rec); else location.hash = `#/p/${p.id}/punch/${rec.id}`;
        } else {
          return saveRec(withHistory({ ...x, data: { ...x.data, ...vals } }, "Details edited"), "Punch item saved");
        }
      }
    });
  }
  ACTIONS.newPunch = el => editPunch(Store.get(el.dataset.project), null);
  ACTIONS.editPunch = el => { const x = Store.get(el.dataset.id); editPunch(Store.get(x.projectId), x); };
  ACTIONS.punchStatus = async el => {
    const x = Store.get(el.dataset.id);
    const status = el.dataset.status;
    const note = $("#punchComment") ? $("#punchComment").value.trim() : "";
    const comments = note ? [...(x.data.comments || []), { by: meName(), at: new Date().toISOString(), text: note, status }] : (x.data.comments || []);
    const rec = withHistory({ ...x, data: { ...x.data, status, comments, ...(status === "Closed" ? { closedAt: new Date().toISOString() } : {}) } }, `Status changed to ${status}`);
    if (await saveRec(rec, status)) render();
  };
  ACTIONS.punchComment = async el => {
    const x = Store.get(el.dataset.id);
    const text = $("#punchComment").value.trim();
    if (!text) { toast("Write a comment first", true); return; }
    const rec = withHistory({ ...x, data: { ...x.data, comments: [...(x.data.comments || []), { by: meName(), at: new Date().toISOString(), text }] } }, "Comment added");
    if (await saveRec(rec, "Comment added")) render();
  };
  ACTIONS.exportPunch = el => {
    const p = Store.get(el.dataset.project);
    const rows = [["#", "Title", "Status", "Priority", "Location", "Trade", "Assignee", "Manager", "Due", "Created", "Closed", "Description"]];
    Store.all("punch", p.id).sort((a, b) => a.data.number - b.data.number).forEach(x => {
      const d = x.data;
      rows.push([d.number, d.title, d.status, d.priority, d.location, d.trade, contactLabel(d.assigneeId), contactName(d.managerId), d.due, (d.createdAt || "").slice(0, 10), (d.closedAt || "").slice(0, 10), d.description]);
    });
    downloadCSV(`${slug(p.data.name)}-punch-list.csv`, rows);
  };

  function punchList(p) {
    const key = "punch_" + p.id;
    LIST_RENDERERS[key] = () => {
      const rows = Store.all("punch", p.id)
        .filter(x => matchFilter(key, x, ["#" + x.data.number, x.data.title, x.data.location, x.data.trade, x.data.description, contactLabel(x.data.assigneeId)].join(" "), x.data.status !== "Closed", punchBIC(x)))
        .sort((a, b) => b.data.number - a.data.number);
      if (!rows.length) return `<tr><td colspan="8" class="empty">No punch items found.</td></tr>`;
      return rows.map(x => {
        const d = x.data;
        return `<tr class="click" data-href="#/p/${p.id}/punch/${x.id}">
          <td class="nowrap"><a href="#/p/${p.id}/punch/${x.id}">#${d.number}</a></td><td>${esc(d.title)}</td><td>${pill(d.status)}</td><td>${pill(d.priority)}</td>
          <td>${esc(d.location)}</td><td>${esc(d.trade)}</td><td>${esc(bicNames(punchBIC(x)))}</td>
          <td class="nowrap ${isOverdue(d.due, d.status !== "Closed") ? "overdue" : ""}">${fmtDate(d.due)}</td></tr>`;
      }).join("");
    };
    const all = Store.all("punch", p.id);
    const c = s => all.filter(x => x.data.status === s).length;
    return `
      <div class="page-head"><h1>Punch List</h1>
        <div class="actions"><button class="btn" data-act="exportPunch" data-project="${p.id}">Export CSV</button><button class="btn primary" data-perm="punch:standard" data-act="newPunch" data-project="${p.id}">+ Create Item</button></div></div>
      <div class="cards">${PUNCH_STATUSES.map(s => `<div class="card"><div class="num">${c(s)}</div><div class="lbl">${s}</div></div>`).join("")}</div>
      <div class="panel flush">${toolbarHTML(key, PUNCH_STATUSES)}
        <div class="table-wrap"><table class="list"><thead><tr><th>#</th><th>Title</th><th>Status</th><th>Priority</th><th>Location</th><th>Trade</th><th>Ball In Court</th><th>Due</th></tr></thead>
        <tbody id="listBody">${LIST_RENDERERS[key]()}</tbody></table></div></div>`;
  }

  async function punchDetail(p, id) {
    const x = Store.get(id);
    if (!x || x.type !== "punch") return `<div class="empty">Punch item not found. <a href="#/p/${p.id}/punch">Back to punch list</a></div>`;
    await Store.load("photo", x.id);
    const photos = Store.all("photo", x.id).sort((a, b) => (a.data.at || "").localeCompare(b.data.at || ""));
    const d = x.data;
    const st = d.status;
    const info = [
      ["Status", pill(st)], ["Priority", pill(d.priority) || "—"], ["Ball In Court", esc(bicNames(punchBIC(x))) || "—"],
      ["Assignee", esc(contactLabel(d.assigneeId)) || "—"], ["Manager", esc(contactName(d.managerId)) || "—"], ["Due", `<span class="${isOverdue(d.due, st !== "Closed") ? "overdue" : ""}">${fmtDate(d.due) || "—"}</span>`],
      ["Location", esc(d.location) || "—"], ["Trade", esc(d.trade) || "—"], ["Reference", esc(d.reference) || "—"],
      ["Cost Impact", money(d.costImpact) || "—"], ["Created", `${fmtDate(d.createdAt)} by ${esc(d.createdBy || "")}`], ["Closed", fmtDate(d.closedAt) || "—"]
    ];
    const statusBtns = {
      "Open": [["Ready for Review", "Mark Ready for Review", "primary"]],
      "Work Not Accepted": [["Ready for Review", "Mark Ready for Review", "primary"]],
      "Ready for Review": [["Closed", "Accept & Close", "primary"], ["Work Not Accepted", "Reject Work", ""]],
      "Closed": [["Open", "Reopen", ""]]
    }[st] || [];
    return `
      <div class="crumb"><a href="#/p/${p.id}/punch">Punch List</a> / #${d.number}</div>
      <div class="page-head"><h1>#${d.number}: ${esc(d.title)}</h1>
        <div class="actions">
          ${statusBtns.map(([s, label, cls]) => `<button class="btn ${cls}" data-perm="punch:standard" data-act="punchStatus" data-id="${x.id}" data-status="${s}">${label}</button>`).join("")}
          <button class="btn" data-perm="punch:standard" data-act="editPunch" data-id="${x.id}">Edit</button>
          <button class="btn danger" data-perm="punch:admin" data-act="deleteRecord" data-id="${x.id}" data-children="1" data-label="punch item" data-back="#/p/${p.id}/punch">Delete</button>
        </div></div>
      <div class="panel"><div class="info-grid">${info.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
        ${d.description ? `<h3 style="margin-top:16px">Description</h3><div class="prose">${esc(d.description)}</div>` : ""}</div>
      <div class="panel"><div class="section-head"><h2 style="margin:0">Photos (${photos.length})</h2>
        <label class="btn small no-print" data-perm="punch:standard">+ Add Photos<input type="file" accept="image/*" multiple hidden id="photoInput" data-id="${x.id}"></label></div>
        ${photos.length ? `<div class="photos">${photos.map(ph => `<div class="photo"><img src="${esc(ph.data.src)}" alt="${esc(ph.data.caption || "Punch photo")}" data-full="${ph.id}">
          <div class="cap"><span>${esc(ph.data.by || "")} · ${fmtDate(ph.data.at)}</span><button class="btn small danger no-print" data-perm="punch:admin" data-act="deleteRecord" data-id="${ph.id}" data-label="photo">✕</button></div></div>`).join("")}</div>` : `<p class="muted">No photos yet.</p>`}
      </div>
      <div class="panel"><h2>Comments</h2>
        ${(d.comments || []).map(c => `<div class="thread"><div class="meta"><strong>${esc(c.by)}</strong> · ${fmtDateTime(c.at)} ${c.status ? pill(c.status) : ""}</div><div class="prose">${esc(c.text)}</div></div>`).join("") || `<p class="muted">No comments yet.</p>`}
        <div class="no-print" style="margin-top:12px" data-perm="punch:standard">
          <textarea id="punchComment" placeholder="Add a comment (also attached to the next status change)…"></textarea>
          <button class="btn" style="margin-top:8px" data-act="punchComment" data-id="${x.id}">Add Comment</button></div>
      </div>
      ${drawingLinksPanel(p, x.id)}
      ${historyPanel(d)}`;
  }

  // Photo upload — compressed in-browser to keep each record small
  function compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image " + file.name)); };
      img.src = url;
    });
  }

  document.addEventListener("change", async e => {
    if (e.target.id !== "photoInput") return;
    const punchId = e.target.dataset.id;
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    toast(`Uploading ${files.length} photo${files.length > 1 ? "s" : ""}…`);
    let n = 0;
    for (const f of files) {
      try {
        // Airtable long-text fields cap at roughly 100k characters, so keep each photo well under that.
        let src = await compressImage(f, 1000, 0.6);
        if (src.length > 90000) src = await compressImage(f, 700, 0.5);
        if (src.length > 90000) src = await compressImage(f, 480, 0.45);
        await Store.save({ id: uid("ph"), type: "photo", projectId: punchId, data: { src, name: f.name, by: meName(), at: new Date().toISOString() } });
        n++;
      } catch (err) { toast("Photo failed: " + err.message, true); }
    }
    if (n) {
      const x = Store.get(punchId);
      await saveRec(withHistory({ ...x, data: { ...x.data } }, `${n} photo${n > 1 ? "s" : ""} added`));
      toast(`${n} photo${n > 1 ? "s" : ""} added`);
    }
    render();
  });

  document.addEventListener("click", e => {
    const img = e.target.closest("img[data-full]");
    if (!img) return;
    openModal({ title: "Photo", body: `<div class="lightbox"><img src="${esc(img.src)}" alt=""></div>`, hideSave: true, wide: true });
  });

  // ───────────────────────── User picker ─────────────────────────
  function pickUser() {
    const list = contacts();
    openModal({
      title: "Who are you?",
      body: `<p class="muted">This sets your name on records you create and powers "Ball in my court". There are no passwords yet.</p>
        ${list.length ? `<div class="field"><label for="meSel">Select yourself from the directory</label><select id="meSel"><option value=""></option>${list.map(c => `<option value="${c.id}" ${c.id === me() ? "selected" : ""}>${esc(contactLabel(c.id))}</option>`).join("")}</select></div>
        <p class="muted" style="text-align:center">— or —</p>` : ""}
        <div class="field"><label for="meNew">Add yourself to the directory</label><input id="meNew" placeholder="Your full name"></div>`,
      saveLabel: "Continue",
      onSave: async root => {
        const sel = $("#meSel", root);
        const name = $("#meNew", root).value.trim();
        if (name) {
          const rec = { id: uid("ct"), type: "contact", projectId: "", data: { name } };
          if (!(await saveRec(rec))) return false;
          lsSet("netpower_pm_user", rec.id);
        } else if (sel && sel.value) {
          lsSet("netpower_pm_user", sel.value);
        } else {
          throw new Error("Pick a name or type yours");
        }
        toast("Hi, " + meName());
      }
    });
  }

  // ───────────────────────── Extension API (used by drawings.js) ─────────────────────────
  Object.assign(PM, {
    $, $$, esc, slug, uid, today, addDays, fmtDate, fmtDateTime, pill, toast, lsGet, lsSet,
    Store, saveRec, withHistory, me, meName, contactName, contactLabel, companyName, contacts, companies, projectContacts,
    render, bind, applyPerms, ACTIONS, api, level, can, isCompanyAdmin, nextNumber, historyPanel, rfiBIC, submittalBIC,
    deriveSubStatus, isOverdue, bicNames, money, TRADES, SUB_TYPES, SUB_STATUSES, SUB_RESPONSES,
    current: () => current,
    openModal, closeModal, formHTML, readForm, editRFI, editPunch, editSubmittal, pickUser: () => pickUser()
  });

  // ───────────────────────── Boot ─────────────────────────
  $("#userBtn").onclick = e => (PM.session && PM.auth ? PM.auth.userMenu(e) : pickUser());
  $("#menuBtn").onclick = () => document.body.classList.toggle("menu-open");
  $("#projectPicker").onchange = e => { if (e.target.value) location.hash = "#/p/" + e.target.value; };
  window.addEventListener("hashchange", render);

  const boot = () => Store.init().then(async need => {
    if (need) { PM.auth.showLogin(need); return; }
    await render();
    if (Store.mode === "local" && !me()) pickUser();
  }).catch(e => {
    $("#main").innerHTML = `<div class="panel"><h2>Could not connect to the database</h2><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
  });
  // Wait for DOMContentLoaded so extension scripts (drawings.js) can register first
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

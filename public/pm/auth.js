/* NetPower PM — sign-in, users and permissions screens.
 * Company admins manage users, permission templates and each project's permissions.
 * The server (api/pm.js + lib/auth.js) enforces every rule; these screens only manage them. */
(function () {
  "use strict";
  const PM = window.NetPowerPM;
  const { $, $$, esc, uid, toast, Store } = PM;

  const LEVELS = ["none", "read", "standard", "admin"];
  const LEVEL_LABEL = { none: "None", read: "Read Only", standard: "Standard", admin: "Admin" };
  const tools = () => (PM.session && PM.session.tools) || [];

  async function post(action, body) {
    const r = await fetch("/api/pm?action=" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.error || "Request failed");
    return d;
  }

  // ───────────────────────── Sign in / first admin ─────────────────────────
  function showLogin(code) {
    const setup = code === "SETUP_REQUIRED";
    document.body.classList.add("auth-mode");
    PM.closeModal();
    $("#main").innerHTML = `
      <div class="auth-card panel">
        <div class="auth-brand">Net<span>Power</span> PM</div>
        <h1>${setup ? "Create the admin account" : "Sign in"}</h1>
        <p class="muted">${setup ? "No one has signed up yet. This first account becomes the company admin — it can add your team and set their permissions." : "Use the email and password your company admin gave you."}</p>
        <form id="authForm" novalidate>
          ${setup ? `<div class="field"><label for="auName">Full name</label><input id="auName" autocomplete="name" required></div>` : ""}
          <div class="field"><label for="auEmail">Email</label><input id="auEmail" type="email" autocomplete="username" required></div>
          <div class="field"><label for="auPass">Password${setup ? " (at least 8 characters)" : ""}</label><input id="auPass" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required></div>
          ${setup ? `<div class="field"><label for="auPass2">Confirm password</label><input id="auPass2" type="password" autocomplete="new-password" required></div>` : ""}
          <div id="authErr" class="auth-err" role="alert" hidden></div>
          <button class="btn primary auth-submit" type="submit">${setup ? "Create account" : "Sign in"}</button>
        </form>
        ${setup ? "" : `<p class="muted" style="font-size:13px;margin-top:14px">Forgot your password? Ask a company admin to reset it.</p>`}
      </div>`;
    const first = $("#authForm input");
    if (first) first.focus();
    $("#authForm").onsubmit = async e => {
      e.preventDefault();
      const err = $("#authErr");
      const btn = $(".auth-submit");
      err.hidden = true;
      const email = $("#auEmail").value.trim(), password = $("#auPass").value;
      try {
        if (setup && password !== $("#auPass2").value) throw new Error("Passwords don't match");
        btn.disabled = true;
        await post(setup ? "setup" : "login", setup ? { name: $("#auName").value.trim(), email, password } : { email, password });
        location.hash = "#/";
        location.reload();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    };
  }

  // ───────────────────────── User menu ─────────────────────────
  // Claude connector: a private link that lets Claude create RFIs etc. as this user
  function connectClaude() {
    const u = PM.session.user;
    const draw = (root, key) => {
      const url = key ? `${location.origin}/api/mcp?key=${encodeURIComponent(key)}` : "";
      $("#ccBody", root).innerHTML = `
        <p style="margin-top:0">Connect Claude to NetPower PM so you can say things like <em>“Create an RFI on Riverside: conduit conflicts with the duct at grid C4, assign it to Alex Architect”</em> — without opening the app. Claude acts as <strong>${esc(u.name)}</strong> and can only do what you're allowed to do here.</p>
        ${url ? `<div class="field"><label for="ccUrl">Your private connector link</label><div class="with-mic"><input id="ccUrl" readonly value="${esc(url)}"><button type="button" class="btn small" id="ccCopy">Copy</button></div>
            <div class="field-err" style="display:block">Treat this link like a password — anyone who has it can act as you. It's shown only once.</div></div>
          <ol class="cc-steps">
            <li>Open <a href="https://claude.ai/customize/connectors" target="_blank" rel="noopener">claude.ai → Customize → Connectors</a>.</li>
            <li>Click <strong>Add custom connector</strong>. Name it <strong>NetPower PM</strong>.</li>
            <li>Paste the link above as the server URL. If it asks about sign-in, choose <strong>No sign-in</strong>.</li>
            <li>Click <strong>Add</strong>. In a chat, turn on NetPower PM from the <strong>+</strong> menu → Connectors.</li></ol>`
          : `<p>${u.hasConnector ? `✓ You have a connector link (created ${PM.fmtDate(u.connectorAt)}). If you lost it, create a new one — the old one stops working.` : "You haven't connected Claude yet."}</p>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button type="button" class="btn primary" id="ccNew">${u.hasConnector || url ? "Create a new link" : "Create my connector link"}</button>
          ${u.hasConnector || url ? `<button type="button" class="btn danger" id="ccRevoke">Disconnect (revoke link)</button>` : ""}</div>`;
      const copy = $("#ccCopy", root);
      if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch (e) { $("#ccUrl", root).select(); } };
      $("#ccNew", root).onclick = async () => {
        if (u.hasConnector && !window.confirm("Create a new link? The old link stops working right away.")) return;
        try { const d = await post("connectorKey", {}); u.hasConnector = true; u.connectorAt = new Date().toISOString(); draw(root, d.key); } catch (e) { toast(e.message, true); }
      };
      const rv = $("#ccRevoke", root);
      if (rv) rv.onclick = async () => {
        if (!window.confirm("Disconnect Claude? Your connector link stops working right away.")) return;
        try { await post("connectorKey", { revoke: true }); u.hasConnector = false; draw(root, null); toast("Claude disconnected"); } catch (e) { toast(e.message, true); }
      };
    };
    PM.openModal({ title: "Connect Claude", noRender: true, hideSave: true, body: `<div id="ccBody"></div>`, onOpen: root => draw(root, null) });
  }

  function userMenu(e) {
    e.stopPropagation();
    let m = $("#userMenu");
    if (m) { m.remove(); return; }
    const u = PM.session.user;
    m = document.createElement("div");
    m.id = "userMenu";
    m.className = "user-menu";
    m.setAttribute("role", "menu");
    m.innerHTML = `
      <div class="um-head"><strong>${esc(u.name)}</strong><div class="muted">${esc(u.email)}</div>${PM.session.isAdmin ? `<span class="pill admin-pill">Company admin</span>` : ""}</div>
      ${PM.session.isAdmin ? `<a href="#/admin/users" role="menuitem">Users</a><a href="#/admin/templates" role="menuitem">Permission Templates</a>` : ""}
      <a href="#" data-um="profile" role="menuitem">My profile (photo, trade, phone)</a>
      <a href="#" data-um="claude" role="menuitem">Connect Claude</a>
      <a href="#" data-um="password" role="menuitem">Change password</a>
      <a href="#" data-um="logout" role="menuitem">Sign out</a>`;
    document.body.appendChild(m);
    const close = ev => { if (!ev.target.closest("#userMenu")) { m.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
    m.onclick = async ev => {
      const a = ev.target.closest("[data-um]");
      m.remove();
      if (!a) return;
      ev.preventDefault();
      if (a.dataset.um === "logout") { await post("logout").catch(() => {}); location.hash = "#/"; location.reload(); }
      if (a.dataset.um === "password") changePassword();
      if (a.dataset.um === "profile" && PM.people) PM.people.myProfile();
      if (a.dataset.um === "claude") connectClaude();
    };
  }

  function changePassword() {
    PM.openModal({
      title: "Change Password",
      noRender: true,
      body: `<div class="field"><label for="cpCur">Current password</label><input id="cpCur" type="password" autocomplete="current-password"></div>
        <div class="field" style="margin-top:10px"><label for="cpNew">New password (at least 8 characters)</label><input id="cpNew" type="password" autocomplete="new-password"></div>
        <div class="field" style="margin-top:10px"><label for="cpNew2">Confirm new password</label><input id="cpNew2" type="password" autocomplete="new-password"></div>
        <p class="muted" style="font-size:12px">You'll stay signed in here; other devices will be signed out.</p>`,
      onSave: async root => {
        if ($("#cpNew", root).value !== $("#cpNew2", root).value) throw new Error("New passwords don't match");
        await post("password", { current: $("#cpCur", root).value, password: $("#cpNew", root).value });
        toast("Password changed");
        return true;
      }
    });
  }

  // ───────────────────────── Permission matrix ─────────────────────────
  function matrixHTML(perms, name, disabled) {
    return `<div class="table-wrap"><table class="list perm-matrix"><thead><tr><th>Name</th>${LEVELS.map(l => `<th>${LEVEL_LABEL[l]}</th>`).join("")}</tr></thead><tbody>
      <tr><td>Home</td>${LEVELS.map(l => `<td><input type="radio" disabled ${l === "read" ? "checked" : ""} aria-label="Home: ${LEVEL_LABEL[l]}"></td>`).join("")}</tr>
      ${tools().map(([id, label]) => `<tr><td>${esc(label)}</td>${LEVELS.map(l => `<td><input type="radio" name="${name}_${id}" value="${l}" ${(perms[id] || "none") === l ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="${esc(label)}: ${LEVEL_LABEL[l]}"></td>`).join("")}</tr>`).join("")}
    </tbody></table></div>`;
  }
  // Clicking a circle that's already filled clears it (back to "None"), so a mistake can be undone
  let wasChecked = null;
  document.addEventListener("pointerdown", e => { const r = e.target.closest && e.target.closest(".perm-matrix input[type=radio]"); wasChecked = r && r.checked ? r : null; }, true);
  document.addEventListener("click", e => {
    const r = e.target.closest && e.target.closest(".perm-matrix input[type=radio]");
    if (!r || r.disabled || r !== wasChecked) return;
    wasChecked = null;
    const none = r.value === "none" ? null : $(`input[name="${r.name}"][value="none"]`, r.closest("table"));
    r.checked = false;
    if (none) { none.checked = true; none.dispatchEvent(new Event("change", { bubbles: true })); }
    else r.dispatchEvent(new Event("change", { bubbles: true }));
  });
  function readMatrix(root, name) {
    return Object.fromEntries(tools().map(([id]) => {
      const el = $(`input[name="${name}_${id}"]:checked`, root);
      return [id, el ? el.value : "none"];
    }));
  }

  // ───────────────────────── Users (company admins) ─────────────────────────
  let usersCache = null;
  async function loadUsers(force) {
    if (!usersCache || force) usersCache = (await PM.api("/api/pm?action=users")).users;
    return usersCache;
  }

  async function usersPage() {
    const users = await loadUsers(true);
    setTimeout(() => {
      $$("[data-edit-user]").forEach(b => b.onclick = () => editUser(users.find(u => u.id === b.dataset.editUser)));
      const add = $("#addUser");
      if (add) add.onclick = () => editUser(null);
    }, 0);
    const active = users.filter(u => u.active).length;
    return `
      <div class="page-head"><h1>Users</h1><span class="sub">${active} active · ${users.length - active} inactive</span>
        <div class="actions"><button class="btn primary" id="addUser">+ Add User</button></div></div>
      <p class="muted">People need an account to sign in. After adding someone, open a project → <strong>Permissions</strong> to choose what they can see and do there. Company admins can see and do everything.</p>
      <div class="panel flush"><div class="table-wrap"><table class="list"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Company</th><th></th></tr></thead><tbody>
        ${users.sort((a, b) => a.name.localeCompare(b.name)).map(u => `<tr>
          <td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td>
          <td>${u.companyAdmin ? `<span class="pill admin-pill">Company admin</span>` : "Member"}</td>
          <td>${u.active ? PM.pill("Active") : PM.pill("Archived")}</td>
          <td>${esc(PM.companyName((Store.get(u.contactId) || { data: {} }).data.companyId))}</td>
          <td><button class="btn small" data-edit-user="${u.id}">Edit</button></td></tr>`).join("")}
      </tbody></table></div></div>`;
  }

  function editUser(u, preset = {}) {
    const isNew = !u;
    const contact = u ? Store.get(u.contactId) : null;
    const isSelf = u && PM.session && u.id === PM.session.user.id;
    PM.openModal({
      title: isNew ? "Add User" : "Edit User — " + u.name,
      body: `<div class="form-grid">
        <div class="field"><label for="usName">Full name <span class="req">*</span></label><input id="usName" value="${esc(u ? u.name : "")}"></div>
        <div class="field"><label for="usEmail">Email <span class="req">*</span></label><input id="usEmail" type="email" value="${esc(u ? u.email : "")}"></div>
        ${isNew ? `<div class="field"><label for="usCompany">Company</label><select id="usCompany"><option value=""></option>${PM.companies().map(c => `<option value="${c.id}">${esc(c.data.name)}</option>`).join("")}</select></div>
          <div class="field"><label for="usContact">Link to existing person (optional)</label><select id="usContact"><option value="">— create a new directory entry —</option>${PM.contacts().map(c => `<option value="${c.id}" ${preset.contactId === c.id ? "selected" : ""}>${esc(PM.contactLabel(c.id))}</option>`).join("")}</select></div>` : ""}
        <div class="field"><label for="usPass">${isNew ? "Temporary password" : "Reset password (leave blank to keep)"} ${isNew ? '<span class="req">*</span>' : ""}</label><input id="usPass" type="text" autocomplete="off" placeholder="at least 8 characters"></div>
        <div class="field" style="align-self:end"><label class="inline-check"><input type="checkbox" id="usAdmin" ${u && u.companyAdmin ? "checked" : ""} ${isSelf ? "disabled" : ""}> Company admin (full access to everything)</label></div>
        ${isNew ? "" : `<div class="field"><label class="inline-check"><input type="checkbox" id="usActive" ${u.active ? "checked" : ""} ${isSelf ? "disabled" : ""}> Active (can sign in)</label></div>`}
        </div>
        ${PM.people ? PM.people.profileFieldsHTML(u) : ""}
        <p class="muted" style="font-size:12px">Share the password with them privately. Emails aren't sent automatically yet. ${contact ? "" : ""}</p>`,
      onOpen: root => {
        if (PM.people) PM.people.wireProfileFields(root);
        const pick = $("#usContact", root);
        if (pick) pick.onchange = () => {
          const c = Store.get(pick.value);
          if (c) { $("#usName", root).value = c.data.name; if (c.data.email) $("#usEmail", root).value = c.data.email; }
        };
        if (pick && preset.contactId) { pick.onchange(); const c = Store.get(preset.contactId); if (c && c.data.companyId) $("#usCompany", root).value = c.data.companyId; }
      },
      onSave: async root => {
        const body = {
          ...(u ? { id: u.id } : {}),
          name: $("#usName", root).value.trim(),
          email: $("#usEmail", root).value.trim(),
          ...(PM.people ? PM.people.readProfile(root) : {})
        };
        const pw = $("#usPass", root).value;
        if (pw) body.password = pw;
        if (!isSelf) body.companyAdmin = $("#usAdmin", root).checked;
        if (isNew) {
          body.companyId = $("#usCompany", root).value;
          body.contactId = $("#usContact", root).value;
        } else if (!isSelf) body.active = $("#usActive", root).checked;
        await post("saveUser", body);
        if (PM.people) PM.people.invalidate();
        Store.loaded.delete("contact|");
        toast(isNew ? "User added" : "User saved");
        return true;
      }
    });
  }

  // ───────────────────────── Permission templates ─────────────────────────
  async function templatesPage(selected) {
    await Store.load("permtemplate");
    const tpls = Store.all("permtemplate").sort((a, b) => a.data.name.localeCompare(b.data.name));
    const t = Store.get(selected) || tpls[0];
    setTimeout(() => {
      const save = $("#tplSave");
      if (save) save.onclick = () => saveTemplate(t);
      const del = $("#tplDelete");
      if (del) del.onclick = () => deleteTemplate(t);
      $("#tplNew").onclick = () => newTemplate();
    }, 0);
    return `
      <div class="page-head"><h1>Permission Templates</h1>
        <div class="actions"><button class="btn" id="tplNew">+ New Template</button></div></div>
      <p class="muted">A template is a reusable set of permissions (e.g. Foreman). Assign templates to people per project on the project's <strong>Permissions</strong> page. Changing a template updates everyone who uses it.</p>
      <div class="tpl-layout">
        <div class="panel tpl-list">${tpls.map(x => `<a href="#/admin/templates/${x.id}" class="${t && x.id === t.id ? "on" : ""}">${esc(x.data.name)}</a>`).join("") || `<p class="muted">No templates yet.</p>`}</div>
        ${t ? `<div class="panel">
          <div class="field" style="max-width:360px"><label for="tplName">Template name</label><input id="tplName" value="${esc(t.data.name)}"></div>
          <h3 style="margin-top:16px">PROJECT PERMISSIONS</h3>
          ${matrixHTML(t.data.perms || {}, "tpl")}
          <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="tplSave">Save Template</button><button class="btn danger" id="tplDelete">Delete Template</button></div>
        </div>` : ""}
      </div>`;
  }

  async function saveTemplate(t) {
    const name = $("#tplName").value.trim();
    if (!name) { toast("Template name is required", true); return; }
    const rec = { ...t, data: { ...t.data, name, perms: readMatrix(document, "tpl") } };
    if (await PM.saveRec(rec, "Template saved")) PM.render();
  }
  async function deleteTemplate(t) {
    if (!window.confirm(`Delete the "${t.data.name}" template? People using it on a project will lose access until you choose another template for them.`)) return;
    try { await Store.remove(t.id); toast("Template deleted"); location.hash = "#/admin/templates"; } catch (e) { toast("Delete failed: " + e.message, true); }
  }
  function newTemplate() {
    PM.openModal({
      title: "New Permission Template",
      noRender: true,
      body: `<div class="field"><label for="ntName">Name</label><input id="ntName" placeholder="e.g. Apprentice"></div>`,
      onSave: async root => {
        const name = $("#ntName", root).value.trim();
        if (!name) throw new Error("Name is required");
        const rec = { id: uid("tpl"), type: "permtemplate", projectId: "", data: { name, perms: Object.fromEntries(tools().map(([id]) => [id, "none"])) } };
        if (!(await PM.saveRec(rec, "Template created"))) return false;
        location.hash = "#/admin/templates/" + rec.id;
        return true;
      }
    });
  }

  // ───────────────────────── Project permissions ─────────────────────────
  async function projectPermissions(p) {
    await Promise.all([Store.load("member", p.id), Store.load("permtemplate")]);
    const users = await loadUsers(true);  // fresh, so people just added under Users can be added here
    const tpls = Store.all("permtemplate").sort((a, b) => a.data.name.localeCompare(b.data.name));
    const members = Store.all("member", p.id).map(m => ({ m, u: users.find(u => u.id === m.data.userId) })).filter(x => x.u)
      .sort((a, b) => a.u.name.localeCompare(b.u.name));
    const memberIds = new Set(members.map(x => x.u.id));
    const addable = users.filter(u => u.active && !u.companyAdmin && !memberIds.has(u.id));
    const admins = users.filter(u => u.active && u.companyAdmin);
    const effective = m => m.data.perms || (Store.get(m.data.templateId) || { data: { perms: {} } }).data.perms || {};

    setTimeout(() => wirePermissions(p, members, tpls), 0);
    return `
      <div class="page-head"><h1>Project Permissions</h1><span class="sub">${esc(p.data.name)}</span>
        <div class="actions"><button class="btn primary" id="addMember" ${addable.length ? "" : "disabled"}>+ Add User to Project</button></div></div>
      <p class="muted">Choose a <strong>permission template</strong> for each person, or customize their permissions. People not listed here can't open this project.
        Company admins (${admins.map(a => esc(a.name)).join(", ") || "none"}) always have full access.</p>
      <div class="panel flush"><div class="table-wrap"><table class="list"><thead><tr><th>Name</th><th>Email</th><th>Project Permissions Template</th><th>Access summary</th><th></th></tr></thead><tbody>
        ${members.length ? members.map(({ m, u }) => {
          const eff = effective(m);
          const summary = tools().filter(([id]) => eff[id] && eff[id] !== "none").map(([id, label]) => `${label}: ${LEVEL_LABEL[eff[id]]}`).join(" · ") || "No access to any tool";
          return `<tr data-member="${m.id}">
            <td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td>
            <td><select data-tpl="${m.id}" aria-label="Permission template for ${esc(u.name)}">
              ${m.data.perms ? `<option value="__custom" selected>Custom permissions</option>` : ""}
              ${tpls.map(t => `<option value="${t.id}" ${!m.data.perms && m.data.templateId === t.id ? "selected" : ""}>${esc(t.data.name)}</option>`).join("")}
              ${!m.data.perms && !Store.get(m.data.templateId) ? `<option value="" selected>— choose —</option>` : ""}
            </select></td>
            <td class="muted" style="font-size:12px;max-width:420px">${esc(summary)}</td>
            <td class="nowrap"><button class="btn small" data-custom="${m.id}">Customize</button> <button class="btn small danger" data-remove="${m.id}">Remove</button></td></tr>`;
        }).join("") : `<tr><td colspan="5" class="empty">No one has been added to this project yet.</td></tr>`}
      </tbody></table></div></div>`;
  }

  function wirePermissions(p, members, tpls) {
    const add = $("#addMember");
    if (add) add.onclick = () => addMember(p, tpls);
    $$("[data-tpl]").forEach(sel => sel.onchange = async () => {
      if (sel.value === "__custom" || !sel.value) return;
      const m = Store.get(sel.dataset.tpl);
      await PM.saveRec({ ...m, data: { ...m.data, templateId: sel.value, perms: null } }, "Permissions updated");
      PM.render();
    });
    $$("[data-custom]").forEach(b => b.onclick = () => customize(Store.get(b.dataset.custom), members));
    $$("[data-remove]").forEach(b => b.onclick = async () => {
      const x = members.find(x => x.m.id === b.dataset.remove);
      if (!window.confirm(`Remove ${x.u.name} from this project? They won't be able to open it anymore.`)) return;
      try { await Store.remove(x.m.id); toast("Removed"); PM.render(); } catch (e) { toast("Remove failed: " + e.message, true); }
    });
  }

  function customize(m, members) {
    const x = members.find(x => x.m.id === m.id);
    const base = m.data.perms || (Store.get(m.data.templateId) || { data: { perms: {} } }).data.perms || {};
    PM.openModal({
      title: "Permissions — " + x.u.name,
      wide: true,
      body: `<p class="muted">Starting from ${m.data.perms ? "their custom permissions" : `the <strong>${esc((Store.get(m.data.templateId) || { data: { name: "?" } }).data.name)}</strong> template`}. Saving makes these custom for this person on this project.</p>
        ${matrixHTML(base, "mem")}`,
      saveLabel: "Save Custom Permissions",
      onSave: async root => PM.saveRec({ ...m, data: { ...m.data, perms: readMatrix(root, "mem") } }, "Permissions saved")
    });
  }

  function addMember(p, tpls) {
    loadUsers().then(users => {
      const memberIds = new Set(Store.all("member", p.id).map(m => m.data.userId));
      const addable = users.filter(u => u.active && !u.companyAdmin && !memberIds.has(u.id));
      PM.openModal({
        title: "Add User to Project",
        body: `<div class="form-grid">
          <div class="field full"><label>People</label><div class="checks" style="max-height:260px">${addable.map(u => `<label><input type="checkbox" value="${u.id}"> ${esc(u.name)} <span class="muted">${esc(u.email)}</span></label>`).join("")}</div></div>
          <div class="field"><label for="amTpl">Permission template</label><select id="amTpl">${tpls.map(t => `<option value="${t.id}">${esc(t.data.name)}</option>`).join("")}</select></div>
          <div class="field"><label for="amRole">Role on project (shown in Project Directory)</label><input id="amRole" placeholder="e.g. Foreman"></div></div>
          <p class="muted" style="font-size:12px">Don't see someone? Add them first under <a href="#/admin/users">Users</a>.</p>`,
        onSave: async root => {
          const ids = $$(".checks input:checked", root).map(i => i.value);
          if (!ids.length) throw new Error("Select at least one person");
          const templateId = $("#amTpl", root).value;
          const role = $("#amRole", root).value.trim() || (Store.get(templateId) || { data: { name: "" } }).data.name;
          await Store.saveMany(ids.map(userId => ({ id: uid("mem"), type: "member", projectId: p.id, data: { userId, templateId, perms: null, addedAt: new Date().toISOString() } })));
          // Also list them in the Project Directory so they can be assigned to items
          const team = [...(p.data.team || [])];
          ids.forEach(userId => {
            const u = users.find(x => x.id === userId);
            if (u && u.contactId && !team.some(t => t.contactId === u.contactId)) team.push({ contactId: u.contactId, role });
          });
          if (team.length !== (p.data.team || []).length) await PM.saveRec(PM.withHistory({ ...p, data: { ...p.data, team } }, `Added ${ids.length} user(s) to project`));
          toast(`${ids.length} user(s) added`);
          return true;
        }
      });
    });
  }

  // ───────────────────────── Routing ─────────────────────────
  function adminPage(page, sub) {
    if (page === "templates") return templatesPage(sub);
    if (page === "company") return PM.exporter.letterheadPage();
    return usersPage();
  }

  PM.auth = { showLogin, userMenu, adminPage, projectPermissions, editUser };
})();

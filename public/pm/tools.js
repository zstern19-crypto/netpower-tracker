// NetPower PM — tool tracker: company tool inventory, who/where has each tool, check-out / check-in history.
// Records: type "tool", ProjectID "" (company-wide), Data = { tag, name, category, make, model, serial, photo, value,
//   purchased, condition, conditionNote, notes, checkout: { userId, name, projectId, out, due, by } | null, history: [...] }
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, uid, toast, Store } = PM;

  const CATEGORIES = ["Power Tools", "Hand Tools", "Meters & Testers", "Benders", "Pullers & Tuggers", "Ladders & Lifts", "Threaders & Cutters", "Fish Tapes", "Safety Gear", "Generators & Lights", "Rental", "Other"];
  const CONDITIONS = ["Good", "Needs repair", "Out of service", "Lost"];
  const today = () => PM.today();
  const filter = () => PM.lsGet("netpower_pm_toolfilter", { q: "", cat: "", status: "", holder: "" }) || {};
  const statusOf = t => (["Lost", "Out of service"].includes(t.data.condition) ? t.data.condition.toLowerCase() : t.data.checkout ? (t.data.checkout.due && t.data.checkout.due < today() ? "overdue" : "out") : "available");
  const STATUS_LABEL = { available: "Available", out: "Checked out", overdue: "Overdue", lost: "Lost", "out of service": "Out of service" };
  const projectName = id => { const p = Store.get(id); return p ? p.data.name : ""; };
  const holderText = t => t.data.checkout ? `${t.data.checkout.name || "Someone"}${t.data.checkout.projectId ? " @ " + projectName(t.data.checkout.projectId) : ""}` : "";

  async function page(query) {
    await Promise.all([Store.load("tool"), Store.load("project")]);
    const people = PM.people ? await PM.people.loadPeople() : [];
    const admin = PM.isCompanyAdmin();
    const f = filter();
    const all = Store.all("tool").sort((a, b) => String(a.data.tag || "").localeCompare(String(b.data.tag || ""), undefined, { numeric: true }) || (a.data.name || "").localeCompare(b.data.name || ""));
    const rows = all.filter(t => (!f.cat || t.data.category === f.cat) && (!f.status || statusOf(t) === f.status || (f.status === "out" && statusOf(t) === "overdue")) &&
      (!f.holder || (t.data.checkout && t.data.checkout.userId === f.holder)) &&
      (!f.q || [t.data.tag, t.data.name, t.data.make, t.data.model, t.data.serial, t.data.category, holderText(t)].join(" ").toLowerCase().includes(f.q.toLowerCase())));
    const count = k => all.filter(t => statusOf(t) === k).length;
    const cats = [...new Set([...CATEGORIES, ...all.map(t => t.data.category).filter(Boolean)])];
    const holders = people.filter(u => all.some(t => t.data.checkout && t.data.checkout.userId === u.id));
    setTimeout(() => {
      $$("[data-tf]").forEach(el => el.addEventListener(el.type === "search" ? "change" : "change", () => { f[el.dataset.tf] = el.value; PM.lsSet("netpower_pm_toolfilter", f); PM.render(); }));
      const add = $("#toolAdd"); if (add) add.onclick = () => editTool(null);
      const csv = $("#toolCsv"); if (csv) csv.onclick = () => exportCSV(all);
      $$("[data-tool-open]").forEach(el => el.onclick = e => { if (!e.target.closest("button")) toolModal(el.dataset.toolOpen, people); });
      $$("[data-tool-out]").forEach(b => b.onclick = () => checkOut(Store.get(b.dataset.toolOut), people));
      $$("[data-tool-in]").forEach(b => b.onclick = () => checkIn(Store.get(b.dataset.toolIn)));
      if (query && query.get("open")) toolModal(query.get("open"), people);
    }, 0);
    return `
      <div class="page-head"><h1>Tools</h1><div class="actions"><button class="btn" id="toolCsv">Export CSV</button>${admin ? `<button class="btn primary" id="toolAdd">+ Add Tool</button>` : ""}</div></div>
      <div class="cards">
        <div class="card"><div class="num">${all.length}</div><div class="lbl">Tools</div></div>
        <div class="card"><div class="num">${count("available")}</div><div class="lbl">Available</div></div>
        <div class="card"><div class="num">${count("out") + count("overdue")}</div><div class="lbl">Checked out${count("overdue") ? ` · <span class="overdue">${count("overdue")} overdue</span>` : ""}</div></div>
        <div class="card"><div class="num">${all.filter(t => t.data.condition && t.data.condition !== "Good").length}</div><div class="lbl">Needs repair / out of service / lost</div></div>
      </div>
      <div class="panel flush"><div class="toolbar">
        <input type="search" data-tf="q" placeholder="Search tag, name, serial, who has it…" value="${esc(f.q || "")}">
        <select data-tf="cat" aria-label="Category"><option value="">All categories</option>${cats.map(c => `<option ${f.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select data-tf="status" aria-label="Status"><option value="">Any status</option>${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select data-tf="holder" aria-label="Who has it"><option value="">Anyone</option>${holders.map(u => `<option value="${u.id}" ${f.holder === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
      </div>
      <div class="table-wrap"><table class="list tool-table"><thead><tr><th></th><th>Tag #</th><th>Tool</th><th>Category</th><th>Status</th><th>Who / where</th><th>Condition</th><th></th></tr></thead><tbody>
        ${rows.map(t => { const st = statusOf(t), co = t.data.checkout;
          return `<tr class="click" data-tool-open="${t.id}">
            <td style="width:56px">${t.data.photo ? `<img class="tool-thumb" src="${esc(t.data.photo)}" alt="">` : `<span class="tool-thumb none">🔧</span>`}</td>
            <td class="nowrap"><strong>${esc(t.data.tag || "")}</strong></td>
            <td>${esc(t.data.name)}<div class="muted" style="font-size:12px">${esc([[t.data.make, t.data.model].filter(Boolean).join(" "), t.data.serial ? "SN " + t.data.serial : ""].filter(Boolean).join(" · "))}</div></td>
            <td>${esc(t.data.category || "")}</td>
            <td><span class="pill tool-${st.replace(/ /g, "-")}">${STATUS_LABEL[st]}</span></td>
            <td>${co ? `${esc(co.name || "")}${co.projectId ? `<div class="muted" style="font-size:12px">${esc(projectName(co.projectId))}</div>` : ""}<div class="muted" style="font-size:12px">since ${PM.fmtDate(co.out)}${co.due ? ` · due ${PM.fmtDate(co.due)}` : ""}</div>` : `<span class="muted">In the shop</span>`}</td>
            <td>${esc(t.data.condition || "Good")}</td>
            <td class="nowrap">${co ? `<button class="btn small" data-tool-in="${t.id}">Check in</button>` : ["Lost", "Out of service"].includes(t.data.condition) ? "" : `<button class="btn small primary" data-tool-out="${t.id}">Check out</button>`}</td></tr>`; }).join("")
          || `<tr><td colspan="8" class="empty">${all.length ? "No tools match the filters." : admin ? "No tools yet. Click “+ Add Tool” to start your inventory." : "No tools yet. A company admin adds the inventory."}</td></tr>`}
      </tbody></table></div></div>`;
  }

  // Photo: square-cropped small JPEG kept in the record
  async function photoData(file) {
    if (PM.people && PM.people.photoToDataURL) return PM.people.photoToDataURL(file, 320);
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => { const s = Math.min(img.width, img.height), c = document.createElement("canvas"); c.width = c.height = 320; c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 320, 320); URL.revokeObjectURL(url); resolve(c.toDataURL("image/jpeg", 0.8)); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image")); };
      img.src = url;
    });
  }

  function nextTag() {
    const nums = Store.all("tool").map(t => parseInt(String(t.data.tag || "").replace(/\D/g, ""), 10)).filter(n => !isNaN(n));
    return "T-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0");
  }

  function editTool(t) {
    const d = t ? t.data : { tag: nextTag(), condition: "Good" };
    let photo = d.photo || "";
    PM.openModal({
      title: t ? `Edit ${d.name}` : "Add Tool",
      wide: true,
      body: `<div class="profile-row">
          <div class="profile-photo"><span id="tlPhotoBox">${photo ? `<img class="tool-thumb big" src="${esc(photo)}" alt="">` : `<span class="tool-thumb big none">🔧</span>`}</span>
            <label class="btn small">Photo<input type="file" accept="image/*" id="tlPhoto" hidden></label></div>
          <div class="form-grid" style="flex:1">
            <div class="field"><label for="tlTag">Tag #</label><input id="tlTag" value="${esc(d.tag || "")}"></div>
            <div class="field"><label for="tlName">Tool name <span class="req">*</span></label><input id="tlName" value="${esc(d.name || "")}" placeholder="e.g. Greenlee 555 bender"></div>
            <div class="field"><label for="tlCat">Category</label><input id="tlCat" list="tlCats" value="${esc(d.category || "")}"><datalist id="tlCats">${CATEGORIES.map(c => `<option value="${esc(c)}">`).join("")}</datalist></div>
            <div class="field"><label for="tlCond">Condition</label><select id="tlCond">${CONDITIONS.map(c => `<option ${(d.condition || "Good") === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
            <div class="field"><label for="tlMake">Make</label><input id="tlMake" value="${esc(d.make || "")}"></div>
            <div class="field"><label for="tlModel">Model</label><input id="tlModel" value="${esc(d.model || "")}"></div>
            <div class="field"><label for="tlSerial">Serial #</label><input id="tlSerial" value="${esc(d.serial || "")}"></div>
            <div class="field"><label for="tlValue">Value ($)</label><input id="tlValue" type="number" step="any" min="0" value="${esc(d.value ?? "")}"></div>
            <div class="field"><label for="tlBought">Purchased</label><input id="tlBought" type="date" value="${esc(d.purchased || "")}"></div>
            <div class="field full"><label for="tlNotes">Notes</label><input id="tlNotes" value="${esc(d.notes || "")}"></div>
          </div></div>
        ${t ? `<button type="button" class="btn danger small" id="tlDelete">Delete tool</button>` : ""}`,
      onOpen: root => {
        $("#tlPhoto", root).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { photo = await photoData(f); $("#tlPhotoBox", root).innerHTML = `<img class="tool-thumb big" src="${esc(photo)}" alt="">`; } catch (err) { toast(err.message, true); } };
        const del = $("#tlDelete", root);
        if (del) del.onclick = async () => { if (!window.confirm(`Delete ${d.name} and its history?`)) return; try { await Store.remove(t.id); PM.closeModal(); PM.render(); toast("Tool deleted"); } catch (e) { toast(e.message, true); } };
      },
      onSave: async root => {
        const v = id => $("#" + id, root).value.trim();
        if (!v("tlName")) { toast("Give the tool a name", true); return false; }
        const tag = v("tlTag");
        if (tag && Store.all("tool").some(x => x.id !== (t && t.id) && String(x.data.tag || "").toLowerCase() === tag.toLowerCase())) { toast("Tag # " + tag + " is already used", true); return false; }
        const vals = { tag, name: v("tlName"), category: v("tlCat"), condition: v("tlCond"), make: v("tlMake"), model: v("tlModel"), serial: v("tlSerial"),
          value: v("tlValue") === "" ? "" : Number(v("tlValue")), purchased: v("tlBought"), notes: v("tlNotes"), photo };
        const history = [...(d.history || [])];
        if (t && vals.condition !== (d.condition || "Good")) history.push({ action: "condition", text: `Condition: ${vals.condition}`, by: PM.meName(), at: new Date().toISOString() });
        if (!t) history.push({ action: "added", text: "Added to inventory", by: PM.meName(), at: new Date().toISOString() });
        return PM.saveRec({ id: t ? t.id : uid("tool"), type: "tool", projectId: "", data: { ...d, ...vals, history, checkout: d.checkout || null, updatedAt: new Date().toISOString() } }, t ? "Tool saved" : "Tool added");
      }
    });
  }

  function checkOut(t, people) {
    if (!t) return;
    const projects = Store.all("project").filter(p => !["Completed", "Archived"].includes(p.data.status)).sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));
    const me = PM.session ? PM.session.user.id : "";
    PM.openModal({
      title: `Check out ${t.data.name}${t.data.tag ? " (#" + t.data.tag + ")" : ""}`,
      saveLabel: "Check out",
      body: `<div class="form-grid">
        <div class="field full"><label for="coWho">Who's taking it <span class="req">*</span></label><select id="coWho"><option value="">Select a person</option>${people.map(u => `<option value="${u.id}" ${u.id === me ? "selected" : ""}>${esc(u.name)}${u.trade ? " — " + esc(u.trade) : ""}</option>`).join("")}</select></div>
        <div class="field full"><label for="coProj">Job / project</label><select id="coProj"><option value="">— Not on a job (e.g. shop, truck) —</option>${projects.map(p => `<option value="${p.id}">${esc(p.data.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="coDue">Due back (optional)</label><input type="date" id="coDue"></div>
        <div class="field"><label for="coNote">Note</label><input id="coNote" placeholder="e.g. with case and 2 batteries"></div></div>`,
      onSave: async root => {
        const userId = $("#coWho", root).value;
        if (!userId) { toast("Pick who's taking it", true); return false; }
        const u = people.find(x => x.id === userId) || { name: "" };
        const fresh = Store.get(t.id) || t;
        if (fresh.data.checkout) { toast(`Already checked out to ${fresh.data.checkout.name}`, true); return false; }
        const now = new Date().toISOString(), projectId = $("#coProj", root).value, note = $("#coNote", root).value.trim();
        const checkout = { userId, name: u.name, projectId, out: today(), due: $("#coDue", root).value, by: PM.meName(), at: now, note };
        const history = [...(fresh.data.history || []), { action: "out", userId, name: u.name, projectId, project: projectName(projectId), due: checkout.due, note, by: PM.meName(), at: now }];
        return PM.saveRec({ ...fresh, data: { ...fresh.data, checkout, history, updatedAt: now } }, `${t.data.name} checked out to ${u.name}`);
      }
    });
  }

  function checkIn(t) {
    if (!t) return;
    const co = t.data.checkout || {};
    PM.openModal({
      title: `Check in ${t.data.name}`,
      saveLabel: "Check in",
      body: `<p style="margin-top:0">Returned by <strong>${esc(co.name || "")}</strong>${co.projectId ? ` from ${esc(projectName(co.projectId))}` : ""} (out since ${PM.fmtDate(co.out)}).</p>
        <div class="form-grid"><div class="field"><label for="ciCond">Condition</label><select id="ciCond">${CONDITIONS.map(c => `<option ${(t.data.condition || "Good") === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><label for="ciNote">Note</label><input id="ciNote" placeholder="e.g. cord damaged"></div></div>`,
      onSave: async root => {
        const fresh = Store.get(t.id) || t, now = new Date().toISOString(), condition = $("#ciCond", root).value, note = $("#ciNote", root).value.trim();
        const history = [...(fresh.data.history || []), { action: "in", userId: co.userId, name: co.name, projectId: co.projectId, project: projectName(co.projectId), condition, note, by: PM.meName(), at: now }];
        return PM.saveRec({ ...fresh, data: { ...fresh.data, checkout: null, condition, conditionNote: note || fresh.data.conditionNote || "", history, updatedAt: now } }, `${t.data.name} checked in`);
      }
    });
  }

  function toolModal(id, people) {
    const t = Store.get(id);
    if (!t) return;
    const d = t.data, st = statusOf(t), admin = PM.isCompanyAdmin();
    const line = h => h.action === "out" ? `Checked out to <strong>${esc(h.name)}</strong>${h.project ? " for " + esc(h.project) : ""}${h.due ? ` · due ${PM.fmtDate(h.due)}` : ""}`
      : h.action === "in" ? `Returned by <strong>${esc(h.name || "")}</strong>${h.condition && h.condition !== "Good" ? ` · <span class="overdue">${esc(h.condition)}</span>` : ""}` : esc(h.text || h.action);
    PM.openModal({
      title: `${d.tag ? "#" + d.tag + " — " : ""}${d.name}`,
      wide: true,
      noRender: true,
      hideSave: true,
      body: `<div class="profile-row">
          <div>${d.photo ? `<img class="tool-thumb huge" src="${esc(d.photo)}" alt="">` : `<span class="tool-thumb huge none">🔧</span>`}</div>
          <div style="flex:1"><div class="info-grid">
            <div><div class="k">Status</div><div class="v"><span class="pill tool-${st.replace(/ /g, "-")}">${STATUS_LABEL[st]}</span></div></div>
            <div><div class="k">Who / where</div><div class="v">${esc(holderText(t)) || "In the shop"}</div></div>
            <div><div class="k">Category</div><div class="v">${esc(d.category || "—")}</div></div>
            <div><div class="k">Condition</div><div class="v">${esc(d.condition || "Good")}${d.conditionNote ? ` <span class="muted">(${esc(d.conditionNote)})</span>` : ""}</div></div>
            <div><div class="k">Make / model</div><div class="v">${esc([d.make, d.model].filter(Boolean).join(" ") || "—")}</div></div>
            <div><div class="k">Serial #</div><div class="v">${esc(d.serial || "—")}</div></div>
            <div><div class="k">Value</div><div class="v">${d.value !== "" && d.value != null ? PM.money(d.value) : "—"}</div></div>
            <div><div class="k">Purchased</div><div class="v">${PM.fmtDate(d.purchased) || "—"}</div></div></div>
            ${d.notes ? `<p>${esc(d.notes)}</p>` : ""}
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              ${d.checkout ? `<button class="btn" id="tmIn">Check in</button>` : ["Lost", "Out of service"].includes(d.condition) ? "" : `<button class="btn primary" id="tmOut">Check out</button>`}
              ${admin ? `<button class="btn" id="tmEdit">Edit</button>` : ""}</div></div></div>
        <h3 style="margin-top:16px">History</h3>
        <ul class="history">${(d.history || []).slice().reverse().map(h => `<li>${line(h)} <span class="muted">· ${esc(h.by || "")} · ${PM.fmtDateTime(h.at)}</span>${h.note ? `<div class="muted">${esc(h.note)}</div>` : ""}</li>`).join("") || `<li class="muted">No history yet.</li>`}</ul>`,
      onOpen: root => {
        const go = fn => () => { PM.closeModal(); fn(); };
        const o = $("#tmOut", root); if (o) o.onclick = go(() => checkOut(t, people));
        const i = $("#tmIn", root); if (i) i.onclick = go(() => checkIn(t));
        const e = $("#tmEdit", root); if (e) e.onclick = go(() => editTool(t));
      }
    });
  }

  function exportCSV(all) {
    const rows = [["Tag #", "Tool", "Category", "Make", "Model", "Serial #", "Value", "Purchased", "Condition", "Status", "Checked out to", "Project", "Out since", "Due back"]];
    all.forEach(t => { const d = t.data, co = d.checkout || {}; rows.push([d.tag, d.name, d.category, d.make, d.model, d.serial, d.value, d.purchased, d.condition || "Good", STATUS_LABEL[statusOf(t)], co.name || "", projectName(co.projectId), co.out || "", co.due || ""]); });
    const csv = rows.map(r => r.map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `tools-${today()}.csv`;
    a.click();
  }

  function decorateTopbar() {
    const nav = $(".topnav");
    if (nav && !$("[data-nav=tools]", nav)) nav.insertAdjacentHTML("beforeend", `<a href="#/tools" data-nav="tools">Tools</a>`);
  }

  PM.tools = { page, decorateTopbar, statusOf };
})();

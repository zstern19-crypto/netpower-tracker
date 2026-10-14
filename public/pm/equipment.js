// NetPower PM — MEP equipment list per project (Submittals → Equipment): every piece of equipment we need a
// submittal for. Start from the company template, read the mechanical / plumbing schedules with AI, or add by hand.
//   records: "equipment" (per project, Submittals permission); company template: setting "set_meptemplate"
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast, Store } = PM;

  const TEMPLATE_ID = "set_meptemplate";
  const TRADES = ["Mechanical", "Plumbing", "Fire Protection", "Electrical", "Other"];
  const template = () => { const s = Store.get(TEMPLATE_ID); return (s && s.data.items) || []; };
  const all = p => Store.all("equipment", p.id).sort((a, b) => TRADES.indexOf(a.data.trade) - TRADES.indexOf(b.data.trade) || String(a.data.tag || "~").localeCompare(String(b.data.tag || "~"), undefined, { numeric: true }) || String(a.data.description).localeCompare(String(b.data.description)));
  const key = d => (d.tag ? "t:" + d.tag : "d:" + d.description).toUpperCase().replace(/\s+/g, "");
  const subStatus = d => { const s = d.submittalId && Store.get(d.submittalId); return s ? s : null; };

  // ── Add / edit one item
  function editItem(p, rec) {
    const d = rec ? rec.data : { trade: "Mechanical" };
    const subs = Store.all("submittal", p.id).sort((a, b) => a.data.number - b.data.number || a.data.revision - b.data.revision);
    PM.openModal({
      title: rec ? `Edit ${d.tag || d.description}` : "Add Equipment",
      wide: true,
      body: `<div class="form-grid">
          <div class="field"><label for="eqTag">Tag</label><input id="eqTag" value="${esc(d.tag || "")}" placeholder="e.g. RTU-1"></div>
          <div class="field"><label for="eqTrade">Trade</label><select id="eqTrade">${TRADES.map(t => `<option ${d.trade === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
          <div class="field full"><label for="eqDesc">Description *</label><input id="eqDesc" value="${esc(d.description || "")}" placeholder="e.g. Rooftop unit"></div>
          <div class="field"><label for="eqMfr">Manufacturer</label><input id="eqMfr" value="${esc(d.manufacturer || "")}"></div>
          <div class="field"><label for="eqModel">Model</label><input id="eqModel" value="${esc(d.model || "")}"></div>
          <div class="field"><label for="eqQty">Quantity</label><input id="eqQty" value="${esc(d.quantity || "")}"></div>
          <div class="field"><label for="eqLoc">Location</label><input id="eqLoc" value="${esc(d.location || "")}"></div>
          <div class="field full"><label for="eqElec">Electrical data</label><input id="eqElec" value="${esc(d.electrical || "")}" placeholder="e.g. 208V/3Ph, MCA 42A, MOCP 60A"></div>
          <div class="field"><label for="eqSheet">Sheet</label><input id="eqSheet" value="${esc(d.sheet || "")}" placeholder="e.g. M-601"></div>
          <div class="field"><label for="eqSub">Submittal</label><select id="eqSub"><option value="">— none yet —</option>${subs.map(s => `<option value="${s.id}" ${d.submittalId === s.id ? "selected" : ""}>#${s.data.number}.${s.data.revision || 0} ${esc(s.data.title || "")}</option>`).join("")}</select></div>
          <div class="field full"><label for="eqNotes">Notes</label><textarea id="eqNotes">${esc(d.notes || "")}</textarea></div>
        </div>`,
      onSave: async root => {
        const v = id => $("#" + id, root).value.trim();
        if (!v("eqDesc")) { toast("Enter a description", true); return false; }
        const data = { ...(rec ? rec.data : { source: "Added by hand", createdBy: PM.meName(), createdAt: new Date().toISOString() }),
          tag: v("eqTag"), trade: v("eqTrade"), description: v("eqDesc"), manufacturer: v("eqMfr"), model: v("eqModel"), quantity: v("eqQty"),
          location: v("eqLoc"), electrical: v("eqElec"), sheet: v("eqSheet"), submittalId: v("eqSub"), notes: v("eqNotes") };
        return PM.saveRec({ id: rec ? rec.id : PM.uid("eq"), type: "equipment", projectId: p.id, data }, rec ? "Saved" : "Added");
      }
    });
  }

  // ── Company template (company admins)
  function templateModal() {
    let rows = template().map(x => ({ ...x }));
    const draw = root => {
      $("#tpRows", root).innerHTML = rows.map((r, i) => `<div class="jt-edit-row"><input data-i="${i}" data-k="name" value="${esc(r.name)}" placeholder="Equipment" aria-label="Equipment ${i + 1}">
        <select data-i="${i}" data-k="trade" style="width:auto">${TRADES.map(t => `<option ${r.trade === t ? "selected" : ""}>${t}</option>`).join("")}</select>
        <button type="button" class="btn small danger" data-rm="${i}" aria-label="Remove">✕</button></div>`).join("") || `<p class="muted">No items yet.</p>`;
    };
    PM.openModal({
      title: "Standard MEP Equipment Template",
      wide: true,
      body: `<p class="muted" style="margin-top:0">The typical equipment list for a new job. “Start from template” on a project copies these into its Equipment list.</p>
        <div id="tpRows"></div><button type="button" class="btn small" id="tpAdd" style="margin:6px 0 14px">+ Add item</button>
        <details><summary>Paste a list (from Excel or Word)</summary>
          <p class="muted" style="font-size:13px">One item per line. Optionally add the trade after a tab or “|”, e.g. <code>Rooftop unit | Mechanical</code>.</p>
          <textarea id="tpPaste" rows="6"></textarea><button type="button" class="btn small" id="tpAddPaste" style="margin-top:6px">Add these lines</button></details>`,
      onOpen: root => {
        draw(root);
        $("#tpRows", root).oninput = $("#tpRows", root).onchange = e => { const i = e.target.dataset.i; if (i != null) rows[i][e.target.dataset.k] = e.target.value; };
        $("#tpRows", root).onclick = e => { const b = e.target.closest("[data-rm]"); if (b) { rows.splice(Number(b.dataset.rm), 1); draw(root); } };
        $("#tpAdd", root).onclick = () => { rows.push({ name: "", trade: "Mechanical" }); draw(root); $$("#tpRows input", root).pop().focus(); };
        $("#tpAddPaste", root).onclick = () => {
          const lines = $("#tpPaste", root).value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          lines.forEach(l => { const [name, trade] = l.split(/\t|\|/).map(x => x.trim()); const t = TRADES.find(x => x.toLowerCase() === String(trade || "").toLowerCase()); if (name) rows.push({ name, trade: t || "Mechanical" }); });
          $("#tpPaste", root).value = ""; draw(root); toast(`${lines.length} line${lines.length === 1 ? "" : "s"} added — click Save to keep them`);
        };
      },
      onSave: async () => {
        rows = rows.map(r => ({ name: String(r.name || "").trim(), trade: r.trade || "Mechanical" })).filter(r => r.name);
        try { await Store.save({ id: TEMPLATE_ID, type: "setting", projectId: "", data: { items: rows, updatedBy: PM.meName(), updatedAt: new Date().toISOString() } }); }
        catch (e) { toast(e.message, true); return false; }
        toast("Template saved");
        return true;
      }
    });
  }

  async function startFromTemplate(p) {
    const have = new Set(all(p).map(r => key(r.data)));
    const add = template().filter(t => !have.has(key({ description: t.name })));
    if (!add.length) { toast(template().length ? "Everything from the template is already on the list" : "The template is empty — a company admin can fill it in with “Edit template”", true); return; }
    const now = new Date().toISOString();
    try { await Store.saveMany(add.map(t => ({ id: PM.uid("eq"), type: "equipment", projectId: p.id, data: { tag: "", description: t.name, trade: t.trade, source: "Template", createdBy: PM.meName(), createdAt: now } }))); }
    catch (e) { toast("Not saved: " + e.message, true); return; }
    toast(`${add.length} item${add.length === 1 ? "" : "s"} added from the template`); PM.render();
  }

  // ── Read schedules with AI: each chosen sheet is cut out of its set, sent to Claude, and the rows come back for review
  const toB64 = async blob => { const a = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  const upload = async (name, blob, type) => PM.api("/api/assistant?action=upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, type, data: await toB64(blob) }) });

  function aiModal(p) {
    const sheets = (PM.drawings ? PM.drawings.sheetsOf(p) : []).filter(g => PM.drawings.currentRev(g));
    const pre = g => /schedule/i.test(g.data.title || "") && ["Mechanical", "Plumbing", "Fire Protection"].includes(g.data.discipline);
    const groups = ["Mechanical", "Plumbing", "Fire Protection"].map(dis => [dis, sheets.filter(g => g.data.discipline === dis)]).filter(([, l]) => l.length);
    const others = sheets.filter(g => !["Mechanical", "Plumbing", "Fire Protection"].includes(g.data.discipline));
    PM.openModal({
      title: "Read equipment schedules (AI)",
      wide: true,
      saveLabel: "Read sheets",
      hideSave: !sheets.length,
      noRender: true,
      body: sheets.length ? `<p class="muted" style="margin-top:0">Pick the sheets that have equipment schedules (usually M-6xx / P-6xx). Claude reads each one and lists the equipment; you check the list before anything is added. Each sheet costs a little from the monthly AI limit.</p>
        ${groups.map(([dis, l]) => `<h3>${esc(dis)}</h3><div class="checks">${l.map(g => `<label><input type="checkbox" name="aiSheet" value="${g.id}" ${pre(g) ? "checked" : ""}> <strong>${esc(g.data.number)}</strong> ${esc(g.data.title || "")}</label>`).join("")}</div>`).join("")}
        ${others.length ? `<details><summary>Other sheets (${others.length})</summary><div class="checks">${others.map(g => `<label><input type="checkbox" name="aiSheet" value="${g.id}"> <strong>${esc(g.data.number)}</strong> ${esc(g.data.title || "")}</label>`).join("")}</div></details>` : ""}
        <div id="aiProg" class="muted" style="margin-top:10px"></div>`
        : `<p>There are no drawings on this project yet. Upload the mechanical and plumbing drawings under Drawings first.</p>`,
      onSave: async root => {
        const picked = $$("input[name=aiSheet]:checked", root).map(i => Store.get(i.value));
        if (!picked.length) { toast("Pick at least one sheet", true); return false; }
        const prog = $("#aiProg", root), found = [];
        let spent = 0, failed = [];
        for (const [i, g] of picked.entries()) {
          const rev = PM.drawings.currentRev(g);
          prog.textContent = `Reading ${g.data.number} (${i + 1} of ${picked.length})…`;
          try {
            let blob = await PM.drawings.sheetPdf(rev), name = `${g.data.number}.pdf`, type = "application/pdf";
            if (blob.size > 3 * 1024 * 1024) { blob = await PM.drawings.sheetImage(rev); name = `${g.data.number}.jpg`; type = "image/jpeg"; }
            const up = await upload(name, blob, type);
            const d = await PM.api("/api/assistant?action=schedules", { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ projectId: p.id, files: [{ fileId: up.fileId, name: up.name }], fileSigs: { [up.fileId]: up.sig } }) });
            spent += d.usage.costUsd || 0;
            d.items.forEach(x => found.push({ ...x, sheet: x.sheet || g.data.number }));
          } catch (e) { failed.push(`${g.data.number}: ${e.message}`); if (/limit|402/.test(e.message)) break; }
        }
        if (failed.length) toast("Not read: " + failed.join("; "), true);
        setTimeout(() => reviewModal(p, found, spent), 0);   // after this dialog has closed
        return true;
      }
    });
  }

  function reviewModal(p, found, spent) {
    const have = new Set(all(p).map(r => key(r.data)));
    const seen = new Set();
    // template rows have no tag yet: a found item with the same kind of description fills that row in instead of adding a new one
    const norm = t => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const open = all(p).filter(r => !r.data.tag);
    const used = new Set();
    const rows = found.map(x => {
      const k = key(x); const dup = have.has(k) || seen.has(k); seen.add(k);
      const fill = dup ? null : open.find(r => !used.has(r.id) && norm(r.data.description) && (norm(x.description).includes(norm(r.data.description)) || norm(r.data.description).includes(norm(x.description))));
      if (fill) used.add(fill.id);
      return { ...x, dup, fill };
    });
    PM.openModal({
      title: `Equipment found (${rows.length})`,
      wide: true,
      saveLabel: "Add selected",
      body: rows.length ? `<p class="muted" style="margin-top:0">Check the list against the drawings — the AI can misread. Items already on the list are unticked. ${spent ? `Cost about $${spent.toFixed(2)}.` : ""}</p>
        <div class="table-wrap"><table class="list"><thead><tr><th><input type="checkbox" id="rvAll" checked aria-label="Select all"></th><th>Tag</th><th>Description</th><th>Trade</th><th>Manufacturer / model</th><th>Electrical</th><th>Sheet</th></tr></thead><tbody>
          ${rows.map((x, i) => `<tr><td><input type="checkbox" name="rvRow" value="${i}" ${x.dup ? "" : "checked"}></td><td class="nowrap"><strong>${esc(x.tag)}</strong></td><td>${esc(x.description)}${x.dup ? ` <span class="muted">(already listed)</span>` : x.fill ? ` <span class="muted">(fills in “${esc(x.fill.data.description)}”)</span>` : ""}${x.notes ? `<div class="muted" style="font-size:12px">${esc(x.notes)}</div>` : ""}</td>
            <td>${esc(x.trade)}</td><td>${esc([x.manufacturer, x.model].filter(Boolean).join(" "))}</td><td style="font-size:13px">${esc(x.electrical)}</td><td>${esc(x.sheet)}</td></tr>`).join("")}
        </tbody></table></div>` : `<p>No equipment schedules were found on those sheets.</p>`,
      onOpen: root => { const a = $("#rvAll", root); if (a) a.onchange = () => $$("input[name=rvRow]", root).forEach(c => { c.checked = a.checked; }); },
      onSave: async root => {
        const pick = $$("input[name=rvRow]:checked", root).map(c => rows[Number(c.value)]);
        if (!pick.length) return true;
        const now = new Date().toISOString();
        try {
          await Store.saveMany(pick.map(x => ({ id: x.fill ? x.fill.id : PM.uid("eq"), type: "equipment", projectId: p.id, data: { ...(x.fill ? x.fill.data : {}),
            tag: x.tag, description: x.description, trade: TRADES.includes(x.trade) ? x.trade : "Other", manufacturer: x.manufacturer, model: x.model, quantity: x.quantity,
            electrical: x.electrical, location: x.location, sheet: x.sheet, notes: x.notes, source: (x.fill ? "Template + AI · " : "AI · ") + (x.sheet || "drawings"), ...(x.fill ? {} : { createdBy: PM.meName(), createdAt: now }) } })));
        } catch (e) { toast("Not saved: " + e.message, true); return false; }
        toast(`${pick.length} item${pick.length === 1 ? "" : "s"} added`);
        return true;
      }
    });
  }

  async function createSubmittal(p, rec) {
    const d = rec.data;
    const s = { id: PM.uid("sub"), type: "submittal", projectId: p.id, data: { number: PM.nextNumber("submittal", p.id), revision: 0, title: [d.tag, d.description].filter(Boolean).join(" – "),
      status: "Draft", managerId: PM.me() || p.data.pmId || "", issueDate: PM.today(), subType: "Product Data", location: d.location || "", workflow: [], attachments: [], distribution: [], linkedDrawings: [],
      description: [d.manufacturer, d.model, d.electrical].filter(Boolean).join(" · "), createdBy: PM.meName(), createdAt: new Date().toISOString() } };
    PM.withHistory(s, `Created from equipment ${d.tag || d.description}`);
    if (!(await PM.saveRec(s))) return;
    if (await PM.saveRec({ ...rec, data: { ...d, submittalId: s.id } }, `Submittal #${s.data.number}.0 created`)) location.hash = `#/p/${p.id}/submittals/${s.id}`;
  }

  function exportCSV(p) {
    const rows = [["Tag", "Description", "Trade", "Manufacturer", "Model", "Qty", "Electrical", "Location", "Sheet", "Submittal", "Submittal status", "Notes", "Source"]];
    all(p).forEach(r => { const d = r.data, s = subStatus(d); rows.push([d.tag, d.description, d.trade, d.manufacturer, d.model, d.quantity, d.electrical, d.location, d.sheet, s ? `#${s.data.number}.${s.data.revision || 0}` : "", s ? s.data.status : "", d.notes, d.source]); });
    const csv = rows.map(r => r.map(x => { const t = String(x == null ? "" : x); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(",")).join("\r\n");
    PM.exporter.saveFile(new Blob(["﻿" + csv], { type: "text/csv" }), `${p.data.name.replace(/[^\w -]+/g, "")} equipment.csv`);
  }

  async function page(p) {
    await Promise.all([Store.load("setting"), PM.can(p.id, "drawings") ? Store.load("drawing", p.id) : null]);
    const list = all(p), edit = PM.can(p.id, "submittals", "standard"), del = PM.can(p.id, "submittals", "admin"), admin = PM.isCompanyAdmin();
    const q = (PM.lsGet("netpower_pm_eq_q", "") || "").toLowerCase();
    const shown = list.filter(r => !q || Object.values(r.data).join(" ").toLowerCase().includes(q));
    const noSub = list.filter(r => !subStatus(r.data)).length;
    const st = PM.assistant && PM.session ? await PM.assistant.refreshStatus() : null;
    const aiOk = !!(st && st.allowed);   // same access and monthly limit as the AI assistant
    setTimeout(() => {
      const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
      on("#eqAdd", () => editItem(p, null)); on("#eqTpl", () => startFromTemplate(p)); on("#eqAi", () => aiModal(p)); on("#eqTplEdit", templateModal); on("#eqCsv", () => exportCSV(p));
      $$("[data-eq-edit]").forEach(b => b.onclick = () => editItem(p, Store.get(b.dataset.eqEdit)));
      $$("[data-eq-sub]").forEach(b => b.onclick = () => createSubmittal(p, Store.get(b.dataset.eqSub)));
      $$("[data-eq-del]").forEach(b => b.onclick = async () => { if (!window.confirm("Remove this item from the list?")) return; try { await Store.remove(b.dataset.eqDel); PM.render(); } catch (e) { toast(e.message, true); } });
      const s = $("#eqSearch"); if (s) s.oninput = () => { PM.lsSet("netpower_pm_eq_q", s.value); clearTimeout(s._t); s._t = setTimeout(() => PM.render().then(() => { const s2 = $("#eqSearch"); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } }), 250); };
    }, 0);
    return `<div class="page-head"><h1>Submittals</h1>
        <div class="actions">${edit ? `<button class="btn" id="eqTpl">Start from template</button>${aiOk ? `<button class="btn" id="eqAi">✦ Read equipment schedules</button>` : ""}<button class="btn primary" id="eqAdd">+ Add equipment</button>` : ""}</div></div>
      <div class="tabs sub-tabs"><a href="#/p/${p.id}/submittals">Items</a><a href="#/p/${p.id}/submittals/packages">Packages</a><a href="#/p/${p.id}/submittals/equipment" class="on">Equipment</a></div>
      <div class="panel flush"><div class="toolbar"><input type="search" id="eqSearch" placeholder="Search equipment…" value="${esc(q)}" aria-label="Search equipment">
        <span class="muted">${list.length} item${list.length === 1 ? "" : "s"}${list.length ? ` · ${noSub} without a submittal` : ""}</span><span class="spacer"></span>
        ${admin ? `<button class="btn small" id="eqTplEdit">Edit template</button>` : ""}<button class="btn small" id="eqCsv">Export CSV</button></div>
        ${shown.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Tag</th><th>Description</th><th>Trade</th><th>Manufacturer / model</th><th>Electrical</th><th>Sheet</th><th>Submittal</th><th></th></tr></thead><tbody>
          ${shown.map(r => { const d = r.data, s = subStatus(d); return `<tr>
            <td class="nowrap"><strong>${esc(d.tag || "")}</strong></td><td>${esc(d.description)}${d.location ? `<div class="muted" style="font-size:12px">${esc(d.location)}</div>` : ""}${d.notes ? `<div class="muted" style="font-size:12px">${esc(d.notes)}</div>` : ""}</td>
            <td>${esc(d.trade || "")}</td><td>${esc([d.manufacturer, d.model].filter(Boolean).join(" "))}${d.quantity ? `<div class="muted" style="font-size:12px">Qty ${esc(d.quantity)}</div>` : ""}</td>
            <td style="font-size:13px">${esc(d.electrical || "")}</td><td class="nowrap">${esc(d.sheet || "")}</td>
            <td class="nowrap">${s ? `<a href="#/p/${p.id}/submittals/${s.id}">#${s.data.number}.${s.data.revision || 0}</a> ${PM.pill(s.data.status)}` : edit ? `<button class="btn small" data-eq-sub="${r.id}">Create submittal</button>` : `<span class="muted">None</span>`}</td>
            <td class="nowrap">${edit ? `<button class="btn small" data-eq-edit="${r.id}">Edit</button>` : ""} ${del ? `<button class="btn small danger" data-eq-del="${r.id}" aria-label="Remove">✕</button>` : ""}</td></tr>`; }).join("")}
        </tbody></table></div>` : `<div class="empty">${list.length ? "No equipment matches." : "No equipment yet. Use “Start from template”, read the mechanical and plumbing schedules with AI, or add items by hand."}</div>`}</div>`;
  }

  PM.equipment = { page, templateModal };
})();

// NetPower PM — Change Orders per project (Procore-style): Draft → Pending (submitted) → Approved / Rejected / Void.
//   #/p/<pid>/changeorders          list with approved / pending totals
//   #/p/<pid>/changeorders/<id>     one change order
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast, Store } = PM;

  const STATUSES = ["Draft", "Pending", "Approved", "Rejected", "Void"];
  const PILL = { Draft: "draft", Pending: "open", Approved: "approved", Rejected: "rejected", Void: "draft" };
  const REMIND = [["", "No reminder"], ["2", "in 2 days"], ["3", "in 3 days"], ["5", "in 5 days"], ["7", "in a week"], ["10", "in 10 days"], ["14", "in 2 weeks"]];
  const open = d => ["Draft", "Pending"].includes(d.status);
  const all = p => Store.all("changeorder", p.id).sort((a, b) => (Number(b.data.number) || 0) - (Number(a.data.number) || 0));
  const amt = r => Number(r.data.amount) || 0;
  const sum = list => list.reduce((s, r) => s + amt(r), 0);
  const money = n => (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const label = r => `CO #${r.data.number}`;

  function editCO(p, rec) {
    const d = rec ? rec.data : { status: "Draft", number: PM.nextNumber("changeorder", p.id) };
    let files = (d.attachments || []).slice();
    const rfis = Store.all("rfi", p.id).sort((a, b) => a.data.number - b.data.number);
    const drawFiles = root => { $("#coFiles", root).innerHTML = files.map((f, i) => `<div>📎 ${esc(f.name)} <button type="button" class="btn small" data-rmf="${i}">Remove</button></div>`).join(""); };
    PM.openModal({
      title: rec ? `Edit ${label(rec)}` : "New Change Order",
      wide: true,
      body: `<div class="form-grid">
          <div class="field"><label for="coNum">Number</label><input id="coNum" type="number" min="1" value="${esc(d.number)}"></div>
          <div class="field"><label for="coStatus">Status</label><select id="coStatus">${STATUSES.map(s => `<option ${d.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
          <div class="field full"><label for="coTitle">Title *</label><input id="coTitle" value="${esc(d.title || "")}" placeholder="e.g. Add 4 receptacles in conference room"></div>
          <div class="field"><label for="coAmount">Amount ($)</label><input id="coAmount" type="number" step="0.01" value="${esc(d.amount ?? "")}" placeholder="Use a minus sign for a credit"></div>
          <div class="field"><label for="coSubmitted">Date submitted</label><input id="coSubmitted" type="date" value="${esc(d.submitted || "")}"></div>
          <div class="field"><label for="coRemind">Remind me</label><select id="coRemind">${REMIND.map(([v, l]) => `<option value="${v}" ${String(d.remindDays || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
            <div class="muted help">${d.remindAt && d.remindDays ? `Set for ${esc(PM.fmtDate(d.remindAt))} (🔔 until it's approved or rejected)` : "Shows in your 🔔 notifications until the CO is approved or rejected."}</div></div>
          <div class="field"><label for="coApproved">Date approved / rejected</label><input id="coApproved" type="date" value="${esc(d.decided || "")}"></div>
          <div class="field full"><label>Related RFIs</label><div class="checks">${rfis.map(r => `<label><input type="checkbox" name="coRfi" value="${r.id}" ${(d.rfis || []).includes(r.id) ? "checked" : ""}> RFI #${esc(r.data.number)} ${esc(r.data.subject || "")}</label>`).join("") || `<span class="muted">No RFIs on this project.</span>`}</div></div>
          <div class="field full"><label for="coDesc">Description / scope</label><textarea id="coDesc" rows="5">${esc(d.description || "")}</textarea></div>
          <div class="field full"><label>Files (quote, backup, signed CO)</label><div id="coFiles"></div><input type="file" id="coUpload" multiple></div>
        </div>`,
      onOpen: root => {
        drawFiles(root);
        $("#coFiles", root).onclick = e => { const b = e.target.closest("[data-rmf]"); if (b) { files.splice(Number(b.dataset.rmf), 1); drawFiles(root); } };
        $("#coUpload", root).onchange = async e => {
          for (const file of e.target.files) {
            const row = document.createElement("div"); row.textContent = "Uploading " + file.name + "…"; $("#coFiles", root).appendChild(row);
            try { files.push({ name: file.name, url: await PM.files.upload(`attachments/${p.id}/changeorders`, file), type: file.type, size: file.size }); }
            catch (err) { toast("Upload failed: " + err.message, true); }
          }
          e.target.value = ""; drawFiles(root);
        };
      },
      onSave: async root => {
        const v = id => $("#" + id, root).value.trim();
        const num = v => (v === "" ? "" : Number(v));
        if (!v("coTitle")) { toast("Enter a title", true); return false; }
        const number = Number(v("coNum"));
        if (!(number >= 1)) { toast("Enter a number", true); return false; }
        if (Store.all("changeorder", p.id).some(x => x.id !== (rec && rec.id) && Number(x.data.number) === number)) { toast(`CO #${number} already exists`, true); return false; }
        if ($("#coFiles", root).textContent.includes("Uploading")) { toast("Wait for the files to finish uploading", true); return false; }
        const data = { ...(rec ? rec.data : { createdBy: PM.meName(), createdAt: new Date().toISOString() }),
          number, title: v("coTitle"), status: v("coStatus"), amount: num(v("coAmount")), submitted: v("coSubmitted"), decided: v("coApproved"),
          ...remindFields(rec ? rec.data : {}, v("coRemind")),
          rfis: $$("input[name=coRfi]:checked", root).map(i => i.value), description: v("coDesc"), attachments: files };
        const removed = rec ? (rec.data.attachments || []).filter(f => !files.some(x => x.url === f.url)).map(f => f.url) : [];
        const next = PM.withHistory({ id: rec ? rec.id : PM.uid("co"), type: "changeorder", projectId: p.id, data },
          rec ? (rec.data.status !== data.status ? `Status changed to ${data.status}` : "Edited") : "Created");
        if (!(await PM.saveRec(next, rec ? "Change order saved" : `CO #${number} created`))) return false;
        if (removed.length) PM.files.deleteFiles(removed).catch(() => {});
        if (!rec) setTimeout(() => { location.hash = `#/p/${p.id}/changeorders/${next.id}`; }, 0);
        return true;
      }
    });
  }

  // Reminder: N days from when it was set (kept if unchanged); for whoever set it
  function remindFields(old, days) {
    if (!days) return { remindDays: "", remindAt: "", remindUserId: "" };
    if (String(old.remindDays) === days && old.remindAt) return { remindDays: days, remindAt: old.remindAt, remindUserId: old.remindUserId };
    return { remindDays: days, remindAt: PM.addDays(PM.today(), Number(days)), remindUserId: PM.session ? PM.session.user.id : "", remindBy: PM.meName() };
  }

  async function setStatus(rec, status) {
    const extra = status === "Pending" && !rec.data.submitted ? { submitted: PM.today() } : ["Approved", "Rejected"].includes(status) && !rec.data.decided ? { decided: PM.today() } : {};
    const next = PM.withHistory({ ...rec, data: { ...rec.data, status, ...extra } }, `Status changed to ${status}`);
    if (await PM.saveRec(next, `${label(rec)}: ${status}`)) PM.render();
  }

  function exportCSV(p) {
    const rows = [["#", "Title", "Status", "Amount", "Submitted", "Approved/Rejected", "Reminder", "RFIs", "Description"]];
    all(p).slice().reverse().forEach(r => { const d = r.data; rows.push([d.number, d.title, d.status, d.amount, d.submitted, d.decided, open(d) && d.remindAt ? d.remindAt : "",
      (d.rfis || []).map(id => Store.get(id)).filter(Boolean).map(x => "RFI #" + x.data.number).join("; "), d.description]); });
    const csv = rows.map(r => r.map(x => { const t = String(x == null ? "" : x); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(",")).join("\r\n");
    PM.exporter.saveFile(new Blob(["﻿" + csv], { type: "text/csv" }), `${p.data.name.replace(/[^\w -]+/g, "")} change orders.csv`);
  }

  // ── Drop a change order / proposal PDF: Claude reads it and a Draft CO is created with the PDF attached
  const toB64 = async blob => { const a = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  let reading = false;
  async function fromPdf(p, file) {
    if (reading) return;
    const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name), isImg = /^image\/(jpeg|png|webp|gif)$/.test(file.type);
    if (!isPdf && !isImg) { toast("Drop a PDF (or a photo of the change order)", true); return; }
    if (file.size > 3 * 1024 * 1024) { toast("That file is over 3 MB — too big for the AI. Create the change order by hand and attach it.", true); return; }
    reading = true;
    const box = $("#coDrop"); if (box) box.classList.add("busy");
    toast("Reading " + file.name + "…");
    try {
      const [up, url] = await Promise.all([
        PM.api("/api/assistant?action=upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: file.name, type: isPdf ? "application/pdf" : file.type, data: await toB64(file) }) }),
        PM.files.upload(`attachments/${p.id}/changeorders`, file)
      ]);
      const d = await PM.api("/api/assistant?action=changeorder", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: p.id, file: { fileId: up.fileId, name: up.name }, fileSigs: { [up.fileId]: up.sig } }) });
      const c = d.changeOrder || {};
      if (c.isChangeOrder === false && !window.confirm("This doesn't look like a change order or proposal. Create one from it anyway?")) { PM.files.deleteFiles([url]).catch(() => {}); return; }
      const number = PM.nextNumber("changeorder", p.id);
      const rec = PM.withHistory({ id: PM.uid("co"), type: "changeorder", projectId: p.id, data: {
        number, title: c.title || file.name.replace(/\.[a-z]+$/i, ""), status: "Draft", amount: typeof c.amount === "number" ? c.amount : "",
        submitted: /^\d{4}-\d{2}-\d{2}$/.test(c.submitted || "") ? c.submitted : "", rfis: [],
        description: [c.documentNumber ? `Document #: ${c.documentNumber}` : "", c.description || ""].filter(Boolean).join("\n\n"),
        attachments: [{ name: file.name, url, type: file.type, size: file.size }], fromPdf: true, createdBy: PM.meName(), createdAt: new Date().toISOString() } }, `Created from ${file.name} (read by AI)`);
      if (!(await PM.saveRec(rec, `CO #${number} created from the PDF — check the details`))) return;
      location.hash = `#/p/${p.id}/changeorders/${rec.id}`;
    } catch (e) { toast("Couldn't read it: " + e.message, true); }
    finally { reading = false; const b2 = $("#coDrop"); if (b2) b2.classList.remove("busy"); }
  }

  async function list(p) {
    const recs = all(p);
    const view = PM.lsGet("netpower_pm_co_view", "") || "";
    const shown = recs.filter(r => !view || r.data.status === view);
    const approved = sum(recs.filter(r => r.data.status === "Approved")), pending = sum(recs.filter(r => r.data.status === "Pending")), draft = sum(recs.filter(r => r.data.status === "Draft"));
    const canEdit = PM.can(p.id, "changeorders", "standard");
    const showContract = PM.isCompanyAdmin() && Number(p.data.value);
    const st = canEdit && PM.assistant && PM.session ? await PM.assistant.refreshStatus() : null;
    const aiOk = !!(st && st.allowed);
    setTimeout(() => {
      const add = $("#coAdd"); if (add) add.onclick = () => editCO(p, null);
      const csv = $("#coCsv"); if (csv) csv.onclick = () => exportCSV(p);
      const f = $("#coFilter"); if (f) f.onchange = () => { PM.lsSet("netpower_pm_co_view", f.value); PM.render(); };
      const drop = $("#coDrop"), inp = $("#coPdf");
      if (drop && inp) {
        inp.onchange = () => { if (inp.files[0]) fromPdf(p, inp.files[0]); inp.value = ""; };
        drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
        drop.ondragleave = () => drop.classList.remove("over");
        drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); const file = e.dataTransfer.files[0]; if (file) fromPdf(p, file); };
      }
    }, 0);
    return `<div class="page-head"><h1>Change Orders</h1><span class="sub">${recs.length} total</span>
        <div class="actions"><button class="btn" id="coCsv">Export CSV</button>${canEdit ? `<button class="btn primary" id="coAdd">+ Create Change Order</button>` : ""}</div></div>
      <div class="cards">
        <div class="card"><div class="num">${money(approved)}</div><div class="lbl">Approved (${recs.filter(r => r.data.status === "Approved").length})</div></div>
        <div class="card"><div class="num">${money(pending)}</div><div class="lbl">Pending (${recs.filter(r => r.data.status === "Pending").length})</div></div>
        <div class="card"><div class="num">${money(draft)}</div><div class="lbl">Draft (${recs.filter(r => r.data.status === "Draft").length})</div></div>
        ${showContract ? `<div class="card"><div class="num">${money(Number(p.data.value) + approved)}</div><div class="lbl">Revised contract (original ${money(Number(p.data.value))})</div></div>` : ""}
      </div>
      ${aiOk ? `<label class="co-drop" id="coDrop"><input type="file" id="coPdf" accept="application/pdf,image/*" hidden>
        <strong>📄 Drop a change order or proposal PDF here</strong> <span class="muted">— or click to pick one. Claude reads it and creates the change order for you to check.</span></label>` : ""}
      <div class="panel flush"><div class="toolbar"><select id="coFilter" aria-label="Status"><option value="">All statuses</option>${STATUSES.map(s => `<option ${view === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        ${shown.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>#</th><th>Title</th><th>Status</th><th class="num">Amount</th><th>Submitted</th><th>Reminder</th></tr></thead><tbody>
          ${shown.map(r => { const d = r.data; const late = open(d) && d.remindAt && d.remindAt <= PM.today(); return `<tr class="click" data-href="#/p/${p.id}/changeorders/${r.id}">
            <td class="nowrap"><a href="#/p/${p.id}/changeorders/${r.id}">CO #${esc(d.number)}</a></td><td>${esc(d.title)}</td><td><span class="pill ${PILL[d.status] || ""}">${esc(d.status)}</span></td>
            <td class="num nowrap">${d.amount === "" || d.amount == null ? "" : money(amt(r))}</td>
            <td class="nowrap">${esc(PM.fmtDate(d.submitted) || "")}</td><td class="nowrap ${late ? "overdue" : ""}">${open(d) && d.remindAt ? "🔔 " + esc(PM.fmtDate(d.remindAt)) : ""}</td></tr>`; }).join("")}
        </tbody></table></div>` : `<div class="empty">No change orders${view ? " with this status" : " yet"}.</div>`}</div>`;
  }

  function detail(p, id) {
    const r = Store.get(id);
    if (!r || r.type !== "changeorder") return `<div class="empty">Change order not found. <a href="#/p/${p.id}/changeorders">Back</a></div>`;
    const d = r.data, canEdit = PM.can(p.id, "changeorders", "standard"), canDel = PM.can(p.id, "changeorders", "admin");
    const next = { Draft: ["Pending"], Pending: ["Approved", "Rejected"], Rejected: ["Pending"], Approved: [], Void: ["Draft"] }[d.status] || [];
    setTimeout(() => {
      const e = $("#coEdit"); if (e) e.onclick = () => editCO(p, Store.get(id));
      $$("[data-co-status]").forEach(b => b.onclick = () => setStatus(Store.get(id), b.dataset.coStatus));
      const del = $("#coDel"); if (del) del.onclick = async () => {
        if (!window.confirm(`Delete ${label(r)}?`)) return;
        try { await Store.remove(id); PM.files.deleteFiles((d.attachments || []).map(f => f.url)).catch(() => {}); toast("Deleted"); location.hash = `#/p/${p.id}/changeorders`; } catch (err) { toast(err.message, true); }
      };
    }, 0);
    const info = [["Status", `<span class="pill ${PILL[d.status] || ""}">${esc(d.status)}</span>`], ["Amount", d.amount === "" || d.amount == null ? "—" : money(amt(r))],
      ["Submitted", esc(PM.fmtDate(d.submitted) || "—")], ["Approved / rejected", esc(PM.fmtDate(d.decided) || "—")],
      ["Reminder", open(d) && d.remindAt ? `🔔 ${esc(PM.fmtDate(d.remindAt))}${d.remindBy ? " for " + esc(d.remindBy) : ""}` : "—"],
      ["Related RFIs", (d.rfis || []).map(x => Store.get(x)).filter(Boolean).map(x => `<a href="#/p/${p.id}/rfis/${x.id}">RFI #${esc(x.data.number)}</a>`).join(", ") || "—"]];
    return `<div class="crumb"><a href="#/p/${p.id}/changeorders">Change Orders</a> / CO #${esc(d.number)}</div>
      <div class="page-head"><h1>CO #${esc(d.number)}: ${esc(d.title)}</h1>
        <div class="actions">${canEdit ? next.map(s => `<button class="btn ${s === "Approved" ? "primary" : ""}" data-co-status="${s}">${{ Pending: d.status === "Draft" ? "Submit (Pending)" : "Resubmit", Approved: "Mark Approved", Rejected: "Mark Rejected", Draft: "Back to Draft" }[s]}</button>`).join("") : ""}
          ${canEdit && d.status !== "Void" ? `<button class="btn" data-co-status="Void">Void</button>` : ""}
          ${canEdit ? `<button class="btn" id="coEdit">Edit</button>` : ""}${canDel ? `<button class="btn danger" id="coDel">Delete</button>` : ""}</div></div>
      <div class="panel"><div class="info-grid">${info.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
        ${d.description ? `<h3 style="margin-top:16px">Description / scope</h3><div class="prose">${esc(d.description).replace(/\n/g, "<br>")}</div>` : ""}
        ${(d.attachments || []).length ? `<h3 style="margin-top:16px">Files</h3>${PM.forms.attachmentsView(d.attachments)}` : ""}</div>
      ${PM.historyPanel(d)}`.replace('<div class="panel"><div class="info-grid">', d.fromPdf && d.status === "Draft" ? '<div class="panel" style="border-left:3px solid var(--accent)"><p style="margin-top:0">✦ Filled in by AI from the attached PDF — check the amount and details, then edit or submit.</p><div class="info-grid">' : '<div class="panel"><div class="info-grid">');
  }

  function page(p, sub) { return sub ? detail(p, sub) : list(p); }   // list is async (checks AI access)
  PM.changeorders = { page };
})();

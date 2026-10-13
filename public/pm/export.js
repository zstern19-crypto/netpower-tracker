// NetPower PM — RFI export: PDF (print / Save as PDF), email (opens Outlook or your mail app), view-only link.
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast, Store } = PM;

  const fmtDate = d => PM.fmtDate(d) || "—";
  const names = ids => (ids || []).map(PM.contactName).filter(Boolean).join(", ");

  // ── PDF: a clean printable document in a hidden frame → the browser's print dialog ("Save as PDF")
  async function rfiDocHTML(p, rfis) {
    const pages = [];
    for (const r of rfis) {
      const d = r.data;
      const imgs = [];
      for (const f of (d.attachments || []).filter(PM.forms.isImage)) {
        try { imgs.push({ name: f.name, src: await PM.files.fileObjectUrl(f.url) }); } catch (e) { /* skip unavailable */ }
      }
      const files = (d.attachments || []).filter(f => !PM.forms.isImage(f));
      const rows = [["Status", d.status], ["Due Date", fmtDate(d.due)], ["RFI Manager", PM.contactName(d.managerId)], ["Assignees", names(d.assignees)],
        ["Distribution", names(d.distribution)], ["Received From", PM.contactLabel(d.receivedFromId)], ["Responsible Contractor", PM.companyName(d.responsibleCompanyId)],
        ["Location", d.location], ["Drawing", d.drawing], ["Spec Section", d.specSection], ["Cost Impact", d.costImpact], ["Schedule Impact", d.scheduleImpact ? d.scheduleImpact + (d.scheduleDays ? ` (${d.scheduleDays} days)` : "") : ""],
        ["Created", `${fmtDate(d.createdAt)}${d.createdBy ? " by " + d.createdBy : ""}`], ["Closed", d.closedAt ? fmtDate(d.closedAt) : ""]].filter(([, v]) => v);
      pages.push(`<section class="rfi">
        <div class="hdr"><div><div class="co">NetPower Electric</div><div class="pj">${esc(p.data.name)}${p.data.number ? " · " + esc(p.data.number) : ""}</div>
          ${p.data.address ? `<div class="pj">${esc([p.data.address, p.data.city, p.data.state].filter(Boolean).join(", "))}</div>` : ""}</div>
          <div class="no">RFI #${esc(d.number)}</div></div>
        <h1>${esc(d.subject)}</h1>
        <table class="info">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
        <h2>Question</h2><div class="rich">${PM.forms.sanitizeHTML(d.questionHtml || esc(d.question || "").replace(/\n/g, "<br>"))}</div>
        ${d.suggestion ? `<h2>Suggested Answer</h2><div class="rich">${esc(d.suggestion).replace(/\n/g, "<br>")}</div>` : ""}
        ${imgs.length ? `<h2>Photos</h2><div class="imgs">${imgs.map(i => `<figure><img src="${esc(i.src)}" alt=""><figcaption>${esc(i.name)}</figcaption></figure>`).join("")}</div>` : ""}
        ${files.length ? `<h2>Attachments</h2><ul>${files.map(f => `<li>${esc(f.name)}</li>`).join("")}</ul>` : ""}
        <h2>Responses (${(d.responses || []).length})</h2>
        ${(d.responses || []).map(x => `<div class="resp ${x.official ? "official" : ""}"><b>${esc(x.by)}</b> · ${esc(PM.fmtDateTime(x.at))}${x.official ? " · <b>OFFICIAL RESPONSE</b>" : ""}<div>${esc(x.text).replace(/\n/g, "<br>")}</div></div>`).join("") || `<p class="muted">No responses yet.</p>`}
        <div class="foot">Printed ${esc(new Date().toLocaleString())} by ${esc(PM.meName())} · NetPower PM</div></section>`);
    }
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(rfis.length === 1 ? `RFI ${rfis[0].data.number} - ${rfis[0].data.subject}` : `RFIs - ${p.data.name}`)}</title><style>
      body { font: 12pt/1.45 Helvetica, Arial, sans-serif; color: #111; margin: 0; }
      section.rfi { padding: 0 4px; } section.rfi + section.rfi { page-break-before: always; break-before: page; }
      .hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #f26722; padding-bottom: 8px; margin-bottom: 10px; }
      .co { font-weight: 800; font-size: 15pt; } .pj { color: #555; font-size: 10pt; } .no { font-size: 20pt; font-weight: 800; }
      h1 { font-size: 17pt; margin: 6px 0 10px; } h2 { font-size: 12pt; margin: 16px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
      table.info { border-collapse: collapse; width: 100%; font-size: 10.5pt; } table.info th { text-align: left; width: 170px; color: #555; font-weight: 600; padding: 3px 8px 3px 0; vertical-align: top; } table.info td { padding: 3px 0; }
      .imgs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; } .imgs figure { margin: 0; break-inside: avoid; page-break-inside: avoid; }
      .imgs img { width: 100%; max-height: 330px; object-fit: contain; border: 1px solid #ddd; } figcaption { font-size: 9pt; color: #555; }
      .resp { border-top: 1px solid #ddd; padding: 6px 0; break-inside: avoid; } .resp.official { border-left: 3px solid #1f9d55; padding-left: 8px; }
      .muted { color: #666; } .foot { margin-top: 18px; font-size: 9pt; color: #777; border-top: 1px solid #ddd; padding-top: 4px; }
      @page { margin: 14mm; }</style></head><body>${pages.join("")}</body></html>`;
  }
  async function printPDF(p, rfis) {
    toast("Preparing PDF…");
    const html = await rfiDocHTML(p, rfis);
    const f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true");
    Object.assign(f.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    document.body.appendChild(f);
    const doc = f.contentDocument;
    doc.open(); doc.write(html); doc.close();
    await Promise.all([...doc.images].map(img => (img.complete ? null : new Promise(res => { img.onload = img.onerror = res; setTimeout(res, 8000); }))));
    const prevTitle = document.title;
    document.title = doc.title;  // some browsers name the PDF after the top page's title
    f.contentWindow.focus();
    f.contentWindow.print();
    setTimeout(() => { document.title = prevTitle; f.remove(); }, 1000);
    toast("In the print window, choose “Save as PDF” to download it");
  }

  // ── View-only link
  const shareUrl = r => (r.data.share && r.data.share.token ? `${location.origin}/pm/share.html?t=${r.data.share.token}` : "");
  function newToken() { const a = new Uint8Array(24); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  async function ensureShare(r) {
    if (shareUrl(r)) return r;
    const next = PM.withHistory({ ...r, data: { ...r.data, share: { token: newToken(), by: PM.meName(), at: new Date().toISOString() } } }, "View-only link created");
    await Store.save(next);
    return Store.get(r.id) || next;
  }
  function shareModal(p, r) {
    PM.openModal({
      title: `View-only link — RFI #${r.data.number}`,
      noRender: true,
      hideSave: true,
      body: `<div id="shBody"></div>`,
      onOpen: root => {
        const draw = rec => {
          const url = shareUrl(rec);
          $("#shBody", root).innerHTML = url
            ? `<p style="margin-top:0">Anyone with this link can <strong>view</strong> this RFI (question, photos, responses) without logging in. They can't change anything.</p>
               <div class="with-mic"><input id="shUrl" readonly value="${esc(url)}"><button type="button" class="btn small" id="shCopy">Copy</button></div>
               ${rec.data.private ? `<p class="field-err" style="display:block">This RFI is marked private — only share the link with people who should see it.</p>` : ""}
               <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Open link</a><button type="button" class="btn small danger" id="shOff">Turn off link</button></div>`
            : `<p style="margin-top:0">Create a link that lets people without an account (architects, engineers, owners) view this RFI.</p><button type="button" class="btn primary" id="shOn">Create view-only link</button>`;
          const on = $("#shOn", root); if (on) on.onclick = async () => { try { draw(await ensureShare(rec)); } catch (e) { toast("Couldn't create link: " + e.message, true); } };
          const cp = $("#shCopy", root); if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch (e) { $("#shUrl", root).select(); } };
          const off = $("#shOff", root); if (off) off.onclick = async () => {
            if (!window.confirm("Turn off this link? Anyone who has it will lose access.")) return;
            const { share, ...rest } = rec.data;
            try { await Store.save(PM.withHistory({ ...rec, data: rest }, "View-only link turned off")); draw(Store.get(rec.id)); toast("Link turned off"); } catch (e) { toast(e.message, true); }
          };
        };
        draw(r);
      }
    });
  }

  // ── Email: opens a new message in Outlook (or the default mail app) with the RFI filled in
  function emailModal(p, r) {
    const d = r.data;
    const people = [...new Set([d.managerId, ...(d.assignees || []), ...(d.distribution || []), d.receivedFromId].filter(Boolean))]
      .map(id => Store.get(id)).filter(c => c && c.data.email);
    const canShare = PM.can(p.id, "rfis", "standard");
    PM.openModal({
      title: `Email RFI #${d.number}`,
      saveLabel: "Open in email",
      noRender: true,
      body: `
        <div class="field"><label>To</label><div class="checks">${people.map(c => `<label><input type="checkbox" name="emTo" value="${esc(c.data.email)}" ${(d.assignees || []).includes(c.id) ? "checked" : ""}> ${esc(c.data.name)} <span class="muted">${esc(c.data.email)}</span></label>`).join("") || `<span class="muted">Nobody on this RFI has an email address in the Directory.</span>`}</div></div>
        <div class="field"><label for="emMore">Other recipients</label><input id="emMore" placeholder="name@company.com, another@company.com"></div>
        <div class="field"><label for="emNote">Message (optional)</label><textarea id="emNote" placeholder="Please review and respond by the due date."></textarea></div>
        ${canShare ? `<label class="inline-check"><input type="checkbox" id="emLink" checked> Include a view-only link (they can see photos and responses without an account)</label>` : ""}
        <p class="muted" style="font-size:13px">This opens a new email in Outlook (or your default email app) with the RFI written in. Email programs can't receive attachments this way — to attach the PDF, click “Download PDF” first and drag the file into the email.</p>`,
      onSave: async root => {
        const to = [...$$("input[name=emTo]:checked", root).map(i => i.value), ...$("#emMore", root).value.split(/[,;\s]+/).filter(x => /@/.test(x))];
        let rec = r;
        if (canShare && $("#emLink", root) && $("#emLink", root).checked) { try { rec = await ensureShare(r); } catch (e) { toast("Link not created: " + e.message, true); } }
        const url = shareUrl(rec);
        const q = String(d.question || "").trim();
        const body = [$("#emNote", root).value.trim(), "",
          `RFI #${d.number}: ${d.subject}`, `Project: ${p.data.name}${p.data.number ? " (" + p.data.number + ")" : ""}`, `Status: ${d.status} · Due: ${fmtDate(d.due)}`,
          d.location ? `Location: ${d.location}` : "", d.drawing ? `Drawing: ${d.drawing}` : "", "", "Question:", q.length > 1200 ? q.slice(0, 1200) + "…" : q,
          (d.attachments || []).length ? `\nAttachments: ${(d.attachments || []).map(f => f.name).join(", ")}` : "",
          url ? `\nView the RFI (photos, responses): ${url}` : "", "", `— ${PM.meName()}, NetPower Electric`].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
        const href = `mailto:${to.map(encodeURIComponent).join(",")}?subject=${encodeURIComponent(`RFI #${d.number}: ${d.subject} — ${p.data.name}`)}&body=${encodeURIComponent(body)}`;
        window.location.href = href;
        if (rec !== r) setTimeout(() => PM.render(), 300);
        return true;
      }
    });
  }

  // ── Menus
  function menu(btn, items) {
    let m = $("#exportMenu");
    if (m) { m.remove(); if (m.dataset.for === btn.id) return; }
    m = document.createElement("div");
    m.id = "exportMenu";
    m.dataset.for = btn.id;
    m.className = "user-menu export-menu";
    m.innerHTML = items.map(([key, label]) => `<a href="#" data-ex="${key}">${label}</a>`).join("");
    const r = btn.getBoundingClientRect();
    Object.assign(m.style, { top: r.bottom + window.scrollY + 4 + "px", left: Math.max(8, r.right + window.scrollX - 260) + "px", right: "auto" });
    document.body.appendChild(m);
    const close = ev => { if (!ev.target.closest("#exportMenu") && ev.target !== btn) { m.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
    return new Promise(resolve => { m.onclick = ev => { const a = ev.target.closest("[data-ex]"); if (!a) return; ev.preventDefault(); m.remove(); resolve(a.dataset.ex); }; });
  }
  PM.ACTIONS.rfiExport = async el => {
    const r = Store.get(el.dataset.id), p = Store.get(r.projectId);
    const items = [["pdf", "⬇ Download PDF"], ["email", "✉ Email…"]];
    if (PM.can(p.id, "rfis", "standard") || shareUrl(r)) items.push(["share", "🔗 View-only link…"]);
    items.push(["print", "🖨 Print page"]);
    const pick = await menu(el, items);
    if (pick === "pdf") printPDF(p, [r]);
    if (pick === "email") emailModal(p, r);
    if (pick === "share") shareModal(p, r);
    if (pick === "print") window.print();
  };
  PM.ACTIONS.rfiExportList = async el => {
    const p = Store.get(el.dataset.project);
    const pick = await menu(el, [["pdf", "⬇ PDF of the RFIs shown"], ["csv", "⬇ Spreadsheet (CSV)"]]);
    if (pick === "csv") PM.ACTIONS.exportRFIs(el);
    if (pick === "pdf") {
      const ids = $$("#listBody tr[data-href]").map(tr => tr.dataset.href.split("/").pop());
      const rfis = ids.map(id => Store.get(id)).filter(Boolean);
      if (!rfis.length) { toast("No RFIs to export", true); return; }
      printPDF(p, rfis.sort((a, b) => a.data.number - b.data.number));
    }
  };

  PM.exporter = { printPDF, rfiDocHTML, emailModal, shareModal, ensureShare, shareUrl };
})();

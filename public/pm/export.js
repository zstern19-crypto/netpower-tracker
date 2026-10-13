// NetPower PM — RFI / Submittal export: a Procore-style PDF (cover sheet + the attached PDFs and photos merged in),
// email with the PDF attached (phone share sheet, or an Outlook draft file on a computer), view-only link.
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast, Store } = PM;

  const fmtDate = d => PM.fmtDate(d) || "";
  const names = ids => (ids || []).map(PM.contactLabel || PM.contactName).filter(Boolean).join(", ");
  const isPdf = f => /\.pdf$/i.test(f.name || "") || /pdf/i.test(f.type || "");

  // ── Company letterhead (company admins can change it under Admin → Company Settings)
  const LETTERHEAD_ID = "set_letterhead";
  const LETTERHEAD_DEFAULT = { name: "Net Power Electric", address1: "1202 Avenue J", address2: "Brooklyn, New York 11230", phone: "(718) 837-8800" };
  async function letterhead() {
    try { await Store.load("setting"); } catch (e) { /* defaults */ }
    const s = Store.get(LETTERHEAD_ID);
    return { ...LETTERHEAD_DEFAULT, ...(s ? s.data : {}) };
  }

  // ── pdf-lib (loaded on first use)
  let libP = null;
  function pdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (!libP) libP = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "/pm/vendor/pdf-lib-1.17.1.min.js";
      s.onload = () => res(window.PDFLib);
      s.onerror = () => { libP = null; rej(new Error("Couldn't load the PDF tool — check your connection")); };
      document.head.appendChild(s);
    });
    return libP;
  }

  async function fileBytes(f) {
    const url = await PM.files.fileObjectUrl(f.url);
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }
  // Any image the browser can show → JPEG bytes (covers HEIC on iPhone Safari, WebP, GIF…)
  async function imageToJpeg(bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || "image/*" }));
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("unsupported image")); i.src = url; });
      const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
      return new Uint8Array(await blob.arrayBuffer());
    } finally { URL.revokeObjectURL(url); }
  }

  // ── Cover sheet drawing helpers (Letter, points)
  const W = 612, H = 792, M = 36;
  function makeWriter(L, doc, fonts) {
    const { rgb } = L;
    const ink = rgb(0.07, 0.07, 0.07), gray = rgb(0.45, 0.45, 0.45), line = rgb(0.85, 0.85, 0.85), link = rgb(0.1, 0.3, 0.8);
    const okChar = new Map();
    // The standard PDF fonts only cover Western characters; replace anything else so the PDF still builds
    const clean = (s, font) => String(s == null ? "" : s).replace(/\r/g, "").replace(/\t/g, "  ").split("").map(ch => {
      if (ch === "\n") return ch;
      const k = font.name + ch;
      if (!okChar.has(k)) { try { font.widthOfTextAtSize(ch, 10); okChar.set(k, true); } catch (e) { okChar.set(k, false); } }
      return okChar.get(k) ? ch : "?";
    }).join("");
    const wrap = (s, width, size, font) => {
      const out = [];
      for (const para of clean(s, font).split("\n")) {
        let cur = "";
        for (const word of para.split(/ +/)) {
          const t = cur ? cur + " " + word : word;
          if (font.widthOfTextAtSize(t, size) <= width) { cur = t; continue; }
          if (cur) out.push(cur);
          // a single word longer than the line: break it
          let w = word;
          while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
            let n = w.length; while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
            out.push(w.slice(0, n)); w = w.slice(n);
          }
          cur = w;
        }
        out.push(cur);
      }
      return out;
    };
    const st = { page: null, y: 0, pages: [] };
    const newPage = () => { st.page = doc.addPage([W, H]); st.pages.push(st.page); st.y = H - M; };
    const ensure = h => { if (st.y - h < M + 30) newPage(); };
    const text = (s, x, y, { size = 8, font = fonts.reg, color = ink } = {}) => st.page.drawText(clean(s, font), { x, y, size, font, color });
    const textRight = (s, xr, y, o = {}) => { const font = o.font || fonts.reg, size = o.size || 8; text(s, xr - font.widthOfTextAtSize(clean(s, font), size), y, o); };
    const hr = y => st.page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: line });
    // Label/value rows: cols = [[label, value], [label, value]?]; a single pair spans the full width
    const fieldRow = cols => {
      const size = 7.5, lh = 9.5;
      const layout = cols.length === 1
        ? [{ lx: M + 2, vx: M + 84, vw: W - M - (M + 84) }]
        : [{ lx: M + 2, vx: M + 84, vw: 190 }, { lx: 326, vx: 408, vw: W - M - 408 }];
      const cells = cols.map(([k, v], i) => ({ k: wrap(k, 78, size, fonts.bold), v: wrap(v || "", layout[i].vw, size, fonts.reg), ...layout[i] }));
      const h = Math.max(...cells.map(c => Math.max(c.k.length, c.v.length))) * lh + 10;
      ensure(h);
      cells.forEach(c => {
        c.k.forEach((t, j) => text(t, c.lx, st.y - 8 - j * lh, { size, font: fonts.bold }));
        c.v.forEach((t, j) => text(t, c.vx, st.y - 8 - j * lh, { size }));
      });
      st.y -= h;
    };
    const fields = list => {
      const pairs = list.filter(Boolean);
      for (let i = 0; i < pairs.length;) {
        if (pairs[i].full) { fieldRow([pairs[i].kv]); i++; continue; }
        const row = [pairs[i].kv];
        if (pairs[i + 1] && !pairs[i + 1].full) { row.push(pairs[i + 1].kv); i += 2; } else i++;
        if (row.length === 1) row.push(["", ""]);
        fieldRow(row);
      }
    };
    // Bordered box with paragraphs: [{ text, font?, size?, color?, gap? }]
    const box = (x, width, paras) => {
      const pad = 7;
      const lines = [];
      paras.forEach(p => {
        const size = p.size || 8, font = p.font || fonts.reg;
        if (p.gap) lines.push({ gap: p.gap });
        wrap(p.text, width - pad * 2, size, font).forEach(t => lines.push({ t, size, font, color: p.color }));
      });
      // draw in chunks so long questions continue on the next page
      let i = 0;
      while (i < lines.length) {
        ensure(40);
        const top = st.y; let y = top - pad;
        const start = i;
        while (i < lines.length) {
          const l = lines[i], h = l.gap ? l.gap : l.size + 3;
          if (y - h < M + 34 && i > start) break;
          if (!l.gap) text(l.t, x + pad, y - l.size, { size: l.size, font: l.font, color: l.color });
          y -= h; i++;
        }
        const bottom = y - pad + 2;
        st.page.drawRectangle({ x, y: bottom, width, height: top - bottom, borderColor: line, borderWidth: 0.8 });
        st.y = bottom - 8;
        if (i < lines.length) newPage();
      }
    };
    return { st, newPage, ensure, text, textRight, hr, wrap, fields, fieldRow, box, clean, colors: { ink, gray, line, link } };
  }

  async function coverHeader(L, doc, w, fonts, lh, logo, p, title) {
    w.newPage();
    const top = H - M;
    const lw = 150, lhgt = logo ? lw * logo.height / logo.width : 0;
    if (logo) w.st.page.drawImage(logo, { x: M, y: top - lhgt, width: lw, height: lhgt });
    const cx = M + lw + 8;
    w.text(lh.name, cx, top - 8, { size: 8, font: fonts.bold });
    [lh.address1, lh.address2, lh.phone ? "P: " + lh.phone : ""].filter(Boolean).forEach((t, i) => w.text(t, cx, top - 20 - i * 11, { size: 8 }));
    const d = p.data;
    w.textRight(`Project: ${[d.number, d.name].filter(Boolean).join(" ")}`, W - M, top - 8, { size: 8, font: fonts.bold });
    [d.address, [d.city, d.state].filter(Boolean).join(", ")].filter(Boolean).forEach((t, i) => w.textRight(t, W - M, top - 20 - i * 11, { size: 8 }));
    let y = top - Math.max(lhgt, 52) - 14;
    w.hr(y);
    const tsize = 13, tw = fonts.bold.widthOfTextAtSize(w.clean(title, fonts.bold), tsize);
    if (tw <= W - 2 * M) w.text(title, (W - tw) / 2, y - 19, { size: tsize, font: fonts.bold });
    else w.wrap(title, W - 2 * M, tsize, fonts.bold).slice(0, 2).forEach((t, i) => w.text(t, M, y - 19 - i * 16, { size: tsize, font: fonts.bold }));
    y -= tw <= W - 2 * M ? 26 : 42;
    w.hr(y);
    w.st.y = y - 6;
  }
  const section = (w, fonts, title) => { w.ensure(40); w.st.y -= 6; w.hr(w.st.y); w.st.y -= 18; w.text(title, M, w.st.y + 2, { size: 10, font: fonts.bold }); w.st.y -= 8; };
  const kv = (k, v, full) => ({ kv: [k, v == null ? "" : String(v)], full: !!full });

  function rfiCover(w, fonts, r) {
    const d = r.data;
    const drawings = (d.linkedDrawings || []).map(id => Store.get(id)).filter(Boolean).map(g => g.data.number).join(", ");
    w.fields([kv("Revision", d.revision || 0), kv("Status", d.status), kv("To", names(d.assignees)), kv("From", PM.contactLabel(d.managerId) || d.createdBy || ""),
      kv("Date Initiated", fmtDate(d.openedAt || d.createdAt)), kv("Due Date", fmtDate(d.due)), kv("Location", d.location), kv("Spec Section", d.specSection),
      kv("Drawing Number", d.drawing, true), kv("Linked Drawings", drawings, true), kv("Copies To", names(d.distribution), true),
      d.costImpact ? kv("Cost Impact", d.costImpact + (d.costAmount ? ` ($${d.costAmount})` : "")) : null,
      d.scheduleImpact ? kv("Schedule Impact", d.scheduleImpact + (d.scheduleDays ? ` (${d.scheduleDays} days)` : "")) : null]);
    section(w, fonts, "Activity");
    const by = PM.contactLabel(d.managerId) || d.createdBy || "";
    const at = d.openedAt || d.createdAt;
    w.text("Question", M + 2, w.st.y - 10, { size: 7.5, font: fonts.bold });
    const files = d.attachments || [];
    w.box(M + 84, W - M - (M + 84), [
      { text: `Question from ${by}${at ? " on " + PM.fmtDateTime(at) : ""}`, font: fonts.bold },
      { text: d.question || "", gap: 3 },
      ...(d.suggestion ? [{ text: "Suggested answer", font: fonts.bold, gap: 6 }, { text: d.suggestion }] : []),
      ...(files.length ? [{ text: "Attachments", font: fonts.bold, gap: 6 }, ...files.map(f => ({ text: f.name, color: w.colors.link }))] : [])
    ]);
    const resps = d.responses || [];
    resps.forEach(x => {
      w.text(x.official ? "Official Response" : "Response", M + 2, w.st.y - 10, { size: 7.5, font: fonts.bold });
      w.box(M + 84, W - M - (M + 84), [{ text: `Response from ${x.by}${x.at ? " on " + PM.fmtDateTime(x.at) : ""}${x.official ? " (official)" : ""}`, font: fonts.bold }, { text: x.text || "", gap: 3 }]);
    });
    if (!resps.some(x => x.official) && d.status !== "Closed") { w.ensure(16); w.text("Awaiting an Official Response", M + 90, w.st.y - 6, { size: 8, font: fonts.ital }); w.st.y -= 16; }
  }

  function submittalCover(w, fonts, s) {
    const d = s.data;
    const bic = PM.submittalBIC ? PM.submittalBIC(s) : [];
    const approvers = (d.workflow || []).map(x => PM.contactLabel(x.contactId)).filter(Boolean).join(", ");
    w.fields([kv("Revision", d.revision || 0), kv("Submittal Manager", PM.contactLabel(d.managerId)), kv("Status", d.status), kv("Date Created", fmtDate(d.createdAt)),
      kv("Issue Date", fmtDate(d.issueDate)), kv("Spec Section", d.specSection), kv("Responsible Contractor", PM.companyName(d.responsibleCompanyId)), kv("Received From", PM.contactLabel(d.receivedFromId)),
      kv("Received Date", fmtDate(d.received)), kv("Submit By", fmtDate(d.submitBy)), kv("Final Due Date", fmtDate(d.due)), kv("Lead Time", d.leadTime ? d.leadTime + " days" : ""),
      kv("Required On Site", fmtDate(d.requiredOnSite)), kv("Cost Code", d.costCode), kv("Location", d.location), kv("Type", d.subType),
      kv("Submittal Package", (PM.forms.packageName && PM.forms.packageName(d.packageId)) || d.package, true), kv("Approvers", approvers, true),
      kv("Ball in Court", (bic || []).map(id => PM.contactLabel(id)).filter(Boolean).join(", "), true), kv("Distribution", names(d.distribution), true),
      kv("Description", d.description, true)]);
    section(w, fonts, "Submittal Workflow");
    // Table
    const cols = [["Name", 110], ["Sent Date", 62], ["Due Date", 62], ["Returned Date", 66], ["Response", 90], ["Attachments", W - 2 * M - 390]];
    const size = 7.5, lh = 9.5;
    const row = (cells, bold, shade) => {
      const wrapped = cells.map((c, i) => w.wrap(c || "", cols[i][1] - 8, size, bold ? fonts.bold : fonts.reg));
      const h = Math.max(1, ...wrapped.map(x => x.length)) * lh + 8;
      w.ensure(h);
      const y0 = w.st.y;
      if (shade) w.st.page.drawRectangle({ x: M, y: y0 - h, width: W - 2 * M, height: h, color: PM._pdfShade });
      let x = M;
      wrapped.forEach((lines, i) => {
        lines.forEach((t, j) => w.text(t, x + 4, y0 - 4 - size - j * lh, { size, font: bold ? fonts.bold : fonts.reg, color: i === 5 && !bold ? w.colors.link : undefined }));
        x += cols[i][1];
      });
      w.st.page.drawLine({ start: { x: M, y: y0 - h }, end: { x: W - M, y: y0 - h }, thickness: 0.6, color: w.colors.line });
      w.st.y = y0 - h;
    };
    row(cols.map(c => c[0]), true, true);
    row(["General Information Attachments", "", "", "", "", (d.attachments || []).map(f => f.name).join("\n")]);
    (d.workflow || []).forEach(x => row([PM.contactLabel(x.contactId), fmtDate(d.issueDate), fmtDate(x.due), x.at ? fmtDate(x.at) : "", x.response || "Pending",
      x.comments ? "Comments: " + x.comments : ""]));
  }

  // Build one PDF for a list of records. Returns { blob, name, skipped: [file names not merged] }
  async function buildPDF(p, recs, kind) {
    const L = await pdfLib();
    const doc = await L.PDFDocument.create();
    const fonts = { reg: await doc.embedFont(L.StandardFonts.Helvetica), bold: await doc.embedFont(L.StandardFonts.HelveticaBold), ital: await doc.embedFont(L.StandardFonts.HelveticaOblique) };
    PM._pdfShade = L.rgb(0.95, 0.95, 0.95);
    const lh = await letterhead();
    let logo = null;
    try { logo = await doc.embedJpg(new Uint8Array(await (await fetch("/pm/img/netpower-logo.jpg")).arrayBuffer())); } catch (e) { /* text-only header */ }
    const skipped = [];
    const printed = new Date().toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    for (const r of recs) {
      const d = r.data;
      const w = makeWriter(L, doc, fonts);
      const title = kind === "submittal" ? `Submittal #${d.number}.${d.revision || 0} - ${d.title || ""}` : `RFI #${d.number}: ${d.subject || ""}`;
      await coverHeader(L, doc, w, fonts, lh, logo, p, title);
      if (kind === "submittal") submittalCover(w, fonts, r); else rfiCover(w, fonts, r);
      // Footer on the cover pages
      w.st.pages.forEach((pg, i) => {
        const f = { size: 7.5, font: fonts.reg, color: w.colors.ink };
        pg.drawText(w.clean(lh.name, fonts.reg), { x: M + 2, y: 22, ...f });
        const pt = `Page ${i + 1} of ${w.st.pages.length}`;
        pg.drawText(pt, { x: (W - fonts.reg.widthOfTextAtSize(pt, 7.5)) / 2, y: 22, ...f });
        const pr = w.clean("Printed On: " + printed, fonts.reg);
        pg.drawText(pr, { x: W - M - fonts.reg.widthOfTextAtSize(pr, 7.5), y: 22, ...f });
      });
      // The attachments themselves, merged in after the cover
      for (const f of d.attachments || []) {
        try {
          const bytes = await fileBytes(f);
          if (isPdf(f)) {
            const src = await L.PDFDocument.load(bytes, { ignoreEncryption: true });
            (await doc.copyPages(src, src.getPageIndices())).forEach(pg => doc.addPage(pg));
          } else if (PM.forms.isImage(f)) {
            let img;
            const head = bytes.slice(0, 4);
            if (head[0] === 0xff && head[1] === 0xd8) img = await doc.embedJpg(bytes);
            else if (head[0] === 0x89 && head[1] === 0x50) img = await doc.embedPng(bytes);
            else img = await doc.embedJpg(await imageToJpeg(bytes, f.type));
            const land = img.width > img.height;
            const [pw, ph] = land ? [H, W] : [W, H];
            const pg = doc.addPage([pw, ph]);
            const cap = 18, s = Math.min((pw - 2 * M) / img.width, (ph - 2 * M - cap) / img.height, 1.5);
            const iw = img.width * s, ih = img.height * s;
            pg.drawImage(img, { x: (pw - iw) / 2, y: (ph - cap - ih) / 2 + cap, width: iw, height: ih });
            const nm = makeWriter(L, doc, fonts).clean(`${title} — ${f.name}`, fonts.reg);
            pg.drawText(nm.length > 120 ? nm.slice(0, 117) + "..." : nm, { x: M, y: 20, size: 7.5, font: fonts.reg, color: L.rgb(0.4, 0.4, 0.4) });
          } else skipped.push(f.name);
        } catch (e) { console.warn("Not merged into PDF:", f.name, e.message); skipped.push(f.name); }
      }
    }
    const bytes = await doc.save();
    const one = recs.length === 1 ? recs[0].data : null;
    const base = one ? (kind === "submittal" ? `Submittal ${one.number}.${one.revision || 0} - ${one.title || ""}` : `RFI ${one.number} - ${one.subject || ""}`)
      : `${kind === "submittal" ? "Submittals" : "RFIs"} - ${p.data.name}`;
    const name = base.replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) + ".pdf";
    return { blob: new Blob([bytes], { type: "application/pdf" }), name, skipped };
  }

  function saveFile(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  const busy = new Set();
  async function downloadPDF(p, recs, kind) {
    const key = kind + recs.map(r => r.id).join();
    if (busy.has(key)) return;
    busy.add(key);
    toast("Building PDF…");
    try {
      const out = await buildPDF(p, recs, kind);
      saveFile(out.blob, out.name);
      toast(out.skipped.length ? `PDF downloaded. Not merged (not a PDF or photo, or unreadable): ${out.skipped.join(", ")}` : "PDF downloaded");
      return out;
    } catch (e) { toast("Couldn't build the PDF: " + e.message, true); }
    finally { busy.delete(key); }
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

  // ── Email with the PDF attached
  // Phones/tablets: the share sheet (Outlook, Mail, WhatsApp…) with the PDF file — the recipient is picked in that app.
  // Computers: an email draft file (.eml) with To/Subject/message and the PDF attached; opening it shows a new
  // message in Outlook (or the default mail app) ready to send.
  const b64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const utf8b64 = t => b64(new TextEncoder().encode(t));
  const lines76 = s => s.replace(/.{1,76}/g, "$&\r\n");
  const hdrWord = t => (/^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${utf8b64(t)}?=`);
  async function emlDraft({ to, subject, body, attachments }) {
    const boundary = "----=_NetPowerPM_" + Math.random().toString(36).slice(2);
    const parts = [
      `To: ${to.join(", ")}`, `Subject: ${hdrWord(subject)}`, "X-Unsent: 1", "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`, "", "This is a multi-part message in MIME format.", "",
      `--${boundary}`, 'Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64", "", lines76(utf8b64(body))
    ];
    for (const a of attachments) {
      const bytes = new Uint8Array(await a.blob.arrayBuffer());
      parts.push(`--${boundary}`, `Content-Type: ${a.type || a.blob.type || "application/octet-stream"}; name="${a.name}"`,
        `Content-Disposition: attachment; filename="${a.name}"`, "Content-Transfer-Encoding: base64", "", lines76(b64(bytes)));
    }
    parts.push(`--${boundary}--`, "");
    return new Blob([parts.join("\r\n")], { type: "message/rfc822" });
  }
  const touchDevice = () => window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const canShareFiles = () => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(["x"], "t.pdf", { type: "application/pdf" })] })); } catch (e) { return false; } };

  function emailModal(p, r, kind = r.type) {
    const d = r.data;
    const isRfi = kind === "rfi";
    const label = isRfi ? `RFI #${d.number}` : `Submittal #${d.number}.${d.revision || 0}`;
    const subjectLine = `${label}: ${isRfi ? d.subject : d.title} — ${p.data.name}`;
    const ids = isRfi ? [d.managerId, ...(d.assignees || []), ...(d.distribution || []), d.receivedFromId]
      : [d.managerId, ...(d.workflow || []).map(w => w.contactId), ...(d.distribution || []), d.receivedFromId];
    const people = [...new Set(ids.filter(Boolean))].map(id => Store.get(id)).filter(c => c && c.data.email);
    const preChecked = id => (isRfi ? (d.assignees || []).includes(id) : (PM.submittalBIC ? PM.submittalBIC(r) : []).includes(id));
    const canLink = isRfi && PM.can(p.id, "rfis", "standard");
    const share = touchDevice() && canShareFiles();
    PM.openModal({
      title: `Email ${label}`,
      saveLabel: "Create email",
      noRender: true,
      body: `
        <div class="field"><label>How to send</label><div class="radio-list">
          <label><input type="radio" name="emHow" value="eml" ${share ? "" : "checked"}> Outlook email with the PDF attached <span class="muted">(computer — downloads an email draft; open it, check it and press Send)</span></label>
          ${canShareFiles() ? `<label><input type="radio" name="emHow" value="share" ${share ? "checked" : ""}> Share the PDF from this phone/tablet <span class="muted">(pick Outlook or Mail, then add who it goes to)</span></label>` : ""}
          <label><input type="radio" name="emHow" value="mailto"> Plain email without the attachment <span class="muted">(text and link only)</span></label></div></div>
        <div class="field" id="emToWrap"><label>To</label><div class="checks">${people.map(c => `<label><input type="checkbox" name="emTo" value="${esc(c.data.email)}" ${preChecked(c.id) ? "checked" : ""}> ${esc(c.data.name)} <span class="muted">${esc(c.data.email)}</span></label>`).join("") || `<span class="muted">Nobody on this ${isRfi ? "RFI" : "submittal"} has an email address in the Directory.</span>`}</div></div>
        <div class="field"><label for="emMore">Other recipients</label><input id="emMore" placeholder="name@company.com, another@company.com"></div>
        <div class="field"><label for="emNote">Message (optional)</label><textarea id="emNote" placeholder="Please review and respond by the due date."></textarea></div>
        ${canLink ? `<label class="inline-check"><input type="checkbox" id="emLink"> Also include a view-only link (they can see photos and responses online)</label>` : ""}
        <p class="muted" style="font-size:13px" id="emHelp"></p>`,
      onOpen: root => {
        const help = () => {
          const how = ($("input[name=emHow]:checked", root) || {}).value;
          $("#emHelp", root).textContent = how === "eml" ? "The PDF (cover sheet + attachments) is attached. A file ending in .eml downloads — open it and it shows as a new email in Outlook. Very large PDFs may be over your email size limit; use the view-only link for those."
            : how === "share" ? "Your phone's share menu opens with the PDF. Choose Outlook (or Mail), then add who it goes to — the share menu can't fill in recipients."
            : "Opens a new email with the details written in. Nothing is attached.";
        };
        $$("input[name=emHow]", root).forEach(i => i.onchange = help);
        help();
      },
      onSave: async root => {
        const how = $("input[name=emHow]:checked", root).value;
        const to = [...$$("input[name=emTo]:checked", root).map(i => i.value), ...$("#emMore", root).value.split(/[,;\s]+/).filter(x => /@/.test(x))];
        let rec = r;
        if (canLink && ($("#emLink", root) || {}).checked) { try { rec = await ensureShare(r); } catch (e) { toast("Link not created: " + e.message, true); } }
        const url = isRfi ? shareUrl(rec) : "";
        const q = String((isRfi ? d.question : d.description) || "").trim();
        const body = [$("#emNote", root).value.trim(), "",
          `${label}: ${isRfi ? d.subject : d.title}`, `Project: ${p.data.name}${p.data.number ? " (" + p.data.number + ")" : ""}`, `Status: ${d.status}${d.due ? " · Due: " + fmtDate(d.due) : ""}`,
          d.location ? `Location: ${d.location}` : "", isRfi && d.drawing ? `Drawing: ${d.drawing}` : "", "", q ? (isRfi ? "Question:" : "Description:") : "", q.length > 1500 ? q.slice(0, 1500) + "…" : q,
          how === "mailto" && (d.attachments || []).length ? `\nAttachments: ${(d.attachments || []).map(f => f.name).join(", ")}` : "",
          how !== "mailto" ? `\nThe ${isRfi ? "RFI" : "submittal"} is attached as a PDF.` : "",
          url ? `\nView online (photos, responses): ${url}` : "", "", `— ${PM.meName()}, ${(await letterhead()).name}`].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
        if (rec !== r) setTimeout(() => PM.render(), 300);
        if (how === "mailto") {
          window.location.href = `mailto:${to.map(encodeURIComponent).join(",")}?subject=${encodeURIComponent(subjectLine)}&body=${encodeURIComponent(body)}`;
          return true;
        }
        const btn = $(".modal [data-save]"); if (btn) { btn.disabled = true; btn.textContent = "Building PDF…"; }
        let out;
        try { out = await buildPDF(p, [rec], kind); }
        catch (e) { toast("Couldn't build the PDF: " + e.message, true); if (btn) { btn.disabled = false; btn.textContent = "Create email"; } return false; }
        if (how === "share") {
          try {
            await navigator.share({ files: [new File([out.blob], out.name, { type: "application/pdf" })], title: subjectLine, text: body });
          } catch (e) {
            if (e.name !== "AbortError") { toast("Sharing didn't work here — the PDF was downloaded instead", true); saveFile(out.blob, out.name); }
          }
          return true;
        }
        const eml = await emlDraft({ to, subject: subjectLine, body, attachments: [{ blob: out.blob, name: out.name, type: "application/pdf" }] });
        saveFile(eml, out.name.replace(/\.pdf$/, ".eml"));
        if (out.blob.size > 20 * 1024 * 1024) toast(`The PDF is ${(out.blob.size / 1048576).toFixed(0)} MB — that may be too big for email. Consider the view-only link.`, true);
        else toast("Email draft downloaded — open it to see the email in Outlook with the PDF attached" + (out.skipped.length ? `. Not merged: ${out.skipped.join(", ")}` : ""));
        return true;
      }
    });
  }

  // ── Menus
  function menu(btn, items) {
    let m = $("#exportMenu");
    if (m) { m.remove(); if (m.dataset.for === btn.id) return new Promise(() => {}); }
    m = document.createElement("div");
    m.id = "exportMenu";
    m.dataset.for = btn.id;
    m.className = "user-menu export-menu";
    m.innerHTML = items.map(([key, label]) => `<a href="#" data-ex="${key}">${label}</a>`).join("");
    const r = btn.getBoundingClientRect();
    Object.assign(m.style, { top: r.bottom + window.scrollY + 4 + "px", left: Math.max(8, r.right + window.scrollX - 280) + "px", right: "auto" });
    document.body.appendChild(m);
    const close = ev => { if (!ev.target.closest("#exportMenu") && ev.target !== btn) { m.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
    return new Promise(resolve => { m.onclick = ev => { const a = ev.target.closest("[data-ex]"); if (!a) return; ev.preventDefault(); m.remove(); resolve(a.dataset.ex); }; });
  }
  PM.ACTIONS.rfiExport = async el => {
    const r = Store.get(el.dataset.id), p = Store.get(r.projectId);
    const items = [["pdf", "⬇ Download PDF (cover sheet + attachments)"], ["email", "✉ Email with PDF attached…"]];
    if (PM.can(p.id, "rfis", "standard") || shareUrl(r)) items.push(["share", "🔗 View-only link…"]);
    items.push(["print", "🖨 Print page"]);
    const pick = await menu(el, items);
    if (pick === "pdf") downloadPDF(p, [r], "rfi");
    if (pick === "email") emailModal(p, r, "rfi");
    if (pick === "share") shareModal(p, r);
    if (pick === "print") window.print();
  };
  PM.ACTIONS.subExport = async el => {
    const s = Store.get(el.dataset.id), p = Store.get(s.projectId);
    const pick = await menu(el, [["pdf", "⬇ Download PDF (cover sheet + attachments)"], ["email", "✉ Email with PDF attached…"], ["print", "🖨 Print page"]]);
    if (pick === "pdf") downloadPDF(p, [s], "submittal");
    if (pick === "email") emailModal(p, s, "submittal");
    if (pick === "print") window.print();
  };
  const shownRows = () => $$("#listBody tr[data-href]").map(tr => Store.get(tr.dataset.href.split("/").pop())).filter(Boolean);
  PM.ACTIONS.rfiExportList = async el => {
    const p = Store.get(el.dataset.project);
    const pick = await menu(el, [["pdf", "⬇ PDF of the RFIs shown"], ["csv", "⬇ Spreadsheet (CSV)"]]);
    if (pick === "csv") PM.ACTIONS.exportRFIs(el);
    if (pick === "pdf") {
      const rfis = shownRows();
      if (!rfis.length) { toast("No RFIs to export", true); return; }
      downloadPDF(p, rfis.sort((a, b) => a.data.number - b.data.number), "rfi");
    }
  };
  PM.ACTIONS.subExportList = async el => {
    const p = Store.get(el.dataset.project);
    const pick = await menu(el, [["pdf", "⬇ PDF of the submittals shown"], ["csv", "⬇ Spreadsheet (CSV)"]]);
    if (pick === "csv") PM.ACTIONS.exportSubmittals(el);
    if (pick === "pdf") {
      const subs = shownRows();
      if (!subs.length) { toast("No submittals to export", true); return; }
      downloadPDF(p, subs, "submittal");
    }
  };

  // ── Company letterhead settings page (company admins): #/admin/company
  const LH_FIELDS = [["name", "Company name"], ["address1", "Address line 1"], ["address2", "City, State ZIP"], ["phone", "Phone"]];
  async function letterheadPage() {
    const lh = await letterhead();
    setTimeout(() => {
      const f = $("#lhForm");
      if (!f) return;
      $("#lhPreview").onclick = async () => {
        const p = Store.all("project")[0];
        if (!p) { toast("Create a project first to preview", true); return; }
        const sample = { id: "rfi_preview", type: "rfi", projectId: p.id, data: { number: 1, subject: "Sample RFI", status: "Open", question: "This is how the cover sheet will look.", createdAt: new Date().toISOString(), attachments: [] } };
        try { const out = await buildPDF(p, [sample], "rfi"); window.open(URL.createObjectURL(out.blob), "_blank"); } catch (e) { toast(e.message, true); }
      };
      f.onsubmit = async e => {
        e.preventDefault();
        const data = Object.fromEntries(LH_FIELDS.map(([k]) => [k, $("#lh_" + k).value.trim()]));
        if (!data.name) { toast("Enter the company name", true); return; }
        const cur = Store.get(LETTERHEAD_ID);
        try { await Store.save({ id: LETTERHEAD_ID, type: "setting", projectId: "", data: { ...(cur ? cur.data : {}), ...data, updatedBy: PM.meName(), updatedAt: new Date().toISOString() } }); toast("Letterhead saved"); }
        catch (err) { toast(err.message, true); }
      };
    }, 0);
    return `<div class="page-head"><h1>Company Letterhead</h1></div>
      <div class="panel" style="max-width:620px"><p class="muted" style="margin-top:0">Printed at the top of every RFI and submittal PDF, next to the NetPower logo.</p>
        <form id="lhForm">${LH_FIELDS.map(([k, l]) => `<div class="field"><label for="lh_${k}">${l}</label><input id="lh_${k}" value="${esc(lh[k] || "")}"></div>`).join("")}
          <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="lhPreview">Preview a cover sheet</button></div></form></div>`;
  }

  // Kept for older callers: the printable HTML version is replaced by the real PDF
  const printPDF = (p, rfis) => downloadPDF(p, rfis, "rfi");
  PM.exporter = { buildPDF, downloadPDF, printPDF, emailModal, shareModal, ensureShare, shareUrl, emlDraft, letterhead, letterheadPage, saveFile };
})();

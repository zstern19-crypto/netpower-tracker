/* NetPower PM — Drawings tool (Procore-style).
 * Upload PDF drawing sets → review auto-detected sheet numbers/titles → drawing log
 * with revisions → zoomable viewer with markups and pins linked to RFIs / punch items.
 *
 * Files: Vercel Blob (via /api/blob client uploads). In local demo mode, PDFs are
 * kept in this browser's IndexedDB instead.
 * Records: "drawset" (one per uploaded file), "drawing" (one per sheet number, with
 * revisions), "markup" (one per person per sheet revision; shapes in PDF point units). */
(function () {
  "use strict";
  const PM = window.NetPowerPM;
  const { $, $$, esc, uid, toast, Store } = PM;

  // ───────────────────────── Vendor loading ─────────────────────────
  const loadedScripts = {};
  function loadScript(src) {
    return loadedScripts[src] || (loadedScripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete loadedScripts[src]; reject(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    }));
  }
  async function pdfjs() {
    await loadScript("/pm/vendor/pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/pm/vendor/pdf.worker.min.js";
    return window.pdfjsLib;
  }

  // ───────────────────────── File storage ─────────────────────────
  const IDB = {
    db: null,
    open() {
      return this.db || (this.db = new Promise((resolve, reject) => {
        const r = indexedDB.open("netpower_pm_files", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("files");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }));
    },
    async put(key, blob) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put(blob, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
    async del(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const req = db.transaction("files").objectStore("files").get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
  };

  let blobMode = null;  // "presigned" | "token", from GET /api/blob
  async function storeFile(projectId, file, onProgress) {
    return uploadFile(`drawings/${projectId}`, file, onProgress, "application/pdf");
  }

  // Upload any file into a folder of the store (drawings/<project> or attachments/<project>/<tool>)
  async function uploadFile(folder, file, onProgress, contentType) {
    const safe = (file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120)) || "file";
    if (Store.mode === "local") {
      const key = uid("file");
      await IDB.put(key, file);
      if (onProgress) onProgress(100);
      return "idb:" + key;
    }
    if (!blobMode) {
      const info = await fetch("/api/blob").then(r => r.json()).catch(() => ({}));
      if (info.code === "NOT_CONFIGURED") throw new Error("File storage isn't set up yet: connect a Vercel Blob store to this project (see README).");
      if (!info.ok) throw new Error("File storage check failed: " + (info.error || "unknown error"));
      blobMode = info.mode;
    }
    await loadScript("/pm/vendor/vercel-blob-client-2.8.0.js");
    const fn = blobMode === "presigned" ? window.VercelBlob.uploadPresigned : window.VercelBlob.upload;
    // Unique pathname per upload (presigned uploads don't add a random suffix)
    const res = await fn(`${folder}/${uid("f")}-${safe}`, file, {
      access: "public",
      handleUploadUrl: "/api/blob",
      contentType: contentType || file.type || "application/octet-stream",
      multipart: file.size > 20 * 1024 * 1024,
      onUploadProgress: e => { if (onProgress) onProgress(e.percentage); }
    });
    return res.url;
  }

  // Files in a private Blob store can only be read through short-lived signed links
  const signedCache = new Map();  // fileUrl → { url, exp }
  async function readableUrl(fileUrl) {
    if (!/\.private\.blob\.vercel-storage\.com\//.test(fileUrl)) return fileUrl;
    const c = signedCache.get(fileUrl);
    if (c && c.exp > Date.now() + 5 * 60 * 1000) return c.url;
    const d = await fetch("/api/blob?sign=" + encodeURIComponent(fileUrl)).then(r => r.json()).catch(() => ({}));
    if (!d.ok) throw new Error("Could not get access to this file: " + (d.error || "unknown error"));
    signedCache.set(fileUrl, { url: d.url, exp: d.expiresAt || Date.now() + 55 * 60 * 1000 });
    return d.url;
  }

  async function fileObjectUrl(fileUrl) {
    if (!fileUrl.startsWith("idb:")) return readableUrl(fileUrl);
    const blob = await IDB.get(fileUrl.slice(4));
    if (!blob) throw new Error("This file was uploaded in another browser (local demo mode) and isn't available here.");
    return URL.createObjectURL(blob);
  }

  // ───────────────────────── PDF helpers ─────────────────────────
  const docCache = new Map();
  const docOpenedAt = new Map();
  function openPdf(fileUrl) {
    // Signed links expire after an hour; reopen documents before that so page loads keep working
    if (docCache.has(fileUrl) && Date.now() - (docOpenedAt.get(fileUrl) || 0) > 45 * 60 * 1000) {
      docCache.get(fileUrl).then(d => d.destroy()).catch(() => {});
      docCache.delete(fileUrl);
    }
    if (docCache.has(fileUrl)) return docCache.get(fileUrl);
    docOpenedAt.set(fileUrl, Date.now());
    const p = (async () => {
      const lib = await pdfjs();
      if (fileUrl.startsWith("idb:")) {
        const blob = await IDB.get(fileUrl.slice(4));
        if (!blob) throw new Error("This drawing was uploaded in another browser (local demo mode) and isn't available here.");
        return lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
      }
      // Range requests: only the bytes needed for the viewed page are downloaded
      const url = await readableUrl(fileUrl);
      return lib.getDocument({ url, rangeChunkSize: 262144, disableAutoFetch: true, disableStream: true }).promise;
    })();
    docCache.set(fileUrl, p);
    p.catch(() => docCache.delete(fileUrl));
    while (docCache.size > 4) {
      const oldest = docCache.keys().next().value;
      const old = docCache.get(oldest);
      docCache.delete(oldest);
      old.then(d => d.destroy()).catch(() => {});
    }
    return p;
  }

  async function renderThumb(page, width) {
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / vp1.width });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c.toDataURL("image/jpeg", 0.7);
  }

  // ───────────────────────── Sheet detection ─────────────────────────
  const SHEET_RE = /^[A-Z]{1,3}[-.]?\d{1,3}(?:[.-]\d{1,3})?[A-Z]?$/;
  // Labels that look like sheet numbers but aren't (note: single letters like "A"/"E" are real disciplines)
  const NOT_SHEET = /^(NO|REV|RM|UL|CH|PH|FL|LVL|TYP|QTY|SEC|DET|NTS|MIN|MAX|AWG|KVA|KW|HP)[-.]?\d/;
  const TITLE_STOP = /^(SHEET|SHEET NO|SHEET NUMBER|SHEET TITLE|TITLE|DRAWING|DRAWING NO|DRAWING TITLE|PROJECT|PROJECT NO|SCALE|DATE|DRAWN|DRAWN BY|CHECKED|CHECKED BY|APPROVED|REVISION|REVISIONS|JOB|JOB NO|SEAL|CLIENT|OWNER|ISSUE|ISSUED|ISSUED FOR|KEY PLAN|NORTH|AS NOTED|NOT FOR CONSTRUCTION)\b:?$/;
  // Addresses in the title block ("BROOKLYN, NY 11201", "120 River Rd") are not sheet titles
  const ADDRESS_RE = /,\s*[A-Z]{2}\b(\s*\d{5})?|\b\d{5}(-\d{4})?\s*$|^\d+\s+\w+.*\b(ST|STREET|AVE|AVENUE|RD|ROAD|BLVD|DR|DRIVE|LN|LANE|PL|PLACE|WAY|CT|COURT)\.?\b/i;
  const DISCIPLINE_PREFIXES = [
    ["FA", "Fire Alarm"], ["FP", "Fire Protection"], ["LV", "Low Voltage"], ["TC", "Telecom"],
    ["G", "General"], ["C", "Civil"], ["L", "Landscape"], ["S", "Structural"], ["A", "Architectural"],
    ["I", "Interiors"], ["Q", "Equipment"], ["F", "Fire Protection"], ["P", "Plumbing"], ["M", "Mechanical"],
    ["E", "Electrical"], ["T", "Telecom"], ["D", "Demolition"]
  ];
  const DISCIPLINES = [...new Set(DISCIPLINE_PREFIXES.map(d => d[1]))].concat(["Other"]);

  function disciplineFor(num) {
    const m = /^[A-Z]+/.exec(String(num || "").toUpperCase());
    if (!m) return "Other";
    const exact = DISCIPLINE_PREFIXES.find(([k]) => k === m[0]);
    if (exact) return exact[1];
    const starts = DISCIPLINE_PREFIXES.find(([k]) => m[0].startsWith(k));
    return starts ? starts[1] : "Other";
  }

  // Heuristic: sheet numbers/titles usually sit in the title block (bottom-right).
  // Works on PDFs with real text; scanned sheets fall back to the file name. Always reviewed by the user.
  async function detectSheet(page, fileName) {
    const vp = page.getViewport({ scale: 1 });
    let items = [];
    try {
      const tc = await page.getTextContent();
      items = tc.items.filter(i => i.str && i.str.trim()).map(i => {
        const [x, y] = vp.convertToViewportPoint(i.transform[4], i.transform[5]);
        return { s: i.str.trim().replace(/\s+/g, " "), x: x / vp.width, y: y / vp.height, size: Math.hypot(i.transform[2], i.transform[3]) };
      });
    } catch (e) { /* no text layer */ }
    const inTitleBlock = it => it.x > 0.6 && it.y > 0.6;

    let best = null;
    for (const it of items) {
      const s = it.s.toUpperCase().replace(/\s+/g, "");
      if (!SHEET_RE.test(s) || NOT_SHEET.test(s)) continue;
      const score = it.size + (inTitleBlock(it) ? 40 : 0) + (it.x > 0.8 && it.y > 0.85 ? 25 : 0);
      if (!best || score > best.score) best = { s, score, it };
    }
    let number = best ? best.s : "";
    if (!number) {
      const m = fileName.replace(/\.pdf$/i, "").toUpperCase().match(/(?:^|[^A-Z0-9])([A-Z]{1,3}[-.]?\d{1,3}(?:[.-]\d{1,3})?[A-Z]?)(?=$|[^A-Z0-9])/);
      if (m && !NOT_SHEET.test(m[1])) number = m[1];
    }

    let title = "";
    const cands = items.filter(it => inTitleBlock(it) && /[A-Za-z]{3}/.test(it.s) && it.s.length >= 4 && it.s.length <= 70 &&
      !TITLE_STOP.test(it.s.toUpperCase()) && !(best && it === best.it) && !/\d{1,2}\/\d{1,2}\/\d{2,4}|@|www\.|\.com|^\d/.test(it.s) &&
      !ADDRESS_RE.test(it.s));
    if (cands.length) {
      const top = cands.reduce((a, b) => (b.size > a.size ? b : a));
      const line = cands.filter(c => Math.abs(c.size - top.size) / top.size < 0.12 && Math.abs(c.y - top.y) < 0.04 && Math.abs(c.x - top.x) < 0.3)
        .sort((a, b) => a.y - b.y || a.x - b.x);
      title = line.map(c => c.s).join(" ").slice(0, 80);
    }
    return { number, title, discipline: disciplineFor(number), width: vp.width, height: vp.height };
  }

  const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  const sheetsOf = p => Store.all("drawing", p.id).sort((a, b) => natCmp(a.data.number, b.data.number));
  const findByNumber = (p, num) => Store.all("drawing", p.id).find(g => g.data.number.toUpperCase() === String(num).toUpperCase());
  const currentRev = g => (g.data.revisions || []).find(r => r.id === g.data.current) || (g.data.revisions || [])[0];
  const nextRevLabel = (g, def) => { const r = currentRev(g); return r && /^\d+$/.test(r.rev) ? String(Number(r.rev) + 1) : def; };

  // ───────────────────────── Upload flow ─────────────────────────
  function uploadModal(p) {
    let files = [];        // [{file, pages:[{page, number, title, discipline, thumb, width, height}]}]
    let processing = false;
    openModal();

    function openModal() {
      let chosen = [];   // PDFs picked in step 1
      let stage = "choose";
      const setNames = [...new Set(Store.all("drawset", p.id).map(s => s.data.name))].sort();
      PM.openModal({
        title: "Upload Drawings",
        wide: true,
        noRender: true,
        saveLabel: "Process",
        body: `
          <div id="dsChoose">
            <div class="dropzone" id="dsDrop" tabindex="0" role="button" aria-label="Attach PDF files">
              <span class="btn">Attach Files</span><div class="muted">or Drag &amp; Drop</div>
              <input id="dsFiles" type="file" accept="application/pdf,.pdf" multiple hidden>
            </div>
            <ul class="attach-list" id="dsChosen"></ul>
            <div class="field" style="margin-top:16px"><label for="dsName" class="big-label">Drawing Set <span class="req">*</span></label>
              <div class="muted help">Group and label drawings into a collection as they are issued to keep them organized.</div>
              <input id="dsName" list="dsSets" placeholder="Select or Create set" autocomplete="off">
              <datalist id="dsSets">${setNames.map(n => `<option value="${esc(n)}">`).join("")}</datalist></div>
            <div class="form-grid" style="margin-top:14px">
              <div class="field"><label for="dsDate" class="big-label">Default Drawing Date</label><div class="muted help">Enter the date the drawing was authored.</div><input id="dsDate" type="date"></div>
              <div class="field"><label for="dsRecv" class="big-label">Default Received Date</label><div class="muted help">Enter the date the drawings were received from the design team.</div><input id="dsRecv" type="date"></div>
            </div>
            <details class="adv" style="margin-top:14px"><summary class="big-label">Advanced Options</summary>
              <div class="form-grid" style="margin-top:10px">
                <div class="field"><label for="dsRev">Default Revision</label><input id="dsRev" value="0"><div class="muted help">Used for new sheets. Sheets that already exist get their next revision number.</div></div>
              </div></details>
            <div class="ds-req"><span class="req-note">* Required fields</span><div id="dsNeedFile" class="field-err">You must attach a file</div></div>
          </div>
          <div id="dsStatus" class="muted" style="margin:12px 0"></div>
          <div id="dsReview"></div>`,
        onOpen: root => {
          const drop = $("#dsDrop", root), input = $("#dsFiles", root), saveBtn = $("[data-save]", root);
          const sync = () => {
            $("#dsChosen", root).innerHTML = chosen.map((f, i) => `<li>📄 ${esc(f.name)} <span class="muted">${(f.size / 1048576).toFixed(1)} MB</span> <button type="button" class="btn small" data-unpick="${i}" aria-label="Remove ${esc(f.name)}">✕</button></li>`).join("");
            $("#dsNeedFile", root).hidden = chosen.length > 0;
            saveBtn.disabled = stage === "choose" && (!chosen.length || !$("#dsName", root).value.trim());
          };
          const pick = list => {
            const pdfs = [...list].filter(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
            if (pdfs.length < list.length) toast("Only PDF files can be uploaded as drawings", true);
            chosen = chosen.concat(pdfs);
            sync();
          };
          drop.onclick = () => input.click();
          drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
          input.onchange = () => { pick(input.files); input.value = ""; };
          drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
          drop.ondragleave = () => drop.classList.remove("over");
          drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); pick(e.dataTransfer.files); };
          $("#dsChosen", root).onclick = e => { const b = e.target.closest("[data-unpick]"); if (b) { chosen.splice(Number(b.dataset.unpick), 1); sync(); } };
          $("#dsName", root).oninput = sync;
          root.addEventListener("input", e => { if (e.target.matches("[data-row] [data-f=number]")) refreshRowStatus(root); });
          // Step 2 → back to step 1
          const back = document.createElement("button");
          back.className = "btn"; back.textContent = "Back"; back.hidden = true; back.id = "dsBack";
          back.onclick = () => { stage = "choose"; $("#dsChoose", root).hidden = false; $("#dsReview", root).innerHTML = ""; $("#dsStatus", root).textContent = ""; back.hidden = true; saveBtn.textContent = "Process"; sync(); };
          $(".modal-foot", root).insertBefore(back, saveBtn);
          root._next = async () => {
            if (stage === "choose") {
              if (!chosen.length || !$("#dsName", root).value.trim()) { sync(); return false; }
              saveBtn.disabled = true;
              await processFiles(root, chosen);
              saveBtn.disabled = false;
              if (files.length) { stage = "review"; $("#dsChoose", root).hidden = true; back.hidden = false; saveBtn.textContent = "Upload"; }
              return false;
            }
            return save(root);
          };
          sync();
        },
        onSave: root => root._next()
      });
    }

    async function processFiles(root, list) {
      const pdfs = list.filter(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
      if (!pdfs.length) { toast("Choose PDF files", true); return; }
      processing = true;
      files = [];
      const status = $("#dsStatus", root);
      $("#dsReview", root).innerHTML = "";
      try {
        const lib = await pdfjs();
        for (const [fi, file] of pdfs.entries()) {
          const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
          const entry = { file, pages: [] };
          for (let n = 1; n <= doc.numPages; n++) {
            status.textContent = `Reading ${file.name} — page ${n} of ${doc.numPages}${pdfs.length > 1 ? ` (file ${fi + 1} of ${pdfs.length})` : ""}…`;
            const page = await doc.getPage(n);
            const info = await detectSheet(page, doc.numPages === 1 ? file.name : "");
            info.thumb = await renderThumb(page, 220);
            entry.pages.push({ page: n, ...info });
            page.cleanup();
          }
          await doc.destroy();
          files.push(entry);
        }
        const total = files.reduce((s, f) => s + f.pages.length, 0);
        status.innerHTML = `<strong>${total} sheet${total === 1 ? "" : "s"} found.</strong> Review the sheet numbers and titles, then click Upload.`;
        renderReview(root);
      } catch (e) {
        status.textContent = "Could not read PDF: " + e.message;
      } finally {
        processing = false;
      }
    }

    function renderReview(root) {
      const defRev = $("#dsRev", root).value.trim() || "0";
      const rows = [];
      files.forEach((f, fi) => f.pages.forEach((pg, pi) => {
        const existing = pg.number && findByNumber(p, pg.number);
        rows.push(`<tr data-row data-fi="${fi}" data-pi="${pi}">
          <td><input type="checkbox" data-f="include" checked aria-label="Include sheet"></td>
          <td><img class="ds-thumb" src="${pg.thumb}" alt=""></td>
          <td class="muted" style="font-size:12px">${esc(f.file.name)}<br>p. ${pg.page}</td>
          <td><input data-f="number" value="${esc(pg.number)}" placeholder="E-101" style="width:100px"></td>
          <td><input data-f="title" value="${esc(pg.title)}" placeholder="Sheet title"></td>
          <td><select data-f="discipline">${DISCIPLINES.map(d => `<option ${d === pg.discipline ? "selected" : ""}>${d}</option>`).join("")}</select></td>
          <td><input data-f="rev" value="${esc(existing ? nextRevLabel(existing, defRev) : defRev)}" style="width:56px"></td>
          <td data-f="status" style="font-size:12px"></td></tr>`);
      }));
      $("#dsReview", root).innerHTML = `<div class="table-wrap"><table class="list ds-review"><thead><tr><th></th><th>Preview</th><th>Source</th><th>Sheet #</th><th>Title</th><th>Discipline</th><th>Rev</th><th>Status</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
      refreshRowStatus(root);
    }

    function refreshRowStatus(root) {
      const rows = $$("[data-row]", root);
      const counts = {};
      rows.forEach(tr => { const n = $("[data-f=number]", tr).value.trim().toUpperCase(); if (n) counts[n] = (counts[n] || 0) + 1; });
      rows.forEach(tr => {
        const num = $("[data-f=number]", tr).value.trim();
        const cell = $("[data-f=status]", tr);
        const existing = num && findByNumber(p, num);
        if (!num) cell.innerHTML = `<span class="overdue">Sheet # required</span>`;
        else if (counts[num.toUpperCase()] > 1) cell.innerHTML = `<span class="overdue">Duplicate in this upload</span>`;
        else if (existing) cell.innerHTML = `New revision of ${esc(existing.data.number)} <span class="muted">(current Rev ${esc((currentRev(existing) || {}).rev || "?")})</span>`;
        else cell.innerHTML = `<span class="pill open">New sheet</span>`;
        const disc = $("[data-f=discipline]", tr);
        if (!disc.dataset.touched && num) disc.value = disciplineFor(num);
      });
      $$("[data-f=discipline]", root).forEach(s => { s.onchange = () => { s.dataset.touched = "1"; }; });
    }

    async function save(root) {
      if (processing) { toast("Still reading the PDF — one moment", true); return false; }
      const setName = $("#dsName", root).value.trim();
      if (!setName) throw new Error("Drawing set name is required");
      if (!files.length) throw new Error("Choose at least one PDF");
      const drawingDate = $("#dsDate", root).value;
      const receivedDate = $("#dsRecv", root).value;
      const rows = $$("[data-row]", root).map(tr => {
        const pg = files[Number(tr.dataset.fi)].pages[Number(tr.dataset.pi)];
        return {
          fi: Number(tr.dataset.fi), pg,
          include: $("[data-f=include]", tr).checked,
          number: $("[data-f=number]", tr).value.trim().toUpperCase(),
          title: $("[data-f=title]", tr).value.trim(),
          discipline: $("[data-f=discipline]", tr).value,
          rev: $("[data-f=rev]", tr).value.trim() || "0"
        };
      }).filter(r => r.include);
      if (!rows.length) throw new Error("No sheets selected");
      const missing = rows.filter(r => !r.number);
      if (missing.length) throw new Error(`${missing.length} sheet(s) need a sheet number`);
      const seen = new Set();
      for (const r of rows) { if (seen.has(r.number)) throw new Error("Duplicate sheet number in this upload: " + r.number); seen.add(r.number); }

      const status = $("#dsStatus", root);
      const now = new Date().toISOString();
      const records = [];
      const touched = {};
      for (const fi of [...new Set(rows.map(r => r.fi))]) {
        const f = files[fi];
        status.textContent = `Uploading ${f.file.name}…`;
        const fileUrl = await storeFile(p.id, f.file, pct => { status.textContent = `Uploading ${f.file.name}… ${Math.round(pct)}%`; });
        const set = { id: uid("dset"), type: "drawset", projectId: p.id, data: { name: setName, drawingDate, receivedDate, fileName: f.file.name, fileUrl, size: f.file.size, pages: f.pages.length, sheets: rows.filter(r => r.fi === fi).length, uploadedBy: PM.meName(), at: now } };
        records.push(set);
        for (const r of rows.filter(x => x.fi === fi)) {
          const rev = { id: uid("rv"), rev: r.rev, setId: set.id, setName, fileUrl, page: r.pg.page, width: r.pg.width, height: r.pg.height, drawingDate, receivedDate, uploadedBy: PM.meName(), at: now };
          const existing = touched[r.number] || findByNumber(p, r.number);
          if (existing) {
            const g = { ...existing, data: { ...existing.data, revisions: [...(existing.data.revisions || []), rev] } };
            const cur = currentRev(existing);
            const curDate = cur ? (cur.drawingDate || (cur.at || "").slice(0, 10)) : "";
            if (!cur || (drawingDate || now.slice(0, 10)) >= curDate) {
              g.data.current = rev.id;
              g.data.thumb = r.pg.thumb;
              if (r.title) g.data.title = r.title;
              g.data.discipline = r.discipline;
            }
            PM.withHistory(g, `Rev ${r.rev} uploaded (${setName})${g.data.current === rev.id ? "" : " — older than current, not made current"}`);
            touched[r.number] = g;
          } else {
            const g = { id: uid("dwg"), type: "drawing", projectId: p.id, data: { number: r.number, title: r.title, discipline: r.discipline, current: rev.id, thumb: r.pg.thumb, revisions: [rev], createdAt: now, createdBy: PM.meName() } };
            PM.withHistory(g, `Uploaded as Rev ${r.rev} (${setName})`);
            touched[r.number] = g;
          }
        }
      }
      records.push(...Object.values(touched));
      status.textContent = "Saving drawing log…";
      await Store.saveMany(records, (n, total) => { status.textContent = `Saving drawing log… ${n}/${total}`; });
      toast(`${rows.length} sheet${rows.length === 1 ? "" : "s"} uploaded`);
      setTimeout(PM.render, 0);
      return true;
    }
  }

  // ───────────────────────── Deleting ─────────────────────────
  async function deleteFiles(urls) {
    for (const u of urls) {
      try {
        if (u.startsWith("idb:")) await IDB.del(u.slice(4));
        else await fetch("/api/blob?url=" + encodeURIComponent(u), { method: "DELETE" });
      } catch (e) { /* the record is gone either way; a leftover file is harmless */ }
    }
  }

  // After sheets/revisions are removed: delete drawing sets and files nothing refers to any more
  async function cleanupOrphans(p, fileUrls, setIds) {
    const revs = Store.all("drawing", p.id).flatMap(g => g.data.revisions || []);
    const usedFiles = new Set(revs.map(r => r.fileUrl));
    const usedSets = new Set(revs.map(r => r.setId));
    for (const id of setIds) if (!usedSets.has(id) && Store.get(id)) await Store.remove(id);
    await deleteFiles([...new Set(fileUrls)].filter(u => u && !usedFiles.has(u)));
  }

  async function removeMarkups(p, match) {
    for (const m of Store.all("markup", p.id).filter(match)) await Store.remove(m.id);
  }

  async function deleteSheets(p, ids) {
    const sheets = ids.map(id => Store.get(id)).filter(Boolean);
    const revs = sheets.flatMap(g => g.data.revisions || []);
    await removeMarkups(p, m => ids.includes(m.data.drawingId));
    for (const g of sheets) await Store.remove(g.id);
    await cleanupOrphans(p, revs.map(r => r.fileUrl), revs.map(r => r.setId));
  }

  async function deleteSet(p, setId) {
    const set = Store.get(setId);
    const files = set ? [set.data.fileUrl] : [];
    const updates = [];
    for (const g of Store.all("drawing", p.id)) {
      const removed = (g.data.revisions || []).filter(r => r.setId === setId);
      if (!removed.length) continue;
      files.push(...removed.map(r => r.fileUrl));
      const removedIds = removed.map(r => r.id);
      await removeMarkups(p, m => m.data.drawingId === g.id && removedIds.includes(m.data.revId));
      const remaining = (g.data.revisions || []).filter(r => r.setId !== setId);
      if (!remaining.length) { await Store.remove(g.id); continue; }
      const next = { ...g, data: { ...g.data, revisions: remaining } };
      if (!remaining.some(r => r.id === g.data.current)) {
        const latest = remaining.slice().sort((a, b) => ((a.drawingDate || a.at || "") < (b.drawingDate || b.at || "") ? 1 : -1))[0];
        next.data.current = latest.id;
        next.data.thumb = "";
      }
      PM.withHistory(next, `Revision(s) from set "${set ? set.data.name : "?"}" deleted`);
      updates.push(next);
    }
    if (updates.length) await Store.saveMany(updates);
    if (set) await Store.remove(setId);
    await cleanupOrphans(p, files, [setId]);
  }

  // ───────────────────────── Drawing log ─────────────────────────
  const logFilter = { q: "", discipline: "" };

  function logRows(p) {
    const q = logFilter.q.toLowerCase();
    const list = sheetsOf(p).filter(g => (!logFilter.discipline || g.data.discipline === logFilter.discipline) &&
      (!q || [g.data.number, g.data.title, g.data.discipline].join(" ").toLowerCase().includes(q)));
    const pins = pinIndex(p);
    const view = PM.lsGet("netpower_pm_dwg_view", "list");
    if (!list.length) return `<div class="empty">${Store.all("drawing", p.id).length ? "No drawings match." : "No drawings yet. Upload a PDF drawing set to get started."}</div>`;
    if (view === "grid") {
      return `<div class="dwg-grid">${list.map(g => {
        const r = currentRev(g) || {};
        return `<a class="dwg-card" href="#/p/${p.id}/drawings/${g.id}">${g.data.thumb ? `<img src="${g.data.thumb}" alt="">` : `<div class="noimg">No preview</div>`}
          <div class="dwg-card-t"><strong>${esc(g.data.number)}</strong> <span class="muted">Rev ${esc(r.rev || "")}</span><div>${esc(g.data.title || "")}</div></div></a>`;
      }).join("")}</div>`;
    }
    let lastDisc = null;
    return `<div class="table-wrap"><table class="list"><thead><tr><th></th><th>Sheet #</th><th>Title</th><th>Rev</th><th>Drawing Date</th><th>Set</th><th>Revs</th><th>Links</th><th></th></tr></thead><tbody>
      ${list.map(g => {
        const r = currentRev(g) || {};
        const head = !logFilter.discipline && g.data.discipline !== lastDisc ? `<tr class="grp-row"><td colspan="9">${esc(g.data.discipline || "Other")}</td></tr>` : "";
        lastDisc = g.data.discipline;
        return head + `<tr class="click" data-href="#/p/${p.id}/drawings/${g.id}">
          <td style="width:70px">${g.data.thumb ? `<img class="ds-thumb sm" src="${g.data.thumb}" alt="">` : ""}</td>
          <td class="nowrap"><a href="#/p/${p.id}/drawings/${g.id}"><strong>${esc(g.data.number)}</strong></a></td>
          <td>${esc(g.data.title || "")}</td><td>${esc(r.rev || "")}</td>
          <td class="nowrap">${PM.fmtDate(r.drawingDate) || ""}</td><td>${esc(r.setName || "")}</td>
          <td>${(g.data.revisions || []).length}</td><td>${pins[g.id] || ""}</td>
          <td><button class="btn small danger" data-perm="drawings:admin" data-delsheet="${g.id}" title="Delete sheet ${esc(g.data.number)}" aria-label="Delete sheet ${esc(g.data.number)}">🗑</button></td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  function pinIndex(p) {
    const out = {};
    Store.all("markup", p.id).forEach(m => {
      const g = Store.get(m.data.drawingId);
      if (!g || m.data.revId !== g.data.current) return;
      const n = (m.data.shapes || []).filter(s => s.t === "pin").length;
      if (n) out[g.id] = (out[g.id] || 0) + n;
    });
    return out;
  }

  function log(p) {
    const all = Store.all("drawing", p.id);
    const discs = [...new Set(all.map(g => g.data.discipline || "Other"))].sort();
    const sets = Store.all("drawset", p.id).sort((a, b) => (b.data.at || "").localeCompare(a.data.at || ""));
    const view = PM.lsGet("netpower_pm_dwg_view", "list");
    setTimeout(() => wireLog(p), 0);
    return `
      <div class="page-head"><h1>Drawings</h1><span class="sub">${all.length} sheet${all.length === 1 ? "" : "s"}</span>
        <div class="actions"><button class="btn primary" id="dwgUpload" data-perm="drawings:standard">+ Upload Drawings</button></div></div>
      <div class="panel flush">
        <div class="toolbar">
          <input type="search" id="dwgSearch" placeholder="Search sheet # or title…" value="${esc(logFilter.q)}">
          <select id="dwgDisc"><option value="">All disciplines</option>${discs.map(d => `<option ${d === logFilter.discipline ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>
          <span class="spacer"></span>
          <button class="btn small ${view === "list" ? "primary" : ""}" data-view="list">List</button>
          <button class="btn small ${view === "grid" ? "primary" : ""}" data-view="grid">Thumbnails</button>
        </div>
        <div id="dwgRows">${logRows(p)}</div>
      </div>
      <div class="panel"><h2>Drawing Sets</h2>
        ${sets.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Set</th><th>File</th><th>Sheets</th><th>Drawing Date</th><th>Uploaded</th><th></th></tr></thead><tbody>
          ${sets.map(s => `<tr><td><strong>${esc(s.data.name)}</strong></td><td>${esc(s.data.fileName)}</td><td>${s.data.sheets}</td><td class="nowrap">${PM.fmtDate(s.data.drawingDate)}</td>
            <td class="nowrap">${PM.fmtDate(s.data.at)} · ${esc(s.data.uploadedBy || "")}</td>
            <td class="nowrap"><button class="btn small" data-dl="${esc(s.data.fileUrl)}" data-name="${esc(s.data.fileName)}">Download PDF</button>
              <button class="btn small danger" data-perm="drawings:admin" data-delset="${s.id}">Delete set</button></td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">No drawing sets uploaded yet.</p>`}
      </div>`;
  }

  function wireLog(p) {
    if (!$("#dwgSearch")) return;
    const up = $("#dwgUpload");
    if (up) up.onclick = () => uploadModal(p);
    $("#dwgSearch").addEventListener("input", e => { logFilter.q = e.target.value; $("#dwgRows").innerHTML = logRows(p); PM.bind($("#dwgRows")); });
    $("#dwgDisc").addEventListener("change", e => { logFilter.discipline = e.target.value; $("#dwgRows").innerHTML = logRows(p); PM.bind($("#dwgRows")); });
    $$("[data-view]").forEach(b => b.onclick = () => { PM.lsSet("netpower_pm_dwg_view", b.dataset.view); PM.render(); });
  }

  // Delete buttons in the drawing log
  document.addEventListener("click", async e => {
    const b = e.target.closest && e.target.closest("[data-delsheet], [data-delset]");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const p = Store.get(location.hash.split("/")[2]);
    if (!p) return;
    try {
      if (b.dataset.delsheet) {
        const g = Store.get(b.dataset.delsheet);
        if (!g || !window.confirm(`Delete sheet ${g.data.number}${g.data.title ? " (" + g.data.title + ")" : ""} with all ${(g.data.revisions || []).length} revision(s) and markups? This cannot be undone.`)) return;
        b.disabled = true;
        await deleteSheets(p, [g.id]);
        toast(`Sheet ${g.data.number} deleted`);
      } else {
        const set = Store.get(b.dataset.delset);
        if (!set) return;
        const n = Store.all("drawing", p.id).filter(g => (g.data.revisions || []).some(r => r.setId === set.id)).length;
        if (!window.confirm(`Delete the drawing set "${set.data.name}" (${set.data.fileName})?\n\nThis removes its ${n} sheet revision(s), their markups and the PDF file. Sheets that also have revisions from other sets keep those. This cannot be undone.`)) return;
        b.disabled = true;
        toast("Deleting set…");
        await deleteSet(p, set.id);
        toast(`Set "${set.data.name}" deleted`);
      }
      PM.render();
    } catch (err) {
      b.disabled = false;
      toast("Delete failed: " + err.message, true);
    }
  }, true);

  // Download buttons (log + viewer)
  document.addEventListener("click", async e => {
    const b = e.target.closest && e.target.closest("[data-dl]");
    if (!b) return;
    e.preventDefault();
    try {
      const url = await fileObjectUrl(b.dataset.dl);
      const a = document.createElement("a");
      a.href = url + (b.dataset.page && !url.startsWith("blob:") ? "#page=" + b.dataset.page : "");
      a.target = "_blank";
      a.rel = "noopener";
      if (url.startsWith("blob:")) a.download = b.dataset.name || "drawing.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) { toast(err.message, true); }
  });

  // ───────────────────────── Links panel (RFI / punch detail) ─────────────────────────
  function linksTo(p, targetId) {
    const out = [];
    Store.all("markup", p.id).forEach(m => (m.data.shapes || []).forEach(s => {
      if (s.t === "pin" && s.link && s.link.id === targetId) {
        const g = Store.get(m.data.drawingId);
        if (g) out.push({ g, rev: (g.data.revisions || []).find(r => r.id === m.data.revId), shape: s });
      }
    }));
    return out;
  }

  function linksPanel(p, targetId) {
    const links = linksTo(p, targetId);
    if (!links.length) return "";
    return `<div class="panel no-print"><h2>Drawing Locations</h2>${links.map(l => `<div style="margin:4px 0">📍 <a href="#/p/${p.id}/drawings/${l.g.id}?rev=${l.rev ? l.rev.id : ""}&pin=${l.shape.id}"><strong>${esc(l.g.data.number)}</strong> ${esc(l.g.data.title || "")}</a>
      <span class="muted">Rev ${esc(l.rev ? l.rev.rev : "?")}${l.rev && l.rev.id !== l.g.data.current ? " (superseded)" : ""}</span></div>`).join("")}</div>`;
  }

  // ───────────────────────── Viewer ─────────────────────────
  // [key, icon, label, shortcut, how-to hint]
  const TOOLS = [
    ["pan", "➚", "Select", "V", "Scroll to zoom · drag to move the sheet · click a markup to select or move it · double-click text to edit"],
    ["pen", "✎", "Pen", "P", "Drag to draw freehand"],
    ["highlight", "▬", "Highlight", "H", "Drag to highlight"],
    ["line", "╱", "Line", "L", "Drag to draw a line"],
    ["arrow", "↗", "Arrow", "A", "Drag from the tail to the tip"],
    ["rect", "▭", "Box", "B", "Drag to draw a box"],
    ["cloud", "☁", "Cloud", "C", "Drag to draw a revision cloud"],
    ["text", "T", "Text", "T", "Click where the text should go"],
    ["link", "📍", "Pin", "N", "Click a spot to pin an RFI or punch item there"]
  ];
  const COLORS = ["#e5322d", "#f26722", "#e6b800", "#1f9d55", "#1d63c9", "#7b3fbf", "#111111"];
  const WIDTHS = [["1.5", "Thin"], ["2.5", "Medium"], ["5", "Thick"], ["9", "Extra thick"]];
  const FONTS = {
    arial: ["Arial", "Arial, Helvetica, sans-serif"],
    verdana: ["Verdana", "Verdana, Geneva, sans-serif"],
    times: ["Times New Roman", "'Times New Roman', Times, serif"],
    georgia: ["Georgia", "Georgia, serif"],
    courier: ["Courier New", "'Courier New', Courier, monospace"]
  };
  const TEXT_SIZES = [6, 8, 10, 12, 14, 18, 24, 36, 48, 72, 96, 144];
  const TEXT_FILLS = [["", "None"], ["#ffffff", "White"], ["#fff59d", "Yellow"]];
  const viewState = {};  // "drawingId|revId" → {zoom, cx, cy} restored on remount

  // Text box geometry (page units = PDF points)
  const measureCtx = document.createElement("canvas").getContext("2d");
  const fontFamily = s => (FONTS[s.font] || FONTS.arial)[1];
  function textBox(s) {
    measureCtx.font = `${s.italic ? "italic " : ""}${s.bold ? "700" : "400"} 100px ${fontFamily(s)}`;
    const lines = String(s.text || "").split("\n");
    const w = Math.max(...lines.map(l => measureCtx.measureText(l).width)) * s.size / 100;
    const lh = s.size * 1.2, pad = s.size * 0.35;
    return { lines, lh, pad, w: w + 2 * pad, h: lines.length * lh + 2 * pad };
  }

  function viewer(p, id, query) {
    const g = Store.get(id);
    if (!g || g.type !== "drawing") return `<div class="empty">Drawing not found. <a href="#/p/${p.id}/drawings">Back to drawings</a></div>`;
    const revs = g.data.revisions || [];
    const rev = revs.find(r => r.id === query.get("rev")) || currentRev(g);
    if (!rev) return `<div class="empty">This sheet has no revisions.</div>`;
    const sheets = sheetsOf(p);
    const idx = sheets.findIndex(x => x.id === g.id);
    const prev = sheets[idx - 1], next = sheets[idx + 1];
    const isCurrent = rev.id === g.data.current;
    const toolBtn = ([k, icon, label, key]) => `<button class="tool" data-tool="${k}" title="${label} (${key})" aria-label="${label}"><span class="ti">${icon}</span><span class="tl">${label}</span></button>`;
    document.body.classList.add("viewer-mode");
    setTimeout(() => mountViewer(p, g, rev, query.get("pin")), 0);
    return `
      <div class="dv">
        <div class="dv-head">
          <a class="btn small" href="#/p/${p.id}/drawings">← Drawings</a>
          <a class="btn small ${prev ? "" : "disabled"}" ${prev ? `href="#/p/${p.id}/drawings/${prev.id}"` : ""} title="Previous sheet">‹</a>
          <a class="btn small ${next ? "" : "disabled"}" ${next ? `href="#/p/${p.id}/drawings/${next.id}"` : ""} title="Next sheet">›</a>
          <div class="dv-title"><strong>${esc(g.data.number)}</strong> ${esc(g.data.title || "")}
            <span class="muted">· Rev ${esc(rev.rev)} · ${esc(rev.setName || "")}${rev.drawingDate ? " · " + PM.fmtDate(rev.drawingDate) : ""}</span>
            ${isCurrent ? "" : `<span class="pill revise-and-resubmit">Not current</span>`}</div>
          <select id="dvRev" aria-label="Revision">${revs.slice().reverse().map(r => `<option value="${r.id}" ${r.id === rev.id ? "selected" : ""}>Rev ${esc(r.rev)}${r.id === g.data.current ? " (current)" : ""} — ${esc(r.setName || "")}</option>`).join("")}</select>
          <button class="btn small" id="dvSideBtn">Details</button>
        </div>
        <div class="dv-tools" role="toolbar" aria-label="Markup tools">
          ${toolBtn(TOOLS[0])}
          <span class="dv-markup" data-perm="drawings:standard">
          ${TOOLS.slice(1).map(toolBtn).join("")}
          <span class="sep"></span>
          ${COLORS.map(c => `<button class="swatch" data-color="${c}" style="background:${c}" title="Color" aria-label="Color ${c}"></button>`).join("")}
          <select id="dvWidth" class="dv-width" title="Line thickness" aria-label="Line thickness">${WIDTHS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          <span class="sep"></span>
          <button class="tool" id="dvEditText" title="Edit text (or double-click it)" aria-label="Edit text" hidden><span class="ti">✎</span><span class="tl">Edit text</span></button>
          <button class="tool" id="dvUndo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
          <button class="tool" id="dvDelete" title="Delete selected (Del)" aria-label="Delete selected">🗑</button>
          </span>
          <span class="sep"></span>
          <button class="tool" id="dvZoomOut" title="Zoom out (−)" aria-label="Zoom out">−</button>
          <span id="dvZoomLbl" class="zoom-lbl">100%</span>
          <button class="tool" id="dvZoomIn" title="Zoom in (+)" aria-label="Zoom in">+</button>
          <button class="tool" id="dvFit" title="Fit to screen (0)" aria-label="Fit">⤢</button>
          <span class="spacer"></span>
          <button class="btn small" id="dvPublish" data-perm="drawings:standard" title="Make your markups visible to everyone">Publish</button>
        </div>
        <div class="dv-body">
          <div class="dv-wrap" id="dvWrap">
            <div class="dv-stage" id="dvStage">
              <div class="dv-page" id="dvPage">
                <canvas id="dvBase"></canvas><canvas id="dvTile"></canvas>
                <svg id="dvSvg" xmlns="http://www.w3.org/2000/svg"></svg>
                <div class="dv-pop" id="dvPop" hidden></div>
              </div>
            </div>
            <div class="dv-msg" id="dvMsg">Loading sheet…</div>
          </div>
          <div class="dv-hint" id="dvHint" aria-live="polite"></div>
          <aside class="dv-side" id="dvSide"></aside>
        </div>
      </div>`;
  }

  async function mountViewer(p, g, rev, focusPinId) {
    const wrap = $("#dvWrap");
    if (!wrap) return;
    const key = g.id + "|" + rev.id;
    const V = {
      p, g, rev, key, zoom: 1, W: 0, H: 0, mx: 0, my: 0, page: null, baseScale: 1,
      tool: "pan", color: PM.lsGet("netpower_pm_markup_color", COLORS[0]), width: Number(PM.lsGet("netpower_pm_markup_width", 2.5)) || 2.5,
      mine: [], undo: [], selected: null, draft: null, pan: null, drag: null, space: false,
      showOthers: PM.lsGet("netpower_pm_show_others", true),
      saveTimer: null, tileTimer: null, tileTask: null, dirty: false, destroyed: false
    };
    const stage = $("#dvStage"), page = $("#dvPage"), svg = $("#dvSvg"), base = $("#dvBase"), tile = $("#dvTile"), msg = $("#dvMsg"), pop = $("#dvPop"), hint = $("#dvHint");
    const canMarkup = () => !!document.querySelector('.dv-tools [data-tool="pen"]');

    const myRecord = () => PM.me() ? Store.all("markup", p.id).find(m => m.data.drawingId === g.id && m.data.revId === rev.id && m.data.ownerId === PM.me()) : null;
    const others = () => Store.all("markup", p.id).filter(m => m.data.drawingId === g.id && m.data.revId === rev.id && m.data.ownerId !== PM.me());
    V.mine = JSON.parse(JSON.stringify((myRecord() || { data: { shapes: [] } }).data.shapes || []));

    const typing = e => e.target.closest && e.target.closest("input, textarea, select, [contenteditable], .modal");
    const onKey = e => {
      if (typing(e)) return;
      const k = e.key;
      if (k === " ") { e.preventDefault(); if (!V.space) { V.space = true; syncCursor(); } return; }
      if ((k === "Delete" || k === "Backspace") && V.selected) { e.preventDefault(); deleteSelected(); }
      else if (k === "Escape") stopTool();
      else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); undo(); }
      else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (k === "+" || k === "=") zoomAt(V.zoom * 1.25);
      else if (k === "-" || k === "_") zoomAt(V.zoom / 1.25);
      else if (k === "0") fit();
      else {
        const t = TOOLS.find(x => x[3] === k.toUpperCase());
        if (t && (t[0] === "pan" || canMarkup())) setTool(t[0]);
      }
    };
    const onKeyUp = e => { if (e.key === " ") { V.space = false; syncCursor(); } };
    const onResize = () => { if (!V.W) return; const c = center(); layout(); centerOn(c.x, c.y); scheduleTile(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", onResize);
    PM.cleanup = () => {
      V.destroyed = true;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      if (V.tileTask) V.tileTask.cancel();
      if (V.dirty) saveNow();
      if (V.W) viewState[key] = { zoom: V.zoom, ...center() };
    };

    // Toolbar
    $$("[data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
    $$("[data-color]").forEach(b => b.onclick = () => {
      V.color = b.dataset.color;
      PM.lsSet("netpower_pm_markup_color", V.color);
      const s = selectedShape();
      if (s && isMine(s.id) && s.t !== "pin") { pushUndo(); s.color = V.color; changed(); }
      syncToolbar();
    });
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    const widthSel = $("#dvWidth");
    if (widthSel) {
      widthSel.value = String(V.width);
      if (widthSel.value !== String(V.width)) widthSel.value = "2.5";
      widthSel.onchange = () => {
        V.width = Number(widthSel.value);
        PM.lsSet("netpower_pm_markup_width", V.width);
        const s = selectedShape();
        if (s && isMine(s.id) && "w" in s) { pushUndo(); s.w = V.width; changed(); }
        widthSel.blur();
      };
    }
    on("#dvUndo", undo);
    on("#dvDelete", deleteSelected);
    on("#dvEditText", () => { const s = selectedShape(); if (s && s.t === "text" && isMine(s.id)) textEditor(null, s); });
    $("#dvZoomIn").onclick = () => zoomAt(V.zoom * 1.4);
    $("#dvZoomOut").onclick = () => zoomAt(V.zoom / 1.4);
    $("#dvFit").onclick = fit;
    on("#dvPublish", publish);
    $("#dvRev").onchange = e => { location.hash = `#/p/${p.id}/drawings/${g.id}?rev=${e.target.value}`; };
    $("#dvSideBtn").onclick = () => document.body.classList.toggle("dv-side-open");
    updateHint();

    renderSide();  // available even if the PDF fails to load (e.g. to delete the sheet)

    // Load the PDF page
    try {
      const doc = await openPdf(rev.fileUrl);
      if (V.destroyed) return;
      V.page = await doc.getPage(rev.page);
    } catch (e) {
      if (!V.destroyed) msg.textContent = "Could not load this sheet: " + e.message;
      return;
    }
    if (V.destroyed) return;
    const vp = V.page.getViewport({ scale: 1 });
    V.W = vp.width; V.H = vp.height;
    svg.setAttribute("viewBox", `0 0 ${V.W} ${V.H}`);

    // Low-res full-page base layer
    V.baseScale = Math.min(2600 / Math.max(V.W, V.H), 3);
    const bvp = V.page.getViewport({ scale: V.baseScale });
    base.width = Math.ceil(bvp.width);
    base.height = Math.ceil(bvp.height);
    const bctx = base.getContext("2d");
    bctx.fillStyle = "#fff";
    bctx.fillRect(0, 0, base.width, base.height);
    try { await V.page.render({ canvasContext: bctx, viewport: bvp }).promise; } catch (e) { if (V.destroyed) return; }
    if (V.destroyed) return;
    msg.hidden = true;

    const saved = viewState[key];
    if (saved) { setZoom(saved.zoom); centerOn(saved.x, saved.y); } else fit();
    syncToolbar();
    draw();
    renderSide();
    scheduleTile();
    if (focusPinId) focusPin(focusPinId);

    wrap.addEventListener("scroll", () => scheduleTile());
    // Mouse wheel / trackpad pinch zooms toward the cursor
    wrap.addEventListener("wheel", e => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33; else if (e.deltaMode === 2) dy *= 400;
      dy = Math.max(-300, Math.min(300, dy));
      const r = wrap.getBoundingClientRect();
      zoomAt(V.zoom * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // ── Geometry / layout
    function toPage(e) {
      const r = svg.getBoundingClientRect();
      return { x: (e.clientX - r.left) / V.zoom, y: (e.clientY - r.top) / V.zoom };
    }
    const clampPt = pt => ({ x: Math.min(Math.max(pt.x, 0), V.W), y: Math.min(Math.max(pt.y, 0), V.H) });
    const inPage = pt => pt.x >= 0 && pt.y >= 0 && pt.x <= V.W && pt.y <= V.H;
    function fitZoom() { return Math.max(0.05, Math.min((wrap.clientWidth - 40) / V.W, (wrap.clientHeight - 40) / V.H)); }
    // The sheet sits on a larger "stage" so it can always be dragged around, even when it fits on screen
    function layout() {
      V.mx = Math.max(80, Math.round(wrap.clientWidth * 0.5));
      V.my = Math.max(80, Math.round(wrap.clientHeight * 0.5));
      const pw = V.W * V.zoom, ph = V.H * V.zoom;
      page.style.width = pw + "px";
      page.style.height = ph + "px";
      page.style.left = V.mx + "px";
      page.style.top = V.my + "px";
      stage.style.width = pw + 2 * V.mx + "px";
      stage.style.height = ph + 2 * V.my + "px";
    }
    function center() {  // page point at the middle of the screen
      return { x: (wrap.scrollLeft + wrap.clientWidth / 2 - V.mx) / V.zoom, y: (wrap.scrollTop + wrap.clientHeight / 2 - V.my) / V.zoom };
    }
    function centerOn(x, y) {
      wrap.scrollLeft = x * V.zoom + V.mx - wrap.clientWidth / 2;
      wrap.scrollTop = y * V.zoom + V.my - wrap.clientHeight / 2;
    }
    function setZoom(z) {
      V.zoom = Math.min(Math.max(z, fitZoom() * 0.5, 0.05), 12);
      layout();
      $("#dvZoomLbl").textContent = Math.round(V.zoom / fitZoom() * 100) + "%";
      tile.style.display = "none";
      hidePop();
    }
    function zoomAt(z, cx, cy) {
      if (!V.W) return;  // page not loaded yet
      if (cx == null) { cx = wrap.clientWidth / 2; cy = wrap.clientHeight / 2; }
      const px = (wrap.scrollLeft + cx - V.mx) / V.zoom, py = (wrap.scrollTop + cy - V.my) / V.zoom;
      setZoom(z);
      wrap.scrollLeft = px * V.zoom + V.mx - cx;
      wrap.scrollTop = py * V.zoom + V.my - cy;
      draw();
      scheduleTile();
    }
    function fit() { if (!V.W) return; setZoom(fitZoom()); centerOn(V.W / 2, V.H / 2); draw(); scheduleTile(); }

    // Sharp tile for the visible area, rendered after scrolling/zooming settles
    function scheduleTile() {
      clearTimeout(V.tileTimer);
      V.tileTimer = setTimeout(renderTile, 140);
    }
    async function renderTile() {
      if (V.destroyed || !V.page) return;
      const dpr = window.devicePixelRatio || 1;
      if (V.zoom * dpr <= V.baseScale * 1.05) { tile.style.display = "none"; return; }
      const x0 = wrap.scrollLeft - V.mx, y0 = wrap.scrollTop - V.my;
      const sl = Math.max(0, x0), st = Math.max(0, y0);
      const w = Math.min(V.W * V.zoom, x0 + wrap.clientWidth) - sl, h = Math.min(V.H * V.zoom, y0 + wrap.clientHeight) - st;
      if (w <= 0 || h <= 0) return;
      if (V.tileTask) V.tileTask.cancel();
      const off = document.createElement("canvas");
      off.width = Math.ceil(w * dpr);
      off.height = Math.ceil(h * dpr);
      const ctx = off.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, off.width, off.height);
      const zoomAtStart = V.zoom;
      const task = V.page.render({ canvasContext: ctx, viewport: V.page.getViewport({ scale: V.zoom * dpr, offsetX: -sl * dpr, offsetY: -st * dpr }) });
      V.tileTask = task;
      try { await task.promise; } catch (e) { return; }  // cancelled
      if (V.destroyed || zoomAtStart !== V.zoom) return;
      tile.width = off.width;
      tile.height = off.height;
      tile.getContext("2d").drawImage(off, 0, 0);
      Object.assign(tile.style, { left: sl + "px", top: st + "px", width: w + "px", height: h + "px", display: "block" });
    }

    // ── Shapes
    function visibleShapes() {
      const out = V.mine.map(s => ({ s, mine: true, owner: PM.meName() }));
      if (V.showOthers) others().forEach(m => (m.data.shapes || []).filter(s => s.published).forEach(s => out.push({ s, mine: false, owner: m.data.ownerName })));
      else others().forEach(m => (m.data.shapes || []).filter(s => s.t === "pin").forEach(s => out.push({ s, mine: false, owner: m.data.ownerName })));
      return out;
    }
    function isMine(sid) { return V.mine.some(s => s.id === sid); }
    function selectedShape() { const v = visibleShapes().find(x => x.s.id === V.selected); return v ? v.s : null; }

    function pinInfo(s) {
      const t = Store.get(s.link && s.link.id);
      if (!t) return { label: "?", title: "Deleted item", color: "#8a94a3", href: null, status: "" };
      if (t.type === "rfi") return { label: "RFI " + t.data.number, title: t.data.subject, status: t.data.status, color: t.data.status === "Closed" ? "#1f9d55" : "#1d63c9", href: `#/p/${p.id}/rfis/${t.id}` };
      return { label: "P" + t.data.number, title: t.data.title, status: t.data.status, color: t.data.status === "Closed" ? "#1f9d55" : t.data.status === "Ready for Review" ? "#e6b800" : "#e5322d", href: `#/p/${p.id}/punch/${t.id}` };
    }

    function cloudPath(x1, y1, x2, y2) {
      const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      const r = Math.min(Math.max(Math.min(w, h) / 6, 4), 16);
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
      let d = `M${x} ${y}`;
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i], [bx, by] = corners[i + 1];
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.round(len / (2 * r)));
        const seg = len / n;
        for (let k = 1; k <= n; k++) {
          const px = ax + (bx - ax) * k / n, py = ay + (by - ay) * k / n;
          d += ` A${(seg * 0.6).toFixed(1)} ${(seg * 0.6).toFixed(1)} 0 0 1 ${px.toFixed(1)} ${py.toFixed(1)}`;
        }
      }
      return d + " Z";
    }

    function shapeSVG(s, mine, owner) {
      const z = V.zoom;
      const c = esc(s.color || COLORS[0]);
      const sw = s.t === "highlight" ? (s.w || 2.5) * 5.6 : (s.w || 2.5);
      const cls = "shape" + (s.id === V.selected ? " sel" : "") + (mine && s.t !== "pin" ? " mine" : "");
      const title = `<title>${esc(owner || "")}${s.published ? "" : " (unpublished)"}</title>`;
      const hit = d => `<path d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(sw, 14 / z)}" class="hit" data-sid="${s.id}"/>`;
      const line = (x1, y1, x2, y2) => `M${x1} ${y1} L${x2} ${y2}`;
      let d;
      switch (s.t) {
        case "pen":
        case "highlight":
          d = "M" + s.pts.map(pt => pt[0] + " " + pt[1]).join(" L");
          return `<g class="${cls}">${title}<path d="${d}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" ${s.t === "highlight" ? 'stroke-opacity="0.35"' : ""}/>${hit(d)}</g>`;
        case "line":
          d = line(s.x1, s.y1, s.x2, s.y2);
          return `<g class="${cls}">${title}<path d="${d}" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/>${hit(d)}</g>`;
        case "arrow": {
          const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), hl = Math.max(10, sw * 5);
          const p1 = [s.x2 - hl * Math.cos(a - 0.45), s.y2 - hl * Math.sin(a - 0.45)], p2 = [s.x2 - hl * Math.cos(a + 0.45), s.y2 - hl * Math.sin(a + 0.45)];
          d = line(s.x1, s.y1, s.x2, s.y2);
          return `<g class="${cls}">${title}<path d="${d}" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/><polygon points="${s.x2},${s.y2} ${p1.join(",")} ${p2.join(",")}" fill="${c}"/>${hit(d)}</g>`;
        }
        case "rect":
          d = `M${s.x1} ${s.y1} H${s.x2} V${s.y2} H${s.x1} Z`;
          return `<g class="${cls}">${title}<path d="${d}" fill="none" stroke="${c}" stroke-width="${sw}"/>${hit(d)}</g>`;
        case "cloud":
          d = cloudPath(s.x1, s.y1, s.x2, s.y2);
          return `<g class="${cls}">${title}<path d="${d}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linejoin="round"/>${hit(`M${s.x1} ${s.y1} H${s.x2} V${s.y2} H${s.x1} Z`)}</g>`;
        case "text": {
          if (!s.v) {  // older single-line text markups
            return `<g class="${cls}">${title}<text x="${s.x}" y="${s.y}" font-size="${s.size}" fill="${c}" stroke="#fff" stroke-width="${s.size / 6}" paint-order="stroke" font-family="Helvetica, Arial, sans-serif" font-weight="600" data-sid="${s.id}">${esc(s.text)}</text></g>`;
          }
          const b = textBox(s);
          const halo = s.fill ? "" : `stroke="#fff" stroke-width="${s.size / 7}" paint-order="stroke" stroke-linejoin="round"`;
          const style = `white-space:pre${s.underline ? ";text-decoration:underline" : ""}`;
          return `<g class="${cls}">${title}
            <rect x="${s.x}" y="${s.y}" width="${b.w}" height="${b.h}" fill="${esc(s.fill || "#ffffff")}" fill-opacity="${s.fill ? 1 : 0}" stroke="${s.border ? c : "none"}" stroke-width="${Math.max(s.size / 14, 0.5)}" data-sid="${s.id}"/>
            ${b.lines.map((l, i) => `<text x="${s.x + b.pad}" y="${s.y + b.pad + b.lh * i + s.size * 0.92}" font-size="${s.size}" font-family="${esc(fontFamily(s))}" font-weight="${s.bold ? 700 : 400}" font-style="${s.italic ? "italic" : "normal"}" fill="${c}" ${halo} style="${style}" data-sid="${s.id}">${esc(l)}</text>`).join("")}</g>`;
        }
        case "pin": {
          const info = pinInfo(s), r = 11 / z, fs = 11 / z, lw = (info.label.length * 6.6 + 10) / z;
          return `<g class="${cls} pin" data-sid="${s.id}"><title>${esc(info.label + ": " + info.title)}</title>
            <rect x="${s.x + r * 0.6}" y="${s.y - 8 / z}" width="${lw}" height="${16 / z}" rx="${3 / z}" fill="#fff" stroke="${info.color}" stroke-width="${1 / z}" data-sid="${s.id}"/>
            <text x="${s.x + r * 0.6 + 5 / z}" y="${s.y + 4 / z}" font-size="${fs}" fill="#1f2328" font-family="Helvetica, Arial, sans-serif" font-weight="700" data-sid="${s.id}">${esc(info.label)}</text>
            <circle cx="${s.x}" cy="${s.y}" r="${r}" fill="${info.color}" stroke="#fff" stroke-width="${2 / z}" data-sid="${s.id}"/>
            <circle cx="${s.x}" cy="${s.y}" r="${3 / z}" fill="#fff" data-sid="${s.id}"/></g>`;
        }
      }
      return "";
    }

    // Drag handles for the selected markup (only your own)
    function handlesOf(s) {
      if (!s || !isMine(s.id)) return [];
      if (s.t === "line" || s.t === "arrow") return [["x1,y1", s.x1, s.y1], ["x2,y2", s.x2, s.y2]];
      if (s.t === "rect" || s.t === "cloud") return [["x1,y1", s.x1, s.y1], ["x2,y1", s.x2, s.y1], ["x1,y2", s.x1, s.y2], ["x2,y2", s.x2, s.y2]];
      if (s.t === "text" && s.v) { const b = textBox(s); return [["size", s.x + b.w, s.y + b.h]]; }
      return [];
    }
    function handlesSVG() {
      const z = V.zoom, hs = 9 / z;
      return handlesOf(selectedShape()).map(([k, x, y]) => `<rect class="handle" data-handle="${k}" x="${x - hs / 2}" y="${y - hs / 2}" width="${hs}" height="${hs}" fill="#fff" stroke="#1d63c9" stroke-width="${1.5 / z}"/>`).join("");
    }

    function draw() {
      const shapes = visibleShapes();
      shapes.sort((a, b) => (a.s.t === "pin") - (b.s.t === "pin"));
      svg.innerHTML = shapes.map(v => shapeSVG(v.s, v.mine, v.owner)).join("") + (V.draft ? shapeSVG(V.draft, true, "") : "") + handlesSVG();
      const unpub = V.mine.filter(s => !s.published).length;
      const pubBtn = $("#dvPublish");
      if (pubBtn) {
        pubBtn.textContent = unpub ? `Publish (${unpub})` : "Published ✓";
        pubBtn.disabled = !unpub;
        pubBtn.classList.toggle("primary", !!unpub);
      }
      const sel = selectedShape(), mineSel = !!(sel && isMine(sel.id));
      if ($("#dvDelete")) $("#dvDelete").disabled = !mineSel;
      if ($("#dvUndo")) $("#dvUndo").disabled = !V.undo.length;
      if ($("#dvEditText")) $("#dvEditText").hidden = !(mineSel && sel.t === "text");
    }

    function syncCursor() {
      const c = V.pan ? "grabbing" : V.space ? "grab" : V.tool === "pan" ? "grab" : "crosshair";
      wrap.style.cursor = c;
      svg.style.cursor = c;
    }
    function syncToolbar() {
      $$("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === V.tool));
      $$("[data-color]").forEach(b => b.classList.toggle("on", b.dataset.color === V.color));
      wrap.style.touchAction = V.tool === "pan" ? "auto" : "none";
      wrap.classList.toggle("drawing", V.tool !== "pan");
      syncCursor();
    }
    function updateHint() {
      const t = TOOLS.find(x => x[0] === V.tool) || TOOLS[0];
      hint.innerHTML = V.tool === "pan"
        ? esc(t[4])
        : `<strong>${esc(t[2])}:</strong> ${esc(t[4])}. <span class="dv-hint-stop">Right-click or Esc to stop.</span>`;
      hint.classList.toggle("active", V.tool !== "pan");
      hint.classList.remove("faded");
      clearTimeout(V.hintTimer);
      if (V.tool === "pan") V.hintTimer = setTimeout(() => hint.classList.add("faded"), 6000);
    }
    function setTool(t) {
      if (t !== "pan" && !PM.me()) { toast("Pick who you are first (top right) so your markups are saved under your name", true); PM.pickUser(); return; }
      V.tool = t;
      V.draft = null;
      if (t !== "pan") V.selected = null;
      hidePop();
      syncToolbar();
      updateHint();
      draw();
    }
    // Right-click / Esc: cancel what's being drawn and go back to Select
    function stopTool() {
      if (V.draft) { V.draft = null; draw(); }
      if (V.tool !== "pan") setTool("pan");
      else { V.selected = null; hidePop(); draw(); }
    }

    // ── Editing
    function pushUndo() { V.undo.push(JSON.stringify(V.mine)); if (V.undo.length > 60) V.undo.shift(); }
    function undo() { if (!V.undo.length) return; V.mine = JSON.parse(V.undo.pop()); V.selected = null; hidePop(); changed(); }
    function deleteSelected() {
      if (!V.selected || !isMine(V.selected)) { if (V.selected) toast("You can only delete your own markups", true); return; }
      pushUndo();
      V.mine = V.mine.filter(s => s.id !== V.selected);
      V.selected = null;
      hidePop();
      changed();
    }
    function addShape(s) { pushUndo(); V.mine.push(s); changed(); }
    function changed() { V.dirty = true; draw(); renderSide(); clearTimeout(V.saveTimer); V.saveTimer = setTimeout(saveNow, 700); }
    async function saveNow() {
      clearTimeout(V.saveTimer);
      if (!PM.me()) return;
      V.dirty = false;
      const existing = myRecord();
      const rec = { id: existing ? existing.id : uid("mk"), type: "markup", projectId: p.id, data: { drawingId: g.id, revId: rev.id, ownerId: PM.me(), ownerName: PM.meName(), shapes: V.mine, updatedAt: new Date().toISOString() } };
      try { await Store.save(rec); } catch (e) { V.dirty = true; toast("Markups not saved: " + e.message, true); }
    }
    function publish() {
      if (!V.mine.some(s => !s.published)) return;
      pushUndo();
      V.mine.forEach(s => { s.published = true; });
      changed();
      toast("Markups published — everyone on the project can see them");
    }
    function round(n) { return Math.round(n * 10) / 10; }

    // Move a shape by (dx, dy) starting from its original copy o
    function moveShape(s, o, dx, dy) {
      if (o.pts) s.pts = o.pts.map(q => [round(q[0] + dx), round(q[1] + dy)]);
      if ("x1" in o) { s.x1 = round(o.x1 + dx); s.y1 = round(o.y1 + dy); s.x2 = round(o.x2 + dx); s.y2 = round(o.y2 + dy); }
      if ("x" in o) { s.x = round(o.x + dx); s.y = round(o.y + dy); }
    }
    function resizeShape(s, o, handle, pt) {
      if (handle === "size") {
        const w0 = textBox(o).w;
        s.size = round(Math.min(Math.max(o.size * Math.max(pt.x - o.x, 1) / w0, 2), 400));
        return;
      }
      const [xk, yk] = handle.split(",");
      s[xk] = round(pt.x);
      s[yk] = round(pt.y);
    }

    // ── Pointer interaction (on the whole drawing area, so the sheet can be dragged from anywhere)
    function startPan(e) {
      V.pan = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
      wrap.setPointerCapture(e.pointerId);
      syncCursor();
    }
    wrap.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });  // no autoscroll on middle-click
    wrap.addEventListener("contextmenu", e => { if (!e.target.closest("#dvPop")) { e.preventDefault(); stopTool(); } });
    wrap.addEventListener("pointerdown", e => {
      if (!V.W || e.target.closest("#dvPop")) return;
      if (e.button === 1 || (e.button === 0 && V.space)) { e.preventDefault(); startPan(e); return; }
      if (e.button !== 0) return;
      const pt = toPage(e);
      const handleEl = e.target.closest("[data-handle]");
      const hitEl = e.target.closest("[data-sid]");
      if (V.tool === "pan") {
        if (handleEl) {
          const s = selectedShape();
          V.drag = { mode: "resize", handle: handleEl.dataset.handle, s, o: JSON.parse(JSON.stringify(s)), start: pt, moved: false };
          wrap.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
        if (hitEl) {
          V.selected = hitEl.dataset.sid;
          const s = selectedShape();
          hidePop();
          draw();
          if (!s) return;
          if (!isMine(s.id) && s.t !== "pin") toast("Markup by " + (visibleShapes().find(v => v.s.id === s.id) || {}).owner);
          V.drag = { mode: "move", s, o: JSON.parse(JSON.stringify(s)), start: pt, moved: false, canMove: isMine(s.id) && e.pointerType === "mouse" };
          if (V.drag.canMove) { wrap.setPointerCapture(e.pointerId); e.preventDefault(); }
          return;
        }
        V.selected = null;
        hidePop();
        draw();
        if (e.pointerType === "mouse") { e.preventDefault(); startPan(e); }
        return;
      }
      if (!PM.me()) { setTool("pan"); return; }
      if (!inPage(pt)) { if (e.pointerType === "mouse") { e.preventDefault(); startPan(e); } return; }
      const base = { id: uid("s"), color: V.color, published: false, by: PM.meName(), at: new Date().toISOString() };
      if (V.tool === "pen" || V.tool === "highlight") {
        V.draft = { ...base, t: V.tool, w: V.width, pts: [[round(pt.x), round(pt.y)]] };
      } else if (["line", "arrow", "rect", "cloud"].includes(V.tool)) {
        V.draft = { ...base, t: V.tool, w: V.width, x1: round(pt.x), y1: round(pt.y), x2: round(pt.x), y2: round(pt.y) };
      } else if (V.tool === "text") {
        e.preventDefault();
        textEditor(pt, null, base);
        return;
      } else if (V.tool === "link") {
        e.preventDefault();
        linkModal(pt);
        return;
      }
      wrap.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    wrap.addEventListener("pointermove", e => {
      if (V.pan) {
        wrap.scrollLeft = V.pan.sl - (e.clientX - V.pan.x);
        wrap.scrollTop = V.pan.st - (e.clientY - V.pan.y);
        return;
      }
      if (V.drag) {
        const d = V.drag;
        if (!d.canMove && d.mode === "move") return;
        const pt = toPage(e);
        if (!d.moved) {
          if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) * V.zoom < 3) return;
          pushUndo();
          d.moved = true;
          hidePop();
        }
        if (d.mode === "move") moveShape(d.s, d.o, pt.x - d.start.x, pt.y - d.start.y);
        else resizeShape(d.s, d.o, d.handle, clampPt(pt));
        draw();
        return;
      }
      if (!V.draft) {
        if (V.tool === "pan" && !V.space) {
          const h = e.target.closest && e.target.closest("[data-handle], .shape.mine, .pin");
          wrap.style.cursor = h ? (h.dataset.handle ? "nwse-resize" : h.classList.contains("pin") ? "pointer" : "move") : "grab";
        }
        return;
      }
      const pt = clampPt(toPage(e));
      if (V.draft.pts) {
        const last = V.draft.pts[V.draft.pts.length - 1];
        if (Math.hypot(pt.x - last[0], pt.y - last[1]) * V.zoom < 2) return;
        V.draft.pts.push([round(pt.x), round(pt.y)]);
      } else {
        V.draft.x2 = round(pt.x);
        V.draft.y2 = round(pt.y);
      }
      draw();
    });
    const endPointer = () => {
      if (V.pan) { V.pan = null; syncCursor(); return; }
      if (V.drag) {
        const d = V.drag;
        V.drag = null;
        if (d.moved) { V.lastTap = null; changed(); return; }
        if (d.s.t === "pin") { showPop(d.s); return; }
        // two clicks on your own text without moving it → edit (the browser's dblclick is swallowed by drag handling)
        const now = Date.now(), last = V.lastTap;
        V.lastTap = { sid: d.s.id, at: now };
        if (d.s.t === "text" && isMine(d.s.id) && last && last.sid === d.s.id && now - last.at < 450) { V.lastTap = null; textEditor(null, d.s); }
        return;
      }
      if (!V.draft) return;
      const d = V.draft;
      V.draft = null;
      const tiny = d.pts ? d.pts.length < 2 : Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * V.zoom < 4;
      if (tiny) { draw(); return; }
      addShape(d);
    };
    wrap.addEventListener("pointerup", endPointer);
    wrap.addEventListener("pointercancel", endPointer);

    // ── Text editor (new text or editing existing)
    function textDefaults() {
      const st = PM.lsGet("netpower_pm_text_style", {}) || {};
      const want = 14 / V.zoom;  // ~14px on screen at the current zoom
      const size = TEXT_SIZES.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
      return { font: FONTS[st.font] ? st.font : "arial", size, bold: !!st.bold, italic: !!st.italic, underline: !!st.underline, fill: st.fill || "", border: !!st.border };
    }
    function textEditor(pt, existing, base) {
      const st = existing
        ? { font: existing.font || "arial", size: existing.size, bold: existing.v ? !!existing.bold : true, italic: !!existing.italic, underline: !!existing.underline, fill: existing.fill || "", border: !!existing.border, color: existing.color || V.color, text: existing.text || "" }
        : { ...textDefaults(), color: V.color, text: "" };
      const sizes = TEXT_SIZES.includes(Number(st.size)) ? TEXT_SIZES : [...TEXT_SIZES, Number(st.size)].sort((a, b) => a - b);
      PM.openModal({
        title: existing ? "Edit Text" : "Add Text",
        noRender: true,
        saveLabel: existing ? "Save" : "Add Text",
        body: `
          <div class="te">
            <div class="te-bar" role="toolbar" aria-label="Text formatting">
              <select id="teFont" aria-label="Font">${Object.entries(FONTS).map(([k, [label]]) => `<option value="${k}" ${k === st.font ? "selected" : ""}>${label}</option>`).join("")}</select>
              <select id="teSize" aria-label="Font size">${sizes.map(n => `<option value="${n}" ${Number(st.size) === n ? "selected" : ""}>${n} pt</option>`).join("")}</select>
              <button type="button" class="te-btn" data-te="bold" title="Bold" aria-label="Bold"><b>B</b></button>
              <button type="button" class="te-btn" data-te="italic" title="Italic" aria-label="Italic"><i>I</i></button>
              <button type="button" class="te-btn" data-te="underline" title="Underline" aria-label="Underline"><u>U</u></button>
            </div>
            <div class="te-row"><span class="te-l">Color</span>${COLORS.map(c => `<button type="button" class="swatch" data-tec="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join("")}</div>
            <div class="te-row"><span class="te-l">Background</span>${TEXT_FILLS.map(([v, l]) => `<label class="inline-check"><input type="radio" name="teFill" value="${v}" ${st.fill === v ? "checked" : ""}> ${l}</label>`).join("")}
              <label class="inline-check" style="margin-left:12px"><input type="checkbox" id="teBorder" ${st.border ? "checked" : ""}> Border</label></div>
            <textarea id="teText" rows="4" placeholder="Type your note…" aria-label="Text">${esc(st.text)}</textarea>
            <div class="muted help">Size is in points on the printed sheet. Press Enter for a new line. After adding, drag the text to move it or drag its corner to resize.</div>
          </div>`,
        onOpen: root => {
          const ta = $("#teText", root);
          const paint = () => {
            ta.style.fontFamily = FONTS[st.font][1];
            ta.style.fontSize = Math.min(Math.max(st.size * V.zoom, 12), 36) + "px";
            ta.style.fontWeight = st.bold ? 700 : 400;
            ta.style.fontStyle = st.italic ? "italic" : "normal";
            ta.style.textDecoration = st.underline ? "underline" : "none";
            ta.style.color = st.color;
            ta.style.background = st.fill || "#fff";
            ta.style.borderColor = st.border ? st.color : "";
            $$("[data-te]", root).forEach(b => b.classList.toggle("on", !!st[b.dataset.te]));
            $$("[data-tec]", root).forEach(b => b.classList.toggle("on", b.dataset.tec === st.color));
          };
          $("#teFont", root).onchange = e => { st.font = e.target.value; paint(); };
          $("#teSize", root).onchange = e => { st.size = Number(e.target.value); paint(); };
          $$("[data-te]", root).forEach(b => b.onclick = () => { st[b.dataset.te] = !st[b.dataset.te]; paint(); });
          $$("[data-tec]", root).forEach(b => b.onclick = () => { st.color = b.dataset.tec; paint(); });
          $$("input[name=teFill]", root).forEach(r => r.onchange = () => { st.fill = r.value; paint(); });
          $("#teBorder", root).onchange = e => { st.border = e.target.checked; paint(); };
          paint();
          setTimeout(() => ta.focus(), 30);
        },
        onSave: root => {
          const text = $("#teText", root).value.replace(/\s+$/, "").slice(0, 2000);
          const fields = { v: 2, text, font: st.font, size: st.size, bold: st.bold, italic: st.italic, underline: st.underline, fill: st.fill, border: st.border, color: st.color };
          PM.lsSet("netpower_pm_text_style", { font: st.font, bold: st.bold, italic: st.italic, underline: st.underline, fill: st.fill, border: st.border });
          if (existing) {
            if (!text.trim()) { V.selected = existing.id; deleteSelected(); return true; }
            pushUndo();
            if (!existing.v) existing.y = round(existing.y - existing.size * 1.25);  // old text: baseline → top-left
            Object.assign(existing, fields);
            changed();
          } else if (text.trim()) {
            addShape({ ...base, t: "text", x: round(pt.x), y: round(pt.y), ...fields });
          }
          return true;
        }
      });
    }

    function addPin(pt, type, id) {
      addShape({ id: uid("s"), t: "pin", x: round(pt.x), y: round(pt.y), link: { type, id }, published: true, by: PM.meName(), at: new Date().toISOString() });
      saveNow();
    }

    function linkModal(pt) {
      const rfis = Store.all("rfi", p.id).sort((a, b) => b.data.number - a.data.number);
      const punch = Store.all("punch", p.id).sort((a, b) => b.data.number - a.data.number);
      PM.openModal({
        title: "Pin to Drawing",
        noRender: true,
        saveLabel: "Continue",
        body: `
          <div class="field"><label>What do you want to pin here?</label>
            <div class="radio-list">
              <label><input type="radio" name="lk" value="newpunch" checked> Create a new punch item at this spot</label>
              <label><input type="radio" name="lk" value="newrfi"> Create a new RFI at this spot</label>
              <label><input type="radio" name="lk" value="punch" ${punch.length ? "" : "disabled"}> Link an existing punch item</label>
              <label><input type="radio" name="lk" value="rfi" ${rfis.length ? "" : "disabled"}> Link an existing RFI</label>
            </div></div>
          <div class="field" id="lkPunchF" hidden><label for="lkPunch">Punch item</label><select id="lkPunch">${punch.map(x => `<option value="${x.id}">#${x.data.number} — ${esc(x.data.title)} (${esc(x.data.status)})</option>`).join("")}</select></div>
          <div class="field" id="lkRfiF" hidden><label for="lkRfi">RFI</label><select id="lkRfi">${rfis.map(x => `<option value="${x.id}">#${x.data.number} — ${esc(x.data.subject)} (${esc(x.data.status)})</option>`).join("")}</select></div>`,
        onOpen: root => {
          root.addEventListener("change", () => {
            const v = $("input[name=lk]:checked", root).value;
            $("#lkPunchF", root).hidden = v !== "punch";
            $("#lkRfiF", root).hidden = v !== "rfi";
          });
        },
        onSave: root => {
          const v = $("input[name=lk]:checked", root).value;
          if (v === "punch") { addPin(pt, "punch", $("#lkPunch", root).value); return true; }
          if (v === "rfi") { addPin(pt, "rfi", $("#lkRfi", root).value); return true; }
          const sheet = g.data.number + (g.data.title ? " " + g.data.title : "");
          setTimeout(() => {
            if (v === "newpunch") PM.editPunch(p, null, { defaults: { reference: "Sheet " + g.data.number + " Rev " + rev.rev }, onCreated: rec => addPin(pt, "punch", rec.id) });
            else PM.editRFI(p, null, { defaults: { drawing: sheet + " (Rev " + rev.rev + ")" }, onCreated: rec => addPin(pt, "rfi", rec.id) });
          }, 0);
          return true;
        }
      });
    }

    // ── Pin popup
    function showPop(s) {
      const info = pinInfo(s);
      pop.innerHTML = `<div class="dv-pop-t"><strong>${esc(info.label)}</strong> ${info.status ? PM.pill(info.status) : ""}</div>
        <div class="dv-pop-b">${esc(info.title)}</div>
        <div class="dv-pop-a">${info.href ? `<a class="btn small primary" href="${info.href}">View ${s.link.type === "rfi" ? "RFI" : "punch item"}</a>` : ""}${isMine(s.id) ? `<button class="btn small danger" id="dvPopDel">Remove pin</button>` : ""}</div>`;
      Object.assign(pop.style, { left: s.x * V.zoom + 14 + "px", top: s.y * V.zoom + 14 + "px" });
      pop.hidden = false;
      const del = $("#dvPopDel", pop);
      if (del) del.onclick = deleteSelected;
    }
    function hidePop() { pop.hidden = true; }

    function focusPin(sid) {
      const v = visibleShapes().find(x => x.s.id === sid);
      if (!v) return;
      setZoom(Math.max(V.zoom, fitZoom() * 2.5));
      centerOn(v.s.x, v.s.y);
      V.selected = sid;
      draw();
      showPop(v.s);
      scheduleTile();
    }

    // ── Side panel
    function renderSide() {
      const side = $("#dvSide");
      if (!side) return;
      const pins = visibleShapes().filter(v => v.s.t === "pin");
      const otherRecs = others().filter(m => (m.data.shapes || []).some(s => s.published && s.t !== "pin"));
      const revs = (g.data.revisions || []).slice().reverse();
      side.innerHTML = `
        <div class="dv-sec"><h3>Linked Items (${pins.length})</h3>
          ${pins.length ? pins.map(v => { const i = pinInfo(v.s); return `<div class="dv-link" data-focus="${v.s.id}"><span class="dot" style="background:${i.color}"></span><strong>${esc(i.label)}</strong> ${esc(i.title)}</div>`; }).join("") : `<p class="muted">Use 📍 to pin RFIs or punch items to a spot on this sheet.</p>`}</div>
        <div class="dv-sec"><h3>Markups</h3>
          <div>Mine: ${V.mine.filter(s => s.t !== "pin").length} <span class="muted">(${V.mine.filter(s => !s.published).length} unpublished)</span></div>
          <label class="inline-check" style="margin-top:6px"><input type="checkbox" id="dvOthers" ${V.showOthers ? "checked" : ""}> Show others' published markups</label>
          ${otherRecs.map(m => `<div class="muted" style="font-size:13px">${esc(m.data.ownerName)}: ${(m.data.shapes || []).filter(s => s.published && s.t !== "pin").length}</div>`).join("")}
          <p class="muted" style="font-size:12px">Unpublished markups are only shown to you. Click Publish to share them with the project.</p></div>
        <div class="dv-sec"><h3>Revisions</h3>
          ${revs.map(r => `<div class="dv-rev ${r.id === rev.id ? "on" : ""}"><a href="#/p/${p.id}/drawings/${g.id}?rev=${r.id}">Rev ${esc(r.rev)}</a> <span class="muted">${esc(r.setName || "")} · ${PM.fmtDate(r.drawingDate || r.at)}</span>
            ${r.id === g.data.current ? PM.pill("Current") : `<button class="btn small" data-perm="drawings:admin" data-makecur="${r.id}">Make current</button>`}</div>`).join("")}</div>
        <div class="dv-sec"><h3>Sheet</h3>
          <div class="muted" style="font-size:13px">Discipline: ${esc(g.data.discipline || "—")}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <button class="btn small" id="dvEdit" data-perm="drawings:admin">Edit info</button>
            <button class="btn small" data-dl="${esc(rev.fileUrl)}" data-page="${rev.page}" data-name="${esc(g.data.number)}.pdf">Open PDF</button>
            <button class="btn small danger" id="dvDel" data-perm="drawings:admin">Delete sheet</button></div></div>
        ${historyHTML()}`;
      $$("[data-focus]", side).forEach(el => el.onclick = () => { document.body.classList.remove("dv-side-open"); focusPin(el.dataset.focus); });
      $("#dvOthers", side).onchange = e => { V.showOthers = e.target.checked; PM.lsSet("netpower_pm_show_others", V.showOthers); V.selected = null; hidePop(); draw(); renderSide(); };
      PM.applyPerms(side);
      $$("[data-makecur]", side).forEach(b => b.onclick = () => makeCurrent(b.dataset.makecur));
      if ($("#dvEdit", side)) $("#dvEdit", side).onclick = editInfo;
      if ($("#dvDel", side)) $("#dvDel", side).onclick = deleteSheet;
    }
    function historyHTML() {
      const h = (g.data.history || []).slice().reverse().slice(0, 15);
      return `<div class="dv-sec"><h3>History</h3><ul class="history">${h.map(x => `<li>${esc(x.text)} <span class="muted">· ${esc(x.by)} · ${PM.fmtDate(x.at)}</span></li>`).join("")}</ul></div>`;
    }

    async function makeCurrent(revId) {
      const target = (g.data.revisions || []).find(r => r.id === revId);
      const rec = PM.withHistory({ ...g, data: { ...g.data, current: revId } }, `Rev ${target.rev} made current`);
      try {
        if (revId === rev.id) rec.data.thumb = await renderThumb(V.page, 220);
        else { const d = await openPdf(target.fileUrl); rec.data.thumb = await renderThumb(await d.getPage(target.page), 220); }
      } catch (e) { /* keep old thumbnail */ }
      if (await PM.saveRec(rec, `Rev ${target.rev} is now current`)) PM.render();
    }

    function editInfo() {
      PM.openModal({
        title: "Edit Sheet " + g.data.number,
        body: `<div class="form-grid">
          <div class="field"><label for="eiNum">Sheet # <span class="req">*</span></label><input id="eiNum" value="${esc(g.data.number)}"></div>
          <div class="field"><label for="eiDisc">Discipline</label><select id="eiDisc">${DISCIPLINES.map(d => `<option ${d === g.data.discipline ? "selected" : ""}>${d}</option>`).join("")}</select></div>
          <div class="field full"><label for="eiTitle">Title</label><input id="eiTitle" value="${esc(g.data.title || "")}"></div></div>`,
        onSave: async root => {
          const number = $("#eiNum", root).value.trim().toUpperCase();
          if (!number) throw new Error("Sheet # is required");
          const dup = findByNumber(p, number);
          if (dup && dup.id !== g.id) throw new Error(`Sheet ${number} already exists — upload this as a revision instead`);
          const rec = PM.withHistory({ ...g, data: { ...g.data, number, title: $("#eiTitle", root).value.trim(), discipline: $("#eiDisc", root).value } }, "Sheet info edited");
          return PM.saveRec(rec, "Sheet updated");
        }
      });
    }

    async function deleteSheet() {
      if (!window.confirm(`Delete sheet ${g.data.number} with all ${(g.data.revisions || []).length} revision(s) and their markups? This cannot be undone.`)) return;
      try {
        V.dirty = false;
        clearTimeout(V.saveTimer);
        await deleteSheets(p, [g.id]);
        toast("Sheet deleted");
        location.hash = `#/p/${p.id}/drawings`;
      } catch (e) { toast("Delete failed: " + e.message, true); }
    }
  }

  PM.drawings = { log, viewer, linksPanel, detectSheet, disciplineFor, sheetsOf, currentRev };
  PM.files = { upload: uploadFile, readableUrl, fileObjectUrl, deleteFiles };
})();

// NetPower PM — jobsite photos: upload from phone or computer, albums, captions, daily log.
// Records: type "jphoto", ProjectID = project, Data = { url, thumb, name, caption, album, date, inLog, by, byUserId, byId, at, size }
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, uid, toast, Store } = PM;

  const THUMB = 420, FULL = 2400;  // pixels (longest side)
  function resize(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => (b ? resolve({ blob: b, dataUrl: null, w: c.width, h: c.height, canvas: c }) : reject(new Error("Could not read image"))), "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} isn't a photo this browser can read`)); };
      img.src = url;
    });
  }
  const today = () => PM.today();
  const fileDate = f => { const d = new Date(f.lastModified || Date.now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const photosOf = p => Store.all("jphoto", p.id).sort((a, b) => (b.data.date || "").localeCompare(a.data.date || "") || (b.data.at || "").localeCompare(a.data.at || ""));
  const myUserId = () => (PM.session ? PM.session.user.id : PM.me());
  const canEdit = (p, ph) => PM.can(p.id, "photos", "admin") || (PM.can(p.id, "photos", "standard") && ph.data.byUserId === myUserId());

  function page(p, query) {
    const all = photosOf(p);
    const f = PM.lsGet("netpower_pm_photofilter_" + p.id, { album: "", by: "", q: "" }) || {};
    const albums = [...new Set(all.map(x => x.data.album).filter(Boolean))].sort();
    const uploaders = [...new Set(all.map(x => x.data.by).filter(Boolean))].sort();
    const shown = all.filter(x => (!f.album || x.data.album === f.album) && (!f.by || x.data.by === f.by) &&
      (!f.q || [x.data.caption, x.data.name, x.data.album].join(" ").toLowerCase().includes(f.q.toLowerCase())));
    const byDate = {};
    shown.forEach(x => { (byDate[x.data.date || "Undated"] = byDate[x.data.date || "Undated"] || []).push(x); });
    setTimeout(() => {
      const up = $("#phUpload"); if (up) up.onclick = () => uploadModal(p);
      $$("[data-phf]").forEach(el => el.addEventListener(el.type === "search" ? "change" : "change", () => { f[el.dataset.phf] = el.value; PM.lsSet("netpower_pm_photofilter_" + p.id, f); PM.render(); }));
      $$("[data-photo]").forEach(el => el.onclick = () => lightbox(p, el.dataset.photo, shown.map(x => x.id)));
      if (query && query.get("open")) lightbox(p, query.get("open"), shown.map(x => x.id));
      if (query && query.get("upload") && PM.can(p.id, "photos", "standard")) uploadModal(p);
    }, 0);
    return `
      <div class="page-head"><h1>Photos</h1><div class="actions"><button class="btn primary" id="phUpload" data-perm="photos:standard">📷 Upload Photos</button></div></div>
      <div class="panel flush"><div class="toolbar">
        <input type="search" data-phf="q" placeholder="Search captions…" value="${esc(f.q || "")}">
        <select data-phf="album" aria-label="Album"><option value="">All albums</option>${albums.map(a => `<option ${f.album === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>
        <select data-phf="by" aria-label="Uploaded by"><option value="">Anyone</option>${uploaders.map(a => `<option ${f.by === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>
        <span class="muted">${shown.length} photo${shown.length === 1 ? "" : "s"}</span></div></div>
      ${Object.keys(byDate).length ? Object.entries(byDate).map(([date, list]) => `
        <div class="ph-day"><h3>${date === "Undated" ? "Undated" : PM.fmtDate(date)} <span class="muted">· ${list.length}</span>
          ${date !== "Undated" && PM.can(p.id, "dailylog") ? `<a class="muted" style="font-size:13px;font-weight:400" href="#/p/${p.id}/dailylog/${date}">Daily log</a>` : ""}</h3>
          <div class="ph-grid">${list.map(x => thumbHTML(x)).join("")}</div></div>`).join("")
        : `<div class="panel empty">No photos yet. Use “Upload Photos” — on a phone you can take pictures right from the camera.</div>`}`;
  }
  const thumbHTML = x => `<button class="ph-thumb" data-photo="${x.id}" title="${esc(x.data.caption || x.data.name || "")}">
      <img src="${esc(x.data.thumb || "")}" alt="${esc(x.data.caption || "Jobsite photo")}" loading="lazy">
      ${x.data.caption ? `<span class="ph-cap">${esc(x.data.caption)}</span>` : ""}${x.data.album ? `<span class="ph-album">${esc(x.data.album)}</span>` : ""}</button>`;

  function uploadModal(p, preset = {}) {
    const albums = [...new Set(photosOf(p).map(x => x.data.album).filter(Boolean))].sort();
    let files = [];
    PM.openModal({
      title: "Upload Photos",
      wide: true,
      saveLabel: "Upload",
      noRender: true,
      body: `
        <div class="dropzone" id="phDrop" tabindex="0" role="button" aria-label="Choose photos">
          <div style="font-size:28px">📷</div><div><strong>Take or choose photos</strong></div><div class="muted">or drag & drop them here</div>
          <input type="file" id="phFiles" accept="image/*" multiple hidden></div>
        <div class="ph-preview" id="phPreview"></div>
        <div class="form-grid">
          <div class="field"><label for="phAlbum">Album</label><input id="phAlbum" list="phAlbums" value="${esc(preset.album || "")}" placeholder="e.g. Rough-in, Level 2"><datalist id="phAlbums">${albums.map(a => `<option value="${esc(a)}">`).join("")}</datalist></div>
          <div class="field"><label for="phDate">Date taken</label><input type="date" id="phDate" value="${esc(preset.date || "")}"><div class="muted help">Blank = use each photo's own date.</div></div>
          <div class="field full"><label for="phCaption">Caption (applies to all)</label><div class="with-mic"><input id="phCaption" placeholder="What does this show?">${PM.forms && PM.forms.micBtn ? PM.forms.micBtn("phCaption") : ""}</div></div>
          <div class="field full"><label class="inline-check"><input type="checkbox" id="phInLog" ${PM.can(p.id, "dailylog") ? "checked" : ""}> Show these photos on the daily log for that date</label></div>
        </div>
        <div id="phProgress" class="muted"></div>`,
      onOpen: root => {
        const input = $("#phFiles", root), drop = $("#phDrop", root);
        const show = () => {
          $("#phPreview", root).innerHTML = files.map((f, i) => `<div class="ph-pv"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" class="btn small" data-rm="${i}" aria-label="Remove">✕</button></div>`).join("");
          $$("[data-rm]", root).forEach(b => b.onclick = () => { files.splice(Number(b.dataset.rm), 1); show(); });
        };
        const add = list => { files.push(...[...list].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name))); show(); };
        drop.onclick = () => input.click();
        drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
        input.onchange = () => { add(input.files); input.value = ""; };
        drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
        drop.addEventListener("dragleave", () => drop.classList.remove("over"));
        drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); add(e.dataTransfer.files); });
      },
      onSave: async root => {
        if (!files.length) { toast("Choose at least one photo", true); return false; }
        const album = $("#phAlbum", root).value.trim(), date = $("#phDate", root).value, caption = $("#phCaption", root).value.trim(), inLog = $("#phInLog", root).checked;
        const prog = $("#phProgress", root), btn = $("[data-save]", root);
        btn.disabled = true;
        const recs = [];
        try {
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            prog.textContent = `Uploading ${i + 1} of ${files.length}…`;
            const thumb = await resize(f, THUMB, 0.72);
            const full = await resize(f, FULL, 0.86);
            const name = f.name.replace(/\.[^.]+$/, "") + ".jpg";
            const url = await PM.files.upload(`attachments/${p.id}/photos`, new File([full.blob], name, { type: "image/jpeg" }), pct => { prog.textContent = `Uploading ${i + 1} of ${files.length}… ${Math.round(pct || 0)}%`; }, "image/jpeg");
            recs.push({ id: uid("ph"), type: "jphoto", projectId: p.id, data: {
              url, thumb: thumb.canvas.toDataURL("image/jpeg", 0.72), name: f.name, caption, album, date: date || fileDate(f), inLog,
              width: full.w, height: full.h, size: full.blob.size, by: PM.meName(), byUserId: myUserId(), byId: PM.me(), at: new Date().toISOString() } });
          }
          prog.textContent = "Saving…";
          await Store.saveMany(recs);
        } catch (e) {
          btn.disabled = false;
          prog.textContent = "";
          if (recs.length) PM.files.deleteFiles(recs.map(r => r.data.url)).catch(() => {});
          toast("Upload failed: " + e.message, true);
          return false;
        }
        toast(`${recs.length} photo${recs.length > 1 ? "s" : ""} uploaded`);
        setTimeout(() => PM.render(), 0);
        return true;
      }
    });
  }

  async function lightbox(p, id, ids) {
    const ph = Store.get(id);
    if (!ph) return;
    const d = ph.data, edit = canEdit(p, ph), idx = ids.indexOf(id);
    PM.openModal({
      title: d.caption || d.name || "Photo",
      wide: true,
      noRender: true,
      hideSave: !edit,
      body: `
        <div class="ph-big"><img id="phBig" src="${esc(d.thumb || "")}" alt="${esc(d.caption || "Photo")}">
          ${idx > 0 ? `<button class="ph-nav prev" data-go="${ids[idx - 1]}" aria-label="Previous photo">‹</button>` : ""}
          ${idx >= 0 && idx < ids.length - 1 ? `<button class="ph-nav next" data-go="${ids[idx + 1]}" aria-label="Next photo">›</button>` : ""}</div>
        <div class="muted" style="margin:8px 0">${esc(d.by || "")} · ${PM.fmtDate(d.date)} ${d.album ? "· " + esc(d.album) : ""} · <a href="#" data-dl="${esc(d.url)}" data-name="${esc(d.name || "photo.jpg")}">Download</a></div>
        ${edit ? `<div class="form-grid">
          <div class="field full"><label for="lbCap">Caption</label><input id="lbCap" value="${esc(d.caption || "")}"></div>
          <div class="field"><label for="lbAlbum">Album</label><input id="lbAlbum" value="${esc(d.album || "")}"></div>
          <div class="field"><label for="lbDate">Date taken</label><input type="date" id="lbDate" value="${esc(d.date || "")}"></div>
          <div class="field full"><label class="inline-check"><input type="checkbox" id="lbInLog" ${d.inLog ? "checked" : ""}> Show on the daily log</label></div></div>
          <button type="button" class="btn danger small" id="lbDelete">Delete photo</button>` : (d.caption ? `<p>${esc(d.caption)}</p>` : "")}`,
      onOpen: root => {
        PM.files.fileObjectUrl(d.url).then(u => { const img = $("#phBig", root); if (img) img.src = u; }).catch(() => {});
        $$("[data-go]", root).forEach(b => b.onclick = () => { PM.closeModal(); lightbox(p, b.dataset.go, ids); });
        const del = $("#lbDelete", root);
        if (del) del.onclick = async () => {
          if (!window.confirm("Delete this photo?")) return;
          try { await Store.remove(ph.id); PM.files.deleteFiles([d.url]).catch(() => {}); PM.closeModal(); PM.render(); toast("Photo deleted"); } catch (e) { toast("Not deleted: " + e.message, true); }
        };
      },
      onSave: async root => {
        const ok = await PM.saveRec({ ...ph, data: { ...d, caption: $("#lbCap", root).value.trim(), album: $("#lbAlbum", root).value.trim(), date: $("#lbDate", root).value, inLog: $("#lbInLog", root).checked } }, "Photo saved");
        if (ok) setTimeout(() => PM.render(), 0);
        return ok;
      }
    });
  }

  // Daily log: photos taken that day
  function dayPanel(p, date) {
    if (!PM.can(p.id, "photos")) return "";
    const list = photosOf(p).filter(x => x.data.date === date && x.data.inLog !== false);
    setTimeout(() => $$("[data-logphoto]").forEach(el => el.onclick = () => lightbox(p, el.dataset.logphoto, list.map(x => x.id))), 0);
    return `<div class="panel"><div class="section-head"><h2 style="margin:0">Photos</h2>
        <a class="btn small" data-perm="photos:standard" href="#/p/${p.id}/photos?upload=1">+ Add photos</a></div>
      ${list.length ? `<div class="ph-grid small">${list.map(x => `<button class="ph-thumb" data-logphoto="${x.id}" title="${esc(x.data.caption || "")}"><img src="${esc(x.data.thumb || "")}" alt="${esc(x.data.caption || "Jobsite photo")}" loading="lazy"></button>`).join("")}</div>`
        : `<p class="muted">No photos for this day.</p>`}</div>`;
  }

  PM.photos = { page, dayPanel, uploadModal };
})();

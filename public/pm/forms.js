/* NetPower PM — full-page RFI and Submittal forms (Procore layout), rich text editor,
 * attachments, people pickers, and the Specifications tool. */
(function () {
  "use strict";
  const PM = window.NetPowerPM;
  const { $, $$, esc, uid, toast, Store } = PM;

  // ───────────────────────── Rich text ─────────────────────────
  const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "P", "DIV", "BR", "UL", "OL", "LI", "A", "SPAN", "FONT", "BLOCKQUOTE"]);
  const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH", "LINK", "META", "BASE", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT"]);
  const STYLE_PROPS = /^(color|background-color|text-align|font-size|font-weight|font-style|text-decoration|text-decoration-line|margin-left|padding-left)$/;

  function cleanStyle(style) {
    return String(style || "").split(";").map(d => {
      const i = d.indexOf(":");
      if (i < 0) return "";
      const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
      return STYLE_PROPS.test(k) && /^[#(),.%\w\s-]+$/.test(v) && !/url|expression|javascript/i.test(v) ? `${k}: ${v}` : "";
    }).filter(Boolean).join("; ");
  }

  // Keeps only basic formatting; drops scripts, event handlers and anything else
  function sanitizeHTML(html) {
    const doc = new DOMParser().parseFromString(`<div>${String(html || "")}</div>`, "text/html");
    const root = doc.body.firstChild;
    (function walk(node) {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) continue;
        if (child.nodeType !== 1 || DROP_TAGS.has(child.tagName)) { child.remove(); continue; }
        walk(child);
        if (!ALLOWED_TAGS.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
        for (const attr of [...child.attributes]) {
          const n = attr.name.toLowerCase(), v = attr.value.trim();
          if (n === "href" && child.tagName === "A" && /^(https?:|mailto:)/i.test(v)) continue;
          if (n === "style") { const st = cleanStyle(v); if (st) { child.setAttribute("style", st); continue; } }
          if (child.tagName === "FONT" && ((n === "size" && /^[1-7]$/.test(v)) || (n === "color" && /^#?[0-9a-z]{1,20}$/i.test(v)))) continue;
          child.removeAttribute(attr.name);
        }
        if (child.tagName === "A") { child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
      }
    })(root);
    return root.innerHTML;
  }
  const plainText = html => { const d = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html"); return (d.body.textContent || "").replace(/\s+\n/g, "\n").trim(); };
  // Display stored rich text (or older plain-text values)
  const richHTML = (html, plain) => (html ? `<div class="rich">${sanitizeHTML(html)}</div>` : `<div class="prose">${esc(plain || "")}</div>`);

  const SIZES = [["1", "8pt"], ["2", "10pt"], ["3", "12pt"], ["4", "14pt"], ["5", "18pt"], ["6", "24pt"], ["7", "36pt"]];
  // ── Voice to text: the browser's speech recognition (Chrome, Edge, Safari; not Firefox)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let activeRec = null;
  // Mic button for any textarea / input / rich-text area: data-mic="<element id>"
  const micBtn = (targetId, cls = "mic-btn") => SR ? `<button type="button" class="${cls} mic" data-mic="${targetId}" title="Dictate — speak and it types for you" aria-label="Dictate" aria-pressed="false">🎤</button>` : "";
  function insertDictated(el, text) {
    if (!text) return;
    if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      if (!sel.rangeCount || !el.contains(sel.anchorNode)) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
      const before = sel.anchorNode && sel.anchorNode.textContent ? sel.anchorNode.textContent.slice(0, sel.anchorOffset) : "";
      document.execCommand("insertText", false, (before && !/\s$/.test(before) ? " " : "") + text);
    } else {
      const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
      const before = el.value.slice(0, start), add = (before && !/\s$/.test(before) ? " " : "") + text;
      el.value = before + add + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + add.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  function stopDictation() { if (activeRec) { const r = activeRec; activeRec = null; try { r.stop(); } catch (e) { /* already stopped */ } } }
  document.addEventListener("click", e => {
    const btn = e.target.closest && e.target.closest("[data-mic]");
    if (!btn || !SR) return;
    e.preventDefault();
    const was = activeRec && activeRec._btn;
    stopDictation();
    if (was === btn) return;
    const target = document.getElementById(btn.dataset.mic);
    if (!target) return;
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    rec._btn = btn;
    rec.onresult = ev => { for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) insertDictated(target, ev.results[i][0].transcript.trim()); };
    rec.onerror = ev => { if (ev.error !== "aborted" && ev.error !== "no-speech") PM.toast(ev.error === "not-allowed" ? "Microphone access is blocked — allow it from the icon in the browser's address bar" : "Voice input stopped (" + ev.error + ")", true); };
    rec.onend = () => { btn.classList.remove("listening"); btn.setAttribute("aria-pressed", "false"); btn.title = "Dictate — speak and it types for you"; if (activeRec === rec) activeRec = null; };
    btn.classList.add("listening"); btn.setAttribute("aria-pressed", "true"); btn.title = "Listening… click to stop";
    activeRec = rec;
    try { rec.start(); PM.toast("Listening… speak now. Click 🎤 again to stop."); } catch (err) { activeRec = null; btn.classList.remove("listening"); }
  });
  window.addEventListener("hashchange", stopDictation);

  function rteHTML(id, html, label) {
    const b = (cmd, title, icon, arg) => `<button type="button" class="rte-b" data-cmd="${cmd}" ${arg ? `data-arg="${arg}"` : ""} title="${title}" aria-label="${title}">${icon}</button>`;
    return `<div class="rte" data-rte="${id}">
      <div class="rte-bar" role="toolbar" aria-label="${esc(label)} formatting">
        ${b("bold", "Bold", "<b>B</b>")}${b("italic", "Italic", "<i>I</i>")}${b("underline", "Underline", "<u>U</u>")}${b("strikeThrough", "Strikethrough", "<s>S</s>")}<span class="rte-sep"></span>
        ${b("justifyLeft", "Align left", "⯇")}${b("justifyCenter", "Center", "≡")}${b("justifyRight", "Align right", "⯈")}<span class="rte-sep"></span>
        ${b("insertUnorderedList", "Bulleted list", "•≡")}${b("insertOrderedList", "Numbered list", "1≡")}${b("outdent", "Decrease indent", "⇤")}${b("indent", "Increase indent", "⇥")}<span class="rte-sep"></span>
        <select class="rte-size" aria-label="Font size">${SIZES.map(([v, l]) => `<option value="${v}" ${v === "3" ? "selected" : ""}>${l}</option>`).join("")}</select>
        <label class="rte-color" title="Text color"><span>A</span><input type="color" data-color="foreColor" value="#c62828" aria-label="Text color"></label>
        <label class="rte-color" title="Highlight"><span class="hl">✎</span><input type="color" data-color="hiliteColor" value="#fff176" aria-label="Highlight color"></label>
        ${b("createLink", "Insert link", "🔗")}<span class="rte-sep"></span>${b("undo", "Undo", "↶")}${b("redo", "Redo", "↷")}
        ${SR ? `<span class="rte-sep"></span>${micBtn(id, "rte-b")}` : ""}
      </div>
      <div class="rte-area" id="${id}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${esc(label)}">${sanitizeHTML(html)}</div>
    </div>`;
  }
  function wireRTE(root) {
    $$("[data-rte]", root).forEach(box => {
      const area = $(".rte-area", box);
      const exec = (cmd, arg) => { area.focus(); document.execCommand("styleWithCSS", false, true); document.execCommand(cmd, false, arg); };
      $$("[data-cmd]", box).forEach(btn => btn.addEventListener("mousedown", e => e.preventDefault()));
      $$("[data-cmd]", box).forEach(btn => btn.onclick = () => {
        if (btn.dataset.cmd === "createLink") {
          const url = window.prompt("Link address (https://…)", "https://");
          if (url && /^(https?:|mailto:)/i.test(url.trim())) exec("createLink", url.trim());
          return;
        }
        exec(btn.dataset.cmd, btn.dataset.arg);
      });
      $(".rte-size", box).onchange = e => exec("fontSize", e.target.value);
      $$("[data-color]", box).forEach(inp => inp.oninput = () => exec(inp.dataset.color, inp.value));
      // Pasted content is cleaned before it's inserted
      area.addEventListener("paste", e => {
        const html = e.clipboardData && e.clipboardData.getData("text/html");
        const text = e.clipboardData && e.clipboardData.getData("text/plain");
        e.preventDefault();
        if (html) document.execCommand("insertHTML", false, sanitizeHTML(html));
        else document.execCommand("insertText", false, text || "");
      });
    });
  }
  const readRTE = (root, id) => { const el = $("#" + id, root); const html = sanitizeHTML(el ? el.innerHTML : ""); return { html, text: plainText(html) }; };

  // ───────────────────────── Attachments ─────────────────────────
  const fmtSize = n => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  function attachHTML(id, files) {
    return `<div class="attach" data-attach="${id}">
      <div class="dropzone" tabindex="0" role="button" aria-label="Attach files">
        <div class="dz-icon">🖼</div><span class="btn">Attach Files</span><div class="muted">or Drag &amp; Drop</div>
        <input type="file" multiple hidden>
      </div>
      <ul class="attach-list"></ul>
      <input type="hidden" data-attach-value value="${esc(JSON.stringify(files || []))}">
    </div>`;
  }
  // tool = rfis | submittals | specs; uploads go straight to storage
  function wireAttach(root, p, tool, state) {
    $$("[data-attach]", root).forEach(box => {
      const hidden = $("[data-attach-value]", box), list = $(".attach-list", box), zone = $(".dropzone", box), input = $("input[type=file]", box);
      let files = JSON.parse(hidden.value || "[]");
      const draw = () => {
        hidden.value = JSON.stringify(files);
        list.innerHTML = files.map((f, i) => `<li>${f.uploading ? `<span class="muted">Uploading ${esc(f.name)}… ${f.pct || 0}%</span>` :
          `<a href="#" data-dl="${esc(f.url)}" data-name="${esc(f.name)}">📎 ${esc(f.name)}</a> <span class="muted">${fmtSize(f.size || 0)}</span>
           <button type="button" class="btn small" data-rm-file="${i}" aria-label="Remove ${esc(f.name)}">✕</button>`}</li>`).join("");
      };
      const add = async picked => {
        for (const file of picked) {
          const entry = { name: file.name, size: file.size, type: file.type, uploading: true, pct: 0 };
          files.push(entry); draw();
          try {
            entry.url = await PM.files.upload(`attachments/${p.id}/${tool}`, file, pct => { entry.pct = Math.round(pct); draw(); });
            delete entry.uploading; delete entry.pct;
            entry.by = PM.meName(); entry.at = new Date().toISOString();
            state.added.push(entry.url);
          } catch (e) {
            files = files.filter(f => f !== entry);
            toast("Upload failed: " + e.message, true);
          }
          draw();
        }
      };
      zone.onclick = () => input.click();
      zone.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
      input.onchange = () => { add([...input.files]); input.value = ""; };
      zone.ondragover = e => { e.preventDefault(); zone.classList.add("over"); };
      zone.ondragleave = () => zone.classList.remove("over");
      zone.ondrop = e => { e.preventDefault(); zone.classList.remove("over"); add([...e.dataTransfer.files]); };
      list.onclick = e => {
        const b = e.target.closest("[data-rm-file]");
        if (!b) return;
        const [f] = files.splice(Number(b.dataset.rmFile), 1);
        if (f && f.url) state.removed.push(f.url);
        draw();
      };
      draw();
    });
  }
  const readAttach = root => { const h = $("[data-attach-value]", root); return h ? JSON.parse(h.value || "[]").filter(f => f.url && !f.uploading) : []; };
  const uploadsBusy = root => { const h = $("[data-attach-value]", root); return h && JSON.parse(h.value || "[]").some(f => f.uploading); };
  // Photos show as pictures (on screen and when printed); other files as links
  const isImage = f => /^image\//.test(f.type || "") || /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name || "");
  function attachmentsView(files) {
    files = files || [];
    if (!files.length) return `<span class="muted">None</span>`;
    const imgs = files.filter(isImage), docs = files.filter(f => !isImage(f));
    return `${imgs.length ? `<div class="att-imgs">${imgs.map(f => `<figure><a href="#" data-dl="${esc(f.url)}" data-name="${esc(f.name)}"><img data-att-img="${esc(f.url)}" alt="${esc(f.name)}"></a><figcaption>${esc(f.name)}</figcaption></figure>`).join("")}</div>` : ""}
      ${docs.length ? `<ul class="attach-list">${docs.map(f => `<li><a href="#" data-dl="${esc(f.url)}" data-name="${esc(f.name)}">📎 ${esc(f.name)}</a> <span class="muted">${fmtSize(f.size || 0)}</span></li>`).join("")}</ul>` : ""}`;
  }
  // Load attachment pictures (private files need short-lived signed links)
  function hydrateImages(root) {
    $$("img[data-att-img]", root || document).forEach(img => {
      const url = img.dataset.attImg;
      img.removeAttribute("data-att-img");
      PM.files.fileObjectUrl(url).then(u => { img.src = u; }).catch(() => { img.alt = "Photo unavailable"; });
    });
  }

  // ───────────────────────── Pickers ─────────────────────────
  // Multi-select with removable chips: options = [{id, label}]
  function multiHTML(name, options, selected, placeholder) {
    return `<div class="multi" data-multi-pick="${name}">
      <div class="chips"></div>
      <select aria-label="${esc(placeholder)}"><option value="">${esc(placeholder)}</option></select>
      <input type="hidden" name="${name}" value="${esc(JSON.stringify(selected || []))}">
      <script type="application/json">${JSON.stringify(options).replace(/</g, "\\u003c")}</script>
    </div>`;
  }
  function wireMulti(root) {
    $$("[data-multi-pick]", root).forEach(box => {
      const opts = JSON.parse($("script", box).textContent);
      const hidden = $("input[type=hidden]", box), sel = $("select", box), chips = $(".chips", box);
      const draw = () => {
        const v = JSON.parse(hidden.value || "[]");
        chips.innerHTML = v.map(id => { const o = opts.find(x => x.id === id); return o ? `<span class="chip">${esc(o.label)}<button type="button" data-rm="${esc(id)}" aria-label="Remove ${esc(o.label)}">×</button></span>` : ""; }).join("");
        sel.innerHTML = `<option value="">${esc(sel.options[0].textContent)}</option>` + opts.filter(o => !v.includes(o.id)).map(o => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join("");
      };
      sel.onchange = () => { if (!sel.value) return; const v = JSON.parse(hidden.value || "[]"); v.push(sel.value); hidden.value = JSON.stringify(v); draw(); };
      chips.onclick = e => { const b = e.target.closest("[data-rm]"); if (!b) return; hidden.value = JSON.stringify(JSON.parse(hidden.value).filter(x => x !== b.dataset.rm)); draw(); };
      draw();
    });
  }
  const readMulti = (root, name) => JSON.parse(($(`input[name="${name}"]`, root) || { value: "[]" }).value || "[]");

  const peopleOptions = p => PM.projectContacts(p).map(c => ({ id: c.id, label: PM.contactLabel(c.id) }));
  const personSelect = (name, p, value, placeholder) => `<select name="${name}" id="f_${name}"><option value="">${esc(placeholder || "Select a person")}</option>${PM.projectContacts(p).map(c => `<option value="${c.id}" ${c.id === value ? "selected" : ""}>${esc(PM.contactLabel(c.id))}</option>`).join("")}</select>`;
  const vendorSelect = (name, value) => `<select name="${name}" id="f_${name}"><option value="">Select a vendor</option>${PM.companies().map(c => `<option value="${c.id}" ${c.id === value ? "selected" : ""}>${esc(c.data.name)}</option>`).join("")}</select>`;

  // Project lists (locations, packages, cost codes): pick one or type a new one
  const lookups = (p, kind) => Store.all("lookup", p.id).filter(l => l.data.kind === kind).map(l => l.data.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const comboHTML = (name, p, kind, value, placeholder) => `<input name="${name}" id="f_${name}" list="dl_${name}" value="${esc(value || "")}" placeholder="${esc(placeholder)}" autocomplete="off"><datalist id="dl_${name}">${lookups(p, kind).map(v => `<option value="${esc(v)}">`).join("")}</datalist>`;
  async function rememberLookups(p, pairs) {
    const recs = pairs.filter(([kind, v]) => v && !lookups(p, kind).some(x => x.toLowerCase() === v.toLowerCase()))
      .map(([kind, name]) => ({ id: uid("lk"), type: "lookup", projectId: p.id, data: { kind, name } }));
    if (recs.length) { try { await Store.saveMany(recs); } catch (e) { /* the item itself is saved; the list entry is a convenience */ } }
  }

  const field = (label, control, opts = {}) => `<div class="field ${opts.cls || ""}" ${opts.key ? `data-field="${opts.key}"` : ""}><label ${opts.for ? `for="${opts.for}"` : ""}>${esc(label)}${opts.req ? ' <span class="req">*</span>' : ""}</label>${control}<div class="field-err" role="alert"></div></div>`;
  const roField = (label, value) => `<div class="field ro"><label>${esc(label)}</label><div class="ro-v">${value || "--"}</div></div>`;
  const section = (title, body, open = true) => `<details class="fsec" ${open ? "open" : ""}><summary>${esc(title)}</summary><div class="fsec-body">${body}</div></details>`;

  function showErrors(root, errors) {
    $$(".field.has-err", root).forEach(f => { f.classList.remove("has-err"); $(".field-err", f).textContent = ""; });
    Object.entries(errors).forEach(([k, msg]) => {
      const f = $(`[data-field="${k}"]`, root);
      if (f) { f.classList.add("has-err"); $(".field-err", f).textContent = "⚠ " + msg; }
    });
    const first = $(".field.has-err", root);
    if (first) { first.scrollIntoView({ block: "center", behavior: "smooth" }); const i = $("input, select, [contenteditable]", first); if (i) i.focus(); }
    return !Object.keys(errors).length;
  }

  async function cleanupFiles(state, saved) {
    // After saving: delete files removed from the item. After cancelling: delete files uploaded but never saved.
    const urls = saved ? state.removed : state.added;
    if (urls.length) await PM.files.deleteFiles(urls);
  }

  // ───────────────────────── RFIs ─────────────────────────
  function rfiFormHTML(p, r, defaults) {
    const d = r ? r.data : { number: PM.nextNumber("rfi", p.id), due: PM.addDays(PM.today(), 7), managerId: PM.me() || p.data.pmId || "", ...(defaults || {}) };
    const isNew = !r;
    const bic = r ? PM.bicNames(PM.rfiBIC(r)) : "";
    return `
      ${section("Request", `<div class="fgrid-2">
        <div>
          ${field("Subject", `<div class="with-mic"><input name="subject" id="f_subject" value="${esc(d.subject || "")}">${micBtn("f_subject")}</div>`, { req: true, key: "subject", for: "f_subject" })}
          ${field("Question", rteHTML("f_question", d.questionHtml || esc(d.question || "").replace(/\n/g, "<br>"), "Question"), { req: true, key: "question" })}
        </div>
        <div>${field("Attachments", attachHTML("rfi", d.attachments))}</div>
      </div>`)}
      ${section("General Information", `<div class="fgrid-4">
        ${field("Number", `<input name="number" id="f_number" type="number" min="1" value="${esc(d.number)}">`, { req: true, key: "number", for: "f_number" })}
        ${field("Due Date", `<input name="due" id="f_due" type="date" value="${esc(d.due || "")}">`, { req: true, key: "due", for: "f_due" })}
        ${field("RFI Manager", personSelect("managerId", p, d.managerId), { req: true, key: "managerId", for: "f_managerId" })}
        ${roField("Status", isNew ? "" : PM.pill(d.status))}
        ${field("Assignees", multiHTML("assignees", peopleOptions(p), d.assignees, "Select a person"), { req: true, key: "assignees" })}
        ${field("Distribution List", multiHTML("distribution", peopleOptions(p), d.distribution, "Select a person"))}
        ${field("Responsible Contractor", vendorSelect("responsibleCompanyId", d.responsibleCompanyId), { for: "f_responsibleCompanyId" })}
        ${roField("Ball In Court", esc(bic))}
        ${field("Location", comboHTML("location", p, "location", d.location, "Select a Location"), { for: "f_location" })}
        ${field("Drawing Number", `<input name="drawing" id="f_drawing" value="${esc(d.drawing || "")}">`, { for: "f_drawing" })}
        ${field("Private", `<label class="inline-check"><input type="checkbox" name="private" ${d.private ? "checked" : ""}> Visible only to admins, the RFI manager, assignees and distribution list</label>`)}
        ${roField("Created By", esc(r ? d.createdBy || "" : ""))}
        <div></div><div></div><div></div>
        ${roField("Date Initiated", r ? PM.fmtDate(d.openedAt || d.createdAt) : "")}
      </div>`)}
      ${section("Additional Information", `<div class="fgrid-4">
        ${field("Received From", personSelect("receivedFromId", p, d.receivedFromId), { for: "f_receivedFromId" })}
        ${field("Spec Section", `<input name="specSection" id="f_specSection" value="${esc(d.specSection || "")}">`, { for: "f_specSection" })}
        ${field("Cost Impact", `<select name="costImpact" id="f_costImpact"><option></option>${["Yes", "No", "TBD", "N/A"].map(o => `<option ${d.costImpact === o ? "selected" : ""}>${o}</option>`).join("")}</select>`)}
        ${field("Cost Impact Amount ($)", `<input name="costAmount" type="number" step="any" value="${esc(d.costAmount ?? "")}">`)}
        ${field("Schedule Impact", `<select name="scheduleImpact"><option></option>${["Yes", "No", "TBD", "N/A"].map(o => `<option ${d.scheduleImpact === o ? "selected" : ""}>${o}</option>`).join("")}</select>`)}
        ${field("Schedule Impact (days)", `<input name="scheduleDays" type="number" value="${esc(d.scheduleDays ?? "")}">`)}
        <div class="field full">${field("Suggested Answer / Proposed Solution", `<textarea name="suggestion">${esc(d.suggestion || "")}</textarea>`)}</div>
      </div>`, !!(r && (d.costImpact || d.scheduleImpact || d.suggestion || d.receivedFromId)))}`;
  }

  function readRFI(root) {
    const v = n => { const el = $(`[name="${n}"]`, root); return el ? el.value.trim() : ""; };
    const q = readRTE(root, "f_question");
    return {
      subject: v("subject"), questionHtml: q.html, question: q.text, number: v("number") === "" ? "" : Number(v("number")), due: v("due"),
      managerId: v("managerId"), assignees: readMulti(root, "assignees"), distribution: readMulti(root, "distribution"),
      responsibleCompanyId: v("responsibleCompanyId"), location: v("location"), drawing: v("drawing"),
      private: !!($('[name="private"]', root) || {}).checked, receivedFromId: v("receivedFromId"), specSection: v("specSection"),
      costImpact: v("costImpact"), costAmount: v("costAmount") === "" ? "" : Number(v("costAmount")),
      scheduleImpact: v("scheduleImpact"), scheduleDays: v("scheduleDays") === "" ? "" : Number(v("scheduleDays")),
      suggestion: v("suggestion"), attachments: readAttach(root)
    };
  }

  function validateRFI(p, r, vals, opening) {
    const e = {};
    if (!vals.subject) e.subject = "Required Field";
    if (!vals.question) e.question = "Required Field";
    if (opening) {
      if (!vals.number || vals.number < 1) e.number = "Required Field";
      if (!vals.due) e.due = "Required Field";
      if (!vals.managerId) e.managerId = "Required Field";
      if (!vals.assignees.length) e.assignees = "Add at least one assignee";
    }
    if (vals.number && Store.all("rfi", p.id).some(x => x.id !== (r && r.id) && Number(x.data.number) === vals.number)) e.number = `RFI #${vals.number} already exists`;
    return e;
  }

  async function saveRFI(p, r, root, mode, state) {
    if (uploadsBusy(root)) { toast("Wait for attachments to finish uploading", true); return null; }
    const vals = readRFI(root);
    const opening = mode === "open" || (r && r.data.status !== "Draft");
    if (!showErrors(root, validateRFI(p, r, vals, opening))) return null;
    if (!vals.number) vals.number = PM.nextNumber("rfi", p.id);
    const now = new Date().toISOString();
    const rec = r
      ? PM.withHistory({ ...r, data: { ...r.data, ...vals } }, "Details edited")
      : PM.withHistory({ id: uid("rfi"), type: "rfi", projectId: p.id, data: { ...vals, status: mode === "open" ? "Open" : "Draft", responses: [], createdBy: PM.meName(), createdAt: now, ...(mode === "open" ? { openedAt: now } : {}) } },
        mode === "open" ? "Created and opened" : "Created as draft");
    if (!(await PM.saveRec(rec, r ? "RFI saved" : `RFI #${rec.data.number} created`))) return null;
    await cleanupFiles(state, true);
    rememberLookups(p, [["location", vals.location]]);
    return rec;
  }

  function rfiPage(p, r) {
    if (r && r.type !== "rfi") return `<div class="empty">RFI not found.</div>`;
    const state = { added: [], removed: [] };
    const back = r ? `#/p/${p.id}/rfis/${r.id}` : `#/p/${p.id}/rfis`;
    setTimeout(() => {
      const root = $("#formRoot");
      if (!root) return;
      wireAll(root, p, "rfis", state);
      const go = async mode => {
        const btns = $$(".form-foot button", root); btns.forEach(b => { b.disabled = true; });
        try { const rec = await saveRFI(p, r, root, mode, state); if (rec) { state.done = true; location.hash = `#/p/${p.id}/rfis/${rec.id}`; } }
        finally { btns.forEach(b => { b.disabled = false; }); }
      };
      $$("[data-submit]", root).forEach(b => b.onclick = () => go(b.dataset.submit));
      $("[data-cancel]", root).onclick = async () => { state.done = true; await cleanupFiles(state, false); location.hash = back; };
      PM.cleanup = () => { if (!state.done) cleanupFiles(state, false); };
    }, 0);
    return `<div id="formRoot" class="fpage">
      <div class="crumb"><a href="#/p/${p.id}/rfis">RFIs</a> / ${r ? "#" + esc(r.data.number) + " / Edit" : "New"}</div>
      <h1>${r ? `Edit RFI #${esc(r.data.number)}` : "New RFI"}</h1>
      ${rfiFormHTML(p, r)}
      <div class="form-foot"><span class="req-note">* required fields</span><span class="spacer"></span>
        <button type="button" class="btn" data-cancel>Cancel</button>
        ${r ? `<button type="button" class="btn primary" data-submit="save">Save</button>`
          : `<button type="button" class="btn" data-submit="draft">Create as Draft</button><button type="button" class="btn primary" data-submit="open">Create as Open</button>`}
      </div></div>`;
  }

  // Modal version (used when creating an RFI from a spot on a drawing)
  function rfiModal(p, opts = {}) {
    const state = { added: [], removed: [] };
    PM.openModal({
      title: "New RFI",
      wide: true,
      noRender: true,
      saveLabel: "Create as Open",
      body: `<div class="fmodal">${rfiFormHTML(p, null, opts.defaults)}</div>`,
      onOpen: root => {
        wireAll(root, p, "rfis", state);
        const draft = document.createElement("button");
        draft.className = "btn"; draft.textContent = "Create as Draft";
        draft.onclick = async () => { const rec = await saveRFI(p, null, root, "draft", state); if (rec) { PM.closeModal(); if (opts.onCreated) opts.onCreated(rec); } };
        $(".modal-foot", root).insertBefore(draft, $("[data-save]", root));
        $$("[data-close]", root).forEach(b => b.addEventListener("click", () => cleanupFiles(state, false)));
      },
      onSave: async root => {
        const rec = await saveRFI(p, null, root, "open", state);
        if (!rec) return false;
        if (opts.onCreated) setTimeout(() => opts.onCreated(rec), 0);
        return true;
      }
    });
  }

  // ───────────────────────── Submittals ─────────────────────────
  const specLabel = s => (s ? `${s.data.number} - ${s.data.title}` : "");
  const specsOf = p => Store.all("spec", p.id).sort((a, b) => String(a.data.number).localeCompare(String(b.data.number), undefined, { numeric: true }));

  function workflowRowHTML(p, w) {
    return `<tr data-wf-row>
      <td>${personSelect("wf_person", p, w.contactId, "Select an approver")}</td>
      <td><input type="date" name="wf_due" value="${esc(w.due || "")}" aria-label="Due date"></td>
      <td class="nowrap"><button type="button" class="btn small" data-wf-up aria-label="Move up">↑</button> <button type="button" class="btn small" data-wf-rm aria-label="Remove step">✕</button></td></tr>`;
  }

  function submittalFormHTML(p, s, revisionOf, defaults) {
    const src = revisionOf || s;
    const d = src ? { ...src.data } : { ...(defaults || {}), number: PM.nextNumber("submittal", p.id), revision: 0, status: "Open", managerId: PM.me() || p.data.pmId || "", issueDate: PM.today() };
    if (revisionOf) {
      d.revision = Math.max(...Store.all("submittal", p.id).filter(x => Number(x.data.number) === Number(revisionOf.data.number)).map(x => Number(x.data.revision) || 0)) + 1;
      d.status = "Open"; d.issueDate = PM.today(); d.received = ""; d.attachments = [];
      d.workflow = (revisionOf.data.workflow || []).map(w => ({ contactId: w.contactId, due: "", response: "Pending" }));
    }
    const isNew = !s;
    const bic = s ? PM.bicNames(PM.submittalBIC(s)) : "";
    const finalDue = (d.workflow || []).map(w => w.due).filter(Boolean).sort().pop() || d.due || "";
    const drawingOpts = PM.drawings && Store.all("drawing", p.id).length
      ? PM.drawings.sheetsOf(p).map(g => ({ id: g.id, label: g.data.number + (g.data.title ? " — " + g.data.title : "") })) : [];
    return `
      ${section("General Information", `
        ${field("Title", `<input name="title" id="f_title" value="${esc(d.title || "")}">`, { key: "title", for: "f_title", cls: "full" })}
        <div class="fgrid-4">
        ${field("Specification", `<select name="specId" id="f_specId"><option value="">Select a Specification</option>${specsOf(p).map(x => `<option value="${x.id}" ${x.id === d.specId ? "selected" : ""}>${esc(specLabel(x))}</option>`).join("")}</select>`, { for: "f_specId" })}
        ${field("Number & Revision", `<div class="numrev"><input name="number" type="number" min="1" value="${esc(d.number)}" aria-label="Number"><span>.</span><input name="revision" type="number" min="0" value="${esc(d.revision || 0)}" aria-label="Revision"></div>`, { req: true, key: "number" })}
        ${field("Submittal Type", `<select name="subType" id="f_subType"><option value="">Select a Type</option>${PM.SUB_TYPES.map(o => `<option ${d.subType === o ? "selected" : ""}>${o}</option>`).join("")}</select>`, { for: "f_subType" })}
        ${field("Submittal Package", packageSelectHTML(p, d.packageId, d.package), { for: "f_packageId" })}
        ${field("Responsible Contractor", vendorSelect("responsibleCompanyId", d.responsibleCompanyId), { for: "f_responsibleCompanyId" })}
        ${field("Received From", personSelect("receivedFromId", p, d.receivedFromId), { for: "f_receivedFromId" })}
        ${field("Submittal Manager", personSelect("managerId", p, d.managerId), { req: true, key: "managerId", for: "f_managerId" })}
        ${field("Status", `<select name="status" id="f_status">${PM.SUB_STATUSES.map(o => `<option ${d.status === o ? "selected" : ""}>${o}</option>`).join("")}</select>`, { req: true, key: "status", for: "f_status" })}
        ${field("Submit By", `<input type="date" name="submitBy" value="${esc(d.submitBy || "")}">`)}
        ${field("Received Date", `<input type="date" name="received" value="${esc(d.received || "")}">`)}
        ${field("Issue Date", `<input type="date" name="issueDate" value="${esc(d.issueDate || "")}">`)}
        ${roField("Final Due Date", finalDue ? PM.fmtDate(finalDue) : "")}
        ${field("Cost Code", comboHTML("costCode", p, "costcode", d.costCode, "Select a Cost Code"), { for: "f_costCode" })}
        ${field("Location", comboHTML("location", p, "location", d.location, "Select a Location"), { for: "f_location" })}
        ${field("Linked Drawings", drawingOpts.length ? multiHTML("linkedDrawings", drawingOpts, d.linkedDrawings, "Select drawings") : `<div class="ro-v">--</div>`)}
        ${field("Distribution List", multiHTML("distribution", peopleOptions(p), d.distribution, "Select a person"))}
        ${roField("Ball In Court", esc(bic))}
        ${field("Lead Time", `<div class="inline-check"><input type="number" name="leadTime" min="0" value="${esc(d.leadTime ?? "")}" style="width:90px" aria-label="Lead time in days"> day(s)</div>`)}
        ${field("Required On-Site Date", `<input type="date" name="requiredOnSite" value="${esc(d.requiredOnSite || "")}">`)}
        ${field("Private", `<label class="inline-check"><input type="checkbox" name="private" ${d.private ? "checked" : ""}> Visible only to admins, workflow, and distribution list members.</label>`)}
        </div>
        <div class="fgrid-2">
          ${field("Description", rteHTML("f_description", d.descriptionHtml || esc(d.description || "").replace(/\n/g, "<br>"), "Description"))}
          ${field("Attachments", attachHTML("sub", d.attachments))}
        </div>`)}
      ${section("Submittal Workflow", `
        <p class="muted" style="margin-top:0">Approvers review in this order. The Final Due Date is the last step's due date.</p>
        <table class="subtable wf-table"><thead><tr><th>Approver</th><th>Due Date</th><th></th></tr></thead>
          <tbody>${(d.workflow || []).map(w => workflowRowHTML(p, w)).join("")}</tbody></table>
        <button type="button" class="btn small" data-wf-add>+ Add Approver</button>`)}`;
  }

  function readSubmittal(root, prev) {
    const v = n => { const el = $(`[name="${n}"]`, root); return el ? el.value.trim() : ""; };
    const num = n => (v(n) === "" ? "" : Number(v(n)));
    const desc = readRTE(root, "f_description");
    const prevSteps = (prev && prev.workflow) || [];
    const workflow = $$("[data-wf-row]", root).map(tr => {
      const contactId = $('[name="wf_person"]', tr).value, due = $('[name="wf_due"]', tr).value;
      const old = prevSteps.find(w => w.contactId === contactId);
      return contactId ? { ...(old || { response: "Pending", comments: "", at: "" }), contactId, due } : null;
    }).filter(Boolean);
    return {
      title: v("title"), specId: v("specId"), number: num("number"), revision: num("revision") || 0, subType: v("subType"), packageId: v("packageId"), package: packageName(v("packageId")) || "",
      responsibleCompanyId: v("responsibleCompanyId"), receivedFromId: v("receivedFromId"), managerId: v("managerId"), status: v("status"),
      submitBy: v("submitBy"), received: v("received"), issueDate: v("issueDate"), costCode: v("costCode"), location: v("location"),
      linkedDrawings: readMulti(root, "linkedDrawings"), distribution: readMulti(root, "distribution"),
      leadTime: num("leadTime"), requiredOnSite: v("requiredOnSite"), private: !!($('[name="private"]', root) || {}).checked,
      descriptionHtml: desc.html, description: desc.text, attachments: readAttach(root), workflow,
      due: workflow.map(w => w.due).filter(Boolean).sort().pop() || ""
    };
  }

  async function saveSubmittal(p, s, root, state, revisionOf) {
    if (uploadsBusy(root)) { toast("Wait for attachments to finish uploading", true); return null; }
    const vals = readSubmittal(root, s && s.data);
    const e = {};
    if (!vals.number || vals.number < 1) e.number = "Required Field";
    if (!vals.managerId) e.managerId = "Required Field";
    if (!vals.status) e.status = "Required Field";
    if (vals.number && Store.all("submittal", p.id).some(x => x.id !== (s && s.id) && Number(x.data.number) === vals.number && Number(x.data.revision || 0) === vals.revision))
      e.number = `Submittal #${vals.number}.${vals.revision} already exists`;
    if (!showErrors(root, e)) return null;
    const spec = Store.get(vals.specId);
    vals.specSection = spec ? specLabel(spec) : "";
    let rec;
    if (s) {
      rec = PM.withHistory({ ...s, data: { ...s.data, ...vals } }, "Details edited");
    } else {
      rec = PM.withHistory({ id: uid("sub"), type: "submittal", projectId: p.id, data: { ...vals, createdBy: PM.meName(), createdAt: new Date().toISOString() } },
        revisionOf ? `Revision ${vals.revision} created` : "Created");
    }
    if (rec.data.workflow.length && !["Closed", "Draft"].includes(rec.data.status)) rec.data.status = PM.deriveSubStatus({ ...rec, data: { ...rec.data, status: rec.data.status === "Open" ? "Open" : rec.data.status } });
    if (revisionOf) {
      const old = PM.withHistory({ ...revisionOf, data: { ...revisionOf.data, status: "Closed", closedAt: new Date().toISOString() } }, `Closed — superseded by revision ${vals.revision}`);
      if (!(await PM.saveRec(old))) return null;
    }
    if (!(await PM.saveRec(rec, s ? "Submittal saved" : `Submittal #${rec.data.number}.${rec.data.revision} created`))) return null;
    await cleanupFiles(state, true);
    rememberLookups(p, [["location", vals.location], ["costcode", vals.costCode]]);
    return rec;
  }

  function submittalPage(p, s, query) {
    if (s && s.type !== "submittal") return `<div class="empty">Submittal not found.</div>`;
    const revisionOf = !s && query && query.get("revisionOf") ? Store.get(query.get("revisionOf")) : null;
    const state = { added: [], removed: [] };
    const back = s ? `#/p/${p.id}/submittals/${s.id}` : `#/p/${p.id}/submittals`;
    setTimeout(() => {
      const root = $("#formRoot");
      if (!root) return;
      wireAll(root, p, "submittals", state);
      wireWorkflow(root, p);
      wirePackageSelect(root, p);
      $("[data-submit]", root).onclick = async ev => {
        ev.target.disabled = true;
        try { const rec = await saveSubmittal(p, s, root, state, revisionOf); if (rec) { state.done = true; location.hash = `#/p/${p.id}/submittals/${rec.id}`; } }
        finally { ev.target.disabled = false; }
      };
      $("[data-cancel]", root).onclick = async () => { state.done = true; await cleanupFiles(state, false); location.hash = back; };
      PM.cleanup = () => { if (!state.done) cleanupFiles(state, false); };
    }, 0);
    const title = s ? `Edit Submittal #${esc(s.data.number)}.${esc(s.data.revision || 0)}` : revisionOf ? `New Revision of Submittal #${esc(revisionOf.data.number)}` : "New Submittal";
    return `<div id="formRoot" class="fpage">
      <div class="crumb"><a href="#/p/${p.id}/submittals">Submittals</a> / ${s ? "Edit" : "New"}</div>
      <h1>${title}</h1>
      ${submittalFormHTML(p, s, revisionOf, query && query.get("packageId") ? { packageId: query.get("packageId") } : null)}
      <div class="form-foot"><span class="req-note">* required fields</span><span class="spacer"></span>
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="button" class="btn primary" data-submit>${s ? "Save" : "Create"}</button>
      </div></div>`;
  }

  function wireWorkflow(root, p) {
    const body = $(".wf-table tbody", root);
    $("[data-wf-add]", root).onclick = () => body.insertAdjacentHTML("beforeend", workflowRowHTML(p, {}));
    body.onclick = e => {
      const tr = e.target.closest("tr");
      if (e.target.closest("[data-wf-rm]")) tr.remove();
      if (e.target.closest("[data-wf-up]") && tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling);
    };
  }

  function wireAll(root, p, tool, state) {
    wireRTE(root);
    wireMulti(root);
    wireAttach(root, p, tool, state);
  }

  // ───────────────────────── Specifications ─────────────────────────
  const division = n => String(n || "").replace(/\D/g, "").slice(0, 2);
  function specsPage(p, sub) {
    const all = specsOf(p);
    const q = (PM.lsGet("netpower_pm_spec_q", "") || "").toLowerCase();
    const list = all.filter(s => !q || [s.data.number, s.data.title, s.data.description].join(" ").toLowerCase().includes(q));
    const byDiv = {};
    list.forEach(s => { (byDiv[division(s.data.number) || "—"] = byDiv[division(s.data.number) || "—"] || []).push(s); });
    const used = id => Store.all("submittal", p.id).filter(x => x.data.specId === id).length;
    setTimeout(() => {
      const add = $("#specAdd");
      if (add) add.onclick = () => editSpec(p, null);
      $$("[data-spec-edit]").forEach(b => b.onclick = () => editSpec(p, Store.get(b.dataset.specEdit)));
      $$("[data-spec-del]").forEach(b => b.onclick = async () => {
        const s = Store.get(b.dataset.specDel);
        if (!window.confirm(`Delete spec section ${s.data.number} ${s.data.title}?`)) return;
        try { await Store.remove(s.id); await PM.files.deleteFiles((s.data.attachments || []).map(f => f.url)); toast("Deleted"); PM.render(); } catch (e) { toast("Delete failed: " + e.message, true); }
      });
      const search = $("#specSearch");
      if (search) search.oninput = () => { PM.lsSet("netpower_pm_spec_q", search.value); clearTimeout(search._t); search._t = setTimeout(() => { PM.render().then(() => { const s2 = $("#specSearch"); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } }); }, 250); };
    }, 0);
    return `
      <div class="page-head"><h1>Specifications</h1><span class="sub">${all.length} section${all.length === 1 ? "" : "s"}</span>
        <div class="actions"><button class="btn primary" id="specAdd" data-perm="specs:standard">+ Add Spec Section</button></div></div>
      <div class="panel flush">
        <div class="toolbar"><input type="search" id="specSearch" placeholder="Search number or title…" value="${esc(q)}" aria-label="Search specifications"></div>
        ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Number</th><th>Title</th><th>Description</th><th>Files</th><th>Submittals</th><th></th></tr></thead><tbody>
          ${Object.keys(byDiv).sort().map(dv => `<tr class="grp-row"><td colspan="6">Division ${esc(dv)}</td></tr>` + byDiv[dv].map(s => `<tr>
            <td class="nowrap"><strong>${esc(s.data.number)}</strong></td><td>${esc(s.data.title)}</td><td class="muted">${esc((s.data.description || "").slice(0, 140))}</td>
            <td>${(s.data.attachments || []).map(f => `<a href="#" data-dl="${esc(f.url)}" data-name="${esc(f.name)}" title="${esc(f.name)}">📎</a>`).join(" ")}</td>
            <td>${used(s.id) || ""}</td>
            <td class="nowrap"><button class="btn small" data-perm="specs:standard" data-spec-edit="${s.id}">Edit</button> <button class="btn small danger" data-perm="specs:admin" data-spec-del="${s.id}">Delete</button></td></tr>`).join("")).join("")}
        </tbody></table></div>` : `<div class="empty">${all.length ? "No sections match." : "No spec sections yet. Add the sections from your project manual (e.g. 26 05 19 – Low-Voltage Electrical Power Conductors and Cables) so Submittals can reference them."}</div>`}
      </div>`;
  }

  function editSpec(p, s) {
    const state = { added: [], removed: [] };
    const d = s ? s.data : {};
    PM.openModal({
      title: s ? "Edit Spec Section" : "Add Spec Section",
      wide: true,
      body: `<div class="fgrid-2">
          ${field("Section Number", `<input name="number" id="f_number" value="${esc(d.number || "")}" placeholder="26 05 19">`, { req: true, key: "number", for: "f_number" })}
          ${field("Title", `<input name="title" id="f_title" value="${esc(d.title || "")}" placeholder="Low-Voltage Electrical Power Conductors and Cables">`, { req: true, key: "title", for: "f_title" })}
          ${field("Description", `<textarea name="description">${esc(d.description || "")}</textarea>`, { cls: "full" })}
          ${field("Spec PDF / attachments", attachHTML("spec", d.attachments), { cls: "full" })}
        </div>`,
      onOpen: root => {
        wireAttach(root, p, "specs", state);
        $$("[data-close]", root).forEach(b => b.addEventListener("click", () => cleanupFiles(state, false)));
      },
      onSave: async root => {
        if (uploadsBusy(root)) throw new Error("Wait for attachments to finish uploading");
        const number = $('[name="number"]', root).value.trim(), title = $('[name="title"]', root).value.trim();
        const errs = {};
        if (!number) errs.number = "Required Field";
        if (!title) errs.title = "Required Field";
        if (number && specsOf(p).some(x => x.id !== (s && s.id) && x.data.number.replace(/\s/g, "") === number.replace(/\s/g, ""))) errs.number = "This section number already exists";
        if (!showErrors(root, errs)) return false;
        const vals = { number, title, description: $('[name="description"]', root).value.trim(), attachments: readAttach(root) };
        const rec = s ? PM.withHistory({ ...s, data: { ...s.data, ...vals } }, "Edited") : PM.withHistory({ id: uid("spec"), type: "spec", projectId: p.id, data: vals }, "Created");
        if (!(await PM.saveRec(rec, "Spec section saved"))) return false;
        await cleanupFiles(state, true);
        return true;
      }
    });
  }

  // ───────────────────────── Submittal packages (one per trade / scope) ─────────────────────────
  const packagesOf = p => Store.all("subpackage", p.id).sort((a, b) => String(a.data.trade || "").localeCompare(String(b.data.trade || "")) || String(a.data.number).localeCompare(String(b.data.number), undefined, { numeric: true }));
  const packageLabel = k => (k ? `${k.data.number ? k.data.number + " - " : ""}${k.data.title}` : "");
  const packageName = id => packageLabel(Store.get(id));
  function packageSelectHTML(p, value, legacy) {
    const list = packagesOf(p);
    const byTrade = {};
    list.forEach(k => { (byTrade[k.data.trade || "Other"] = byTrade[k.data.trade || "Other"] || []).push(k); });
    return `<div class="with-mic"><select name="packageId" id="f_packageId"><option value="">${legacy && !value ? esc(legacy) + " (old)" : "Select a Package"}</option>
      ${Object.entries(byTrade).map(([t, ks]) => `<optgroup label="${esc(t)}">${ks.map(k => `<option value="${k.id}" ${k.id === value ? "selected" : ""}>${esc(packageLabel(k))}</option>`).join("")}</optgroup>`).join("")}
      </select>${PM.can(p.id, "submittals", "standard") ? `<button type="button" class="btn small" data-new-package title="Create a package">+ New</button>` : ""}</div>`;
  }
  function wirePackageSelect(root, p) {
    const b = $("[data-new-package]", root);
    if (b) b.onclick = () => editPackage(p, null, rec => {
      const tmp = document.createElement("div");
      tmp.innerHTML = packageSelectHTML(p, rec.id);
      $("#f_packageId", root).replaceWith($("select", tmp));
    });
  }
  function nextPackageNumber(p) {
    const nums = packagesOf(p).map(k => parseInt(k.data.number, 10)).filter(n => !isNaN(n));
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  }
  function editPackage(p, k, after) {
    const d = k ? k.data : { number: nextPackageNumber(p), trade: "Electrical" };
    PM.openModal({
      title: k ? "Edit Submittal Package" : "New Submittal Package",
      noRender: true,
      body: `<div class="fgrid-2">
          ${field("Title", `<input name="title" id="pk_title" value="${esc(d.title || "")}" placeholder="e.g. Lighting Fixtures">`, { req: true, key: "title", for: "pk_title" })}
          ${field("Package #", `<input name="number" id="pk_number" value="${esc(d.number || "")}">`, { for: "pk_number" })}
          ${field("Trade", `<input name="trade" id="pk_trade" list="pk_trades" value="${esc(d.trade || "")}" placeholder="Select or type a trade"><datalist id="pk_trades">${PM.TRADES.map(t => `<option value="${esc(t)}">`).join("")}</datalist>`, { req: true, key: "trade", for: "pk_trade" })}
          ${field("Spec Section", `<select name="specId" id="pk_spec"><option value="">—</option>${specsOf(p).map(x => `<option value="${x.id}" ${x.id === d.specId ? "selected" : ""}>${esc(specLabel(x))}</option>`).join("")}</select>`, { for: "pk_spec" })}
        </div>
        ${field("Description", `<textarea name="description" id="pk_desc">${esc(d.description || "")}</textarea>`, { for: "pk_desc" })}`,
      onSave: async root => {
        const v = n => $(`[name="${n}"]`, root).value.trim();
        const vals = { title: v("title"), number: v("number"), trade: v("trade"), specId: v("specId"), description: v("description") };
        const errs = {};
        if (!vals.title) errs.title = "Required Field";
        if (!vals.trade) errs.trade = "Required Field";
        if (!showErrors(root, errs)) return false;
        const rec = k ? PM.withHistory({ ...k, data: { ...k.data, ...vals } }, "Package edited")
          : PM.withHistory({ id: uid("pkg"), type: "subpackage", projectId: p.id, data: { ...vals, createdBy: PM.meName(), createdAt: new Date().toISOString() } }, "Package created");
        if (!(await PM.saveRec(rec, k ? "Package saved" : "Package created"))) return false;
        if (after) setTimeout(() => after(rec), 0); else PM.render();
        return true;
      }
    });
  }
  // Packages tab: grouped by trade
  function packagesPage(p) {
    const subs = Store.all("submittal", p.id);
    const list = packagesOf(p);
    const byTrade = {};
    list.forEach(k => { (byTrade[k.data.trade || "Other"] = byTrade[k.data.trade || "Other"] || []).push(k); });
    const loose = subs.filter(x => !x.data.packageId || !Store.get(x.data.packageId)).length;
    setTimeout(() => { const b = $("#newPackage"); if (b) b.onclick = () => editPackage(p, null); }, 0);
    return `
      <div class="page-head"><h1>Submittals</h1>
        <div class="actions"><button class="btn" id="newPackage" data-perm="submittals:standard">+ Create Package</button><button class="btn primary" data-perm="submittals:standard" data-act="newSubmittal" data-project="${p.id}">+ Create Submittal</button></div></div>
      ${subTabs(p, "packages")}
      ${list.length ? Object.entries(byTrade).map(([trade, ks]) => `<div class="panel flush"><div class="trade-head">${esc(trade)} <span class="muted">· ${ks.length} package${ks.length > 1 ? "s" : ""}</span></div>
        <table class="list"><thead><tr><th>#</th><th>Package</th><th>Spec Section</th><th>Submittals</th><th>Open</th><th>Approved</th></tr></thead><tbody>
        ${ks.map(k => { const items = subs.filter(x => x.data.packageId === k.id); const appr = items.filter(x => ["Approved", "Approved as Noted"].includes(x.data.status)).length; const open = items.filter(x => ["Open", "Draft", "Revise and Resubmit"].includes(x.data.status)).length;
          return `<tr class="click" data-href="#/p/${p.id}/submittals/packages/${k.id}"><td>${esc(k.data.number || "")}</td><td><a href="#/p/${p.id}/submittals/packages/${k.id}">${esc(k.data.title)}</a></td><td>${esc(specLabel(Store.get(k.data.specId)))}</td><td>${items.length}</td><td>${open}</td><td>${appr}</td></tr>`; }).join("")}
        </tbody></table></div>`).join("")
        : `<div class="panel empty">No packages yet. Create one package per trade or scope (e.g. "Lighting Fixtures", "Fire Alarm Devices") and put its submittals inside.</div>`}
      ${loose ? `<p class="muted">${loose} submittal${loose > 1 ? "s are" : " is"} not in a package — open them and pick a package, or use "Add submittals" on a package.</p>` : ""}`;
  }
  function packageDetail(p, id) {
    const k = Store.get(id);
    if (!k || k.type !== "subpackage") return `<div class="empty">Package not found. <a href="#/p/${p.id}/submittals/packages">Back to packages</a></div>`;
    const items = Store.all("submittal", p.id).filter(x => x.data.packageId === k.id).sort((a, b) => a.data.number - b.data.number || a.data.revision - b.data.revision);
    const loose = Store.all("submittal", p.id).filter(x => x.data.packageId !== k.id);
    setTimeout(() => {
      const e = $("#pkEdit"); if (e) e.onclick = () => editPackage(p, k);
      const del = $("#pkDel"); if (del) del.onclick = async () => {
        if (!window.confirm(`Delete package "${k.data.title}"? Its ${items.length} submittal(s) stay, just without a package.`)) return;
        try {
          if (items.length) await Store.saveMany(items.map(x => PM.withHistory({ ...x, data: { ...x.data, packageId: "", package: "" } }, "Removed from deleted package")));
          await Store.remove(k.id);
          location.hash = `#/p/${p.id}/submittals/packages`;
        } catch (err) { PM.toast("Delete failed: " + err.message, true); }
      };
      const add = $("#pkAdd"); if (add) add.onclick = () => PM.openModal({
        title: "Add Submittals to Package",
        noRender: true,
        saveLabel: "Add",
        body: loose.length ? `<div class="checks">${loose.map(x => `<label><input type="checkbox" value="${x.id}"> #${esc(x.data.number)}.${esc(x.data.revision || 0)} ${esc(x.data.title || "")} <span class="muted">${x.data.packageId ? "(in " + esc(packageName(x.data.packageId)) + ")" : ""}</span></label>`).join("")}</div>` : `<p class="muted">All submittals are already in this package.</p>`,
        onSave: async root => {
          const ids = $$("input:checked", root).map(i => i.value);
          if (!ids.length) return true;
          try { await Store.saveMany(ids.map(i => Store.get(i)).map(x => PM.withHistory({ ...x, data: { ...x.data, packageId: k.id, package: packageLabel(k) } }, "Added to package " + packageLabel(k)))); }
          catch (err) { PM.toast("Not saved: " + err.message, true); return false; }
          PM.render();
          return true;
        }
      });
    }, 0);
    return `
      <div class="crumb"><a href="#/p/${p.id}/submittals">Submittals</a> / <a href="#/p/${p.id}/submittals/packages">Packages</a> / ${esc(k.data.number || "")}</div>
      <div class="page-head"><h1>Package ${esc(packageLabel(k))}</h1>
        <div class="actions">
          <a class="btn primary" data-perm="submittals:standard" href="#/p/${p.id}/submittals/new?packageId=${k.id}">+ Create Submittal in Package</a>
          <button class="btn" id="pkAdd" data-perm="submittals:standard">Add submittals</button>
          <button class="btn" id="pkEdit" data-perm="submittals:standard">Edit</button>
          <button class="btn danger" id="pkDel" data-perm="submittals:admin">Delete</button></div></div>
      <div class="panel"><div class="info-grid">
        <div><div class="k">Trade</div><div class="v">${esc(k.data.trade || "—")}</div></div>
        <div><div class="k">Spec Section</div><div class="v">${esc(specLabel(Store.get(k.data.specId))) || "—"}</div></div>
        <div><div class="k">Submittals</div><div class="v">${items.length}</div></div>
        <div><div class="k">Created</div><div class="v">${PM.fmtDate(k.data.createdAt)} ${esc(k.data.createdBy || "")}</div></div></div>
        ${k.data.description ? `<div class="prose" style="margin-top:10px">${esc(k.data.description)}</div>` : ""}</div>
      <div class="panel flush"><table class="list"><thead><tr><th>#</th><th>Title</th><th>Type</th><th>Status</th><th>Ball In Court</th><th>Due</th></tr></thead><tbody>
        ${items.map(x => `<tr class="click" data-href="#/p/${p.id}/submittals/${x.id}"><td><a href="#/p/${p.id}/submittals/${x.id}">#${esc(x.data.number)}.${esc(x.data.revision || 0)}</a></td><td>${esc(x.data.title)}</td><td>${esc(x.data.subType || "")}</td><td>${PM.pill(x.data.status)}</td><td>${esc(PM.bicNames(PM.submittalBIC(x)))}</td><td>${PM.fmtDate(x.data.due)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No submittals in this package yet.</td></tr>`}
      </tbody></table></div>`;
  }
  const subTabs = (p, on) => `<div class="tabs sub-tabs"><a href="#/p/${p.id}/submittals" class="${on === "items" ? "on" : ""}">Items</a><a href="#/p/${p.id}/submittals/packages" class="${on === "packages" ? "on" : ""}">Packages</a></div>`;

  PM.forms = { hydrateImages, isImage, rfiPage, rfiModal, submittalPage, specsPage, sanitizeHTML, richHTML, attachmentsView, specLabel, micBtn,
    packagesPage, packageDetail, packageName, packagesOf, subTabs, editPackage };
})();

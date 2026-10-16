// NetPower PM — people: profiles, manpower deployment, certifications, notifications, daily log reminders.
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, uid, toast, Store } = PM;

  // ───────────────────────── People (app users) ─────────────────────────
  let peopleCache = null, peopleAt = 0;
  async function loadPeople(force) {
    if (Store.mode === "local") {  // demo mode has no logins: use the directory's people
      await Store.load("contact");
      return Store.all("contact").map(c => ({ id: c.id, name: c.data.name, photo: c.data.photo || "", trade: c.data.title || "", contactId: c.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    if (!force && peopleCache && Date.now() - peopleAt < 20000) return peopleCache;
    const d = await PM.api("/api/pm?action=people");
    peopleCache = d.people.sort((a, b) => a.name.localeCompare(b.name));
    peopleAt = Date.now();
    return peopleCache;
  }
  const personById = (list, id) => list.find(x => x.id === id) || { id, name: "Former user", photo: "" };
  const initials = n => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  const hue = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  function avatar(person, size = 32) {
    const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
    return person.photo
      ? `<img class="av" src="${esc(person.photo)}" alt="" style="${st}">`
      : `<span class="av av-i" style="${st};background:hsl(${hue(person.id || person.name)},45%,45%)" aria-hidden="true">${esc(initials(person.name))}</span>`;
  }

  // Profile photo: crop to a square and shrink in the browser (stored with the user)
  function photoToDataURL(file, size = 256) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(img.width, img.height), c = document.createElement("canvas");
        c.width = c.height = size;
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image")); };
      img.src = url;
    });
  }
  // Fields shared by Users → Edit and My Profile
  function profileFieldsHTML(u) {
    u = u || {};
    return `<div class="profile-row">
        <div class="profile-photo">${avatar({ id: u.id || "new", name: u.name || "?", photo: u.photo }, 72)}
          <label class="btn small">Photo<input type="file" accept="image/*" id="pfPhoto" hidden></label>
          <button type="button" class="btn small" id="pfPhotoClear" ${u.photo ? "" : "hidden"}>Remove</button>
          <input type="hidden" id="pfPhotoData" value="${esc(u.photo || "")}"></div>
        <div class="form-grid" style="flex:1">
          <div class="field"><label for="pfTrade">Trade / position</label><input id="pfTrade" list="pfTrades" value="${esc(u.trade || "")}" placeholder="e.g. Journeyman Electrician"><datalist id="pfTrades">${["Foreman", "General Foreman", "Journeyman Electrician", "Apprentice", "Low Voltage Tech", "Fire Alarm Tech", "Project Manager", "Superintendent", "Laborer"].map(t => `<option value="${t}">`).join("")}</datalist></div>
          <div class="field"><label for="pfPhone">Mobile phone</label><input id="pfPhone" type="tel" value="${esc(u.phone || "")}" placeholder="+1 555 123 4567"></div>
        </div></div>`;
  }
  function wireProfileFields(root) {
    const inp = $("#pfPhoto", root), hid = $("#pfPhotoData", root), box = $(".profile-photo", root), clr = $("#pfPhotoClear", root);
    if (!inp) return;
    const show = src => { const old = $(".av", box); old.outerHTML = avatar({ id: "x", name: "?", photo: src }, 72); clr.hidden = !src; };
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try { hid.value = await photoToDataURL(f); show(hid.value); } catch (e) { toast(e.message, true); }
    };
    clr.onclick = () => { hid.value = ""; show(""); };
  }
  const readProfile = root => ({ photo: $("#pfPhotoData", root).value, trade: $("#pfTrade", root).value.trim(), phone: $("#pfPhone", root).value.trim() });

  function myProfile() {
    const u = PM.session.user;
    PM.openModal({
      title: "My Profile",
      noRender: true,
      body: profileFieldsHTML(u) + `<p class="muted" style="font-size:12px">Your photo and trade show on the manpower board. Your phone number is only visible to company admins.</p>`,
      onOpen: wireProfileFields,
      onSave: async root => {
        const d = await PM.api("/api/pm?action=saveProfile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(readProfile(root)) });
        PM.session.user = d.user;
        peopleCache = null;
        toast("Profile saved");
        PM.render();
        return true;
      }
    });
  }

  // ───────────────────────── Dates ─────────────────────────
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parse = s => new Date(s + "T12:00:00");
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const mondayOf = s => { const d = parse(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return iso(d); };
  const dayLabel = s => parse(s).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
  const overlaps = (dep, s, e) => dep.data.start <= e && dep.data.end >= s;

  // ───────────────────────── Manpower page ─────────────────────────
  const canManpower = () => PM.isCompanyAdmin() || (PM.session && Object.values(PM.session.perms || {}).some(t => t.manpower && t.manpower !== "none"));
  const boardProjects = () => Store.all("project").filter(p => !["Completed", "Archived"].includes(p.data.status) && PM.can(p.id, "manpower"))
    .sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));

  async function page(tab, query) {
    const tabs = `<div class="tabs"><a href="#/manpower" class="${!tab ? "on" : ""}">Deployment</a><a href="#/manpower/chart" class="${tab === "chart" ? "on" : ""}">Manpower Chart</a><a href="#/manpower/certs" class="${tab === "certs" ? "on" : ""}">Certifications</a></div>`;
    if (tab === "certs") return certsPage(tabs);
    if (!canManpower()) return `<div class="empty">You don't have access to manpower. Ask a company admin if you need it.</div>${tabs}`;
    if (tab === "chart") return chart(tabs, query);
    return board(tabs, query);
  }

  async function board(tabs, query) {
    await Store.load("deploy");
    const people = await loadPeople();
    const week = mondayOf(query.get("week") || PM.lsGet("netpower_pm_week", "") || iso(new Date()));
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(week, i));
    const end = days[6];
    const deps = Store.all("deploy").filter(d => overlaps(d, week, end));
    const projects = boardProjects();
    const todayS = iso(new Date());
    const daysOf = (userId) => days.filter(day => deps.some(d => d.data.userId === userId && overlaps(d, day, day)));
    const conflict = (userId, day) => deps.filter(d => d.data.userId === userId && overlaps(d, day, day)).length > 1;

    setTimeout(() => wireBoard(people, week), 0);
    return `
      <div class="page-head"><h1>Manpower</h1>
        <div class="actions">
          <a class="btn" href="#/manpower?week=${addDays(week, -7)}">‹ Prev week</a>
          <a class="btn" href="#/manpower?week=${mondayOf(todayS)}">This week</a>
          <a class="btn" href="#/manpower?week=${addDays(week, 7)}">Next week ›</a>
          <button class="btn" id="mpCopyWeek" ${projects.some(p => PM.can(p.id, "manpower", "standard")) ? "" : "hidden"}>Copy last week</button>
        </div></div>
      ${tabs}
      <p class="muted" style="margin-top:0">Drag a person onto a project and day to deploy them. Drag someone from one project to another to shift them. Click a name to change dates or remove.</p>
      <div class="mp">
        <aside class="mp-crew panel">
          <h2>Crew</h2>
          <input type="search" id="mpSearch" placeholder="Search people…">
          <label class="inline-check" style="margin:6px 0"><input type="checkbox" id="mpFree"> Only people with open days</label>
          <div class="mp-multi"><span class="muted" id="mpSelN">Tick people to deploy several at once</span><button class="btn small primary" id="mpSelGo" hidden>Deploy selected</button><button class="btn small" id="mpSelClear" hidden>Clear</button></div>
          <div id="mpCrewList">${people.map(u => { const n = daysOf(u.id).filter(d => parse(d).getDay() % 6 !== 0).length;
            return `<div class="mp-person" draggable="true" data-user="${u.id}" data-name="${esc(u.name.toLowerCase())}" data-free="${n < 5 ? 1 : 0}" title="${esc(u.name)}${u.trade ? " — " + esc(u.trade) : ""}">
              <input type="checkbox" class="mp-sel" value="${u.id}" aria-label="Select ${esc(u.name)}">${avatar(u, 34)}<div class="mp-pn"><strong>${esc(u.name)}</strong><span class="muted">${esc(u.trade || "")}</span></div>
              <span class="mp-days ${n >= 5 ? "full" : n ? "part" : ""}" title="Weekdays deployed this week">${n}/5</span>
              ${u.certAlert ? `<span class="mp-cert ${u.certAlert}" title="Certification ${u.certAlert}">!</span>` : ""}</div>`; }).join("") || `<p class="muted">No people yet. Company admins add people under Users.</p>`}</div>
        </aside>
        <div class="mp-board panel flush">
          <div class="table-wrap"><table class="mp-table"><thead><tr><th class="mp-proj">Project</th>${days.map(d => `<th class="${d === todayS ? "today" : ""} ${[0, 6].includes(parse(d).getDay()) ? "wkend" : ""}">${dayLabel(d)}</th>`).join("")}</tr></thead>
          <tbody>${projects.map(p => { const edit = PM.can(p.id, "manpower", "standard");
            return `<tr><th class="mp-proj"><a href="#/p/${p.id}">${esc(p.data.name)}</a><div class="muted">${esc(p.data.number || "")}</div></th>
            ${days.map(day => { const here = deps.filter(d => d.projectId === p.id && overlaps(d, day, day));
              return `<td class="mp-cell ${day === todayS ? "today" : ""} ${[0, 6].includes(parse(day).getDay()) ? "wkend" : ""}" ${edit ? `data-drop="${p.id}" data-day="${day}"` : ""}>
                ${here.map(d => { const u = personById(people, d.data.userId); return `<div class="mp-chip ${conflict(u.id, day) ? "conflict" : ""}" ${edit ? `draggable="true" data-dep="${d.id}"` : ""} data-open="${d.id}" data-day="${day}" title="${esc(u.name)}: ${PM.fmtDate(d.data.start)} – ${PM.fmtDate(d.data.end)}${conflict(u.id, day) ? " — double-booked!" : ""}${d.data.note ? " — " + esc(d.data.note) : ""}">${avatar(u, 22)}<span>${esc(u.name.split(" ")[0])}</span>${edit ? `<button type="button" class="mp-x" data-rmday="${d.id}" data-day="${day}" title="Remove ${esc(u.name)} for ${dayLabel(day)} only" aria-label="Remove ${esc(u.name)} for ${dayLabel(day)}">✕</button>` : ""}</div>`; }).join("")}
                ${edit && here.length > 1 ? `<button class="mp-add mp-rm" data-rmmany="${p.id}" data-day="${day}" title="Remove several people from this day" aria-label="Remove several people">−</button>` : ""}
                ${edit ? `<button class="mp-add" data-add="${p.id}" data-day="${day}" title="Deploy someone here" aria-label="Deploy someone to ${esc(p.data.name)} on ${dayLabel(day)}">+</button>` : ""}</td>`; }).join("")}</tr>`; }).join("")
            || `<tr><td colspan="8" class="empty">No active projects you can staff.</td></tr>`}</tbody>
          <tfoot><tr><th class="mp-proj">Deployed</th>${days.map(day => `<td class="mp-total">${new Set(deps.filter(d => overlaps(d, day, day)).map(d => d.data.userId)).size}</td>`).join("")}</tr></tfoot></table></div>
        </div>
      </div>`;
  }

  const selected = () => $$("#mpCrewList .mp-sel:checked").map(c => c.value);
  function wireBoard(people, week) {
    PM.lsSet("netpower_pm_week", week);
    const list = $("#mpCrewList");
    if (!list) return;
    const filter = () => {
      const q = $("#mpSearch").value.trim().toLowerCase(), free = $("#mpFree").checked;
      $$(".mp-person", list).forEach(el => { el.hidden = (q && !el.dataset.name.includes(q)) || (free && el.dataset.free !== "1"); });
    };
    $("#mpSearch").oninput = filter;
    $("#mpFree").onchange = filter;
    let drag = null;
    document.querySelectorAll("[draggable=true][data-user], [draggable=true][data-dep]").forEach(el => {
      el.addEventListener("dragstart", e => {
        // dragging a ticked person carries everyone who is ticked
        const sel = selected();
        drag = el.dataset.user ? { users: sel.includes(el.dataset.user) ? sel : [el.dataset.user] } : { dep: el.dataset.dep };
        e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", el.dataset.user || el.dataset.dep);
      });
      el.addEventListener("dragend", () => { drag = null; $$(".mp-cell.over").forEach(c => c.classList.remove("over")); });
    });
    $$("[data-drop]").forEach(cell => {
      cell.addEventListener("dragover", e => { if (drag) { e.preventDefault(); cell.classList.add("over"); } });
      cell.addEventListener("dragleave", () => cell.classList.remove("over"));
      cell.addEventListener("drop", e => {
        e.preventDefault();
        cell.classList.remove("over");
        if (!drag) return;
        const d = drag; drag = null;
        if (d.users) assignModal(people, d.users, cell.dataset.drop, cell.dataset.day);
        else moveModal(people, Store.get(d.dep), cell.dataset.drop, cell.dataset.day);
      });
    });
    $$("[data-add]").forEach(b => b.onclick = () => assignModal(people, selected(), b.dataset.add, b.dataset.day));
    $$("[data-rmmany]").forEach(b => b.onclick = () => removeManyModal(people, b.dataset.rmmany, b.dataset.day));
    const syncSel = () => {
      const n = selected().length;
      $("#mpSelN").textContent = n ? `${n} selected — drag one of them onto a job/day, or:` : "Tick people to deploy several at once";
      $("#mpSelGo").hidden = $("#mpSelClear").hidden = !n;
    };
    list.addEventListener("change", e => { if (e.target.classList.contains("mp-sel")) syncSel(); });
    $("#mpSelClear").onclick = () => { $$(".mp-sel", list).forEach(c => { c.checked = false; }); syncSel(); };
    $("#mpSelGo").onclick = () => {
      const projects = boardProjects().filter(p => PM.can(p.id, "manpower", "standard"));
      if (!projects.length) return;
      PM.openModal({ title: "Deploy selected to…", noRender: true, saveLabel: "Next",
        body: `<div class="field"><label for="mpSelProj">Job</label><select id="mpSelProj">${projects.map(p => `<option value="${p.id}">${esc(p.data.name)}</option>`).join("")}</select></div>`,
        onSave: root => { const pid = $("#mpSelProj", root).value; setTimeout(() => assignModal(people, selected(), pid, PM.lsGet("netpower_pm_week", "") || iso(new Date())), 0); return true; } });
    };
    $$("[data-open]").forEach(c => c.onclick = e => {
      const x = e.target.closest("[data-rmday]");
      if (x) { e.stopPropagation(); removeDays(Store.get(x.dataset.rmday), x.dataset.day, x.dataset.day, people); return; }
      editDeployment(people, Store.get(c.dataset.open), c.dataset.day);
    });
    const copy = $("#mpCopyWeek");
    if (copy) copy.onclick = () => copyLastWeek(week);
  }

  // ───────────────────────── Manpower chart ─────────────────────────
  // Like the office spreadsheet: jobs × (this week's days, next week's days, 2 later weeks, 4 months).
  // Day cells = guys deployed (or a typed number that overrides it); later weeks/months = typed numbers.
  // Click a day cell to see / change the individual guys. Typed numbers live in one "mpplan" record per job.
  const MP_SET = "set_manpower";
  let chartOpen = "";   // "projectId|day" of the expanded cell
  const planId = pid => "mpp_" + pid;
  const plan = pid => { const r = Store.get(planId(pid)); return { days: {}, weeks: {}, months: {}, ...(r ? r.data : {}) }; };
  const monthKey = s => s.slice(0, 7);
  const monthLabel = k => `${new Date(k + "-15T12:00:00").toLocaleDateString(undefined, { month: "short" }).toUpperCase()}<small>${k.slice(0, 4)}</small>`;
  async function savePlan(pid, part, key, val) {
    const cur = Store.get(planId(pid)), d = plan(pid);
    const next = { ...d[part] };
    if (val === "" || val == null || !Number.isFinite(Number(val))) delete next[key]; else next[key] = Math.max(0, Math.min(999, Math.round(Number(val))));
    const rec = { id: planId(pid), type: "mpplan", projectId: pid, data: { ...(cur ? cur.data : {}), [part]: next, updatedBy: PM.meName(), updatedAt: new Date().toISOString() } };
    try { await Store.save(rec); return true; } catch (e) { toast("Not saved: " + e.message, true); return false; }
  }

  async function chart(tabs, query) {
    await Promise.all([Store.load("deploy"), Store.load("mpplan"), Store.load("setting")]);
    const people = await loadPeople();
    const todayS = iso(new Date());
    const week = mondayOf(query.get("week") || todayS);
    const dayCols = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11].map(i => addDays(week, i));
    const weekCols = [14, 21].map(i => addDays(week, i));
    // the 4 months after the month of the last week column (like the office sheet: …, 18th, 25th, NOV, DEC, JAN, FEB)
    const monthCols = [0, 1, 2, 3].map(i => { const d = parse(addDays(weekCols[1], 7)); d.setDate(1); d.setMonth(d.getMonth() + i); return monthKey(iso(d)); });
    const projects = boardProjects();
    const deps = Store.all("deploy");
    const guys = (pid, s, e) => deps.filter(d => d.projectId === pid && overlaps(d, s, e));
    const dayCount = (pid, day) => new Set(guys(pid, day, day).map(d => d.data.userId)).size;
    const weekMax = (pid, mon) => Math.max(0, ...[0, 1, 2, 3, 4].map(i => dayCount(pid, addDays(mon, i))));
    const setting = Store.get(MP_SET);
    const headcount = setting && setting.data.headcount != null && setting.data.headcount !== "" ? Number(setting.data.headcount) : people.length;
    // value shown per cell: typed number wins; days fall back to who's deployed
    const val = (p, kind, key) => {
      const pl = plan(p.id);
      if (kind === "day") return pl.days[key] != null ? { n: pl.days[key], typed: true, actual: dayCount(p.id, key) } : { n: dayCount(p.id, key), typed: false };
      if (kind === "week") return pl.weeks[key] != null ? { n: pl.weeks[key], typed: true } : { n: weekMax(p.id, key), typed: false, hint: true };
      return pl.months[key] != null ? { n: pl.months[key], typed: true } : { n: 0, typed: false, hint: true };
    };
    const cols = [...dayCols.map(k => ["day", k]), ...weekCols.map(k => ["week", k]), ...monthCols.map(k => ["month", k])];
    const totals = cols.map(([kind, key]) => projects.reduce((s, p) => s + (val(p, kind, key).n || 0), 0));
    const open = chartOpen.split("|");

    setTimeout(() => wireChart(people, projects), 0);
    const head = (kind, key) => kind === "day" ? `${parse(key).toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()}<small>${parse(key).getMonth() + 1}/${parse(key).getDate()}</small>`
      : kind === "week" ? `WEEK<small>${parse(key).getMonth() + 1}/${parse(key).getDate()}</small>` : monthLabel(key);
    const cellHTML = (p, kind, key, edit) => {
      const v = val(p, kind, key);
      const cls = `mc-${kind} ${key === todayS ? "today" : ""} ${kind === "day" && key === dayCols[4] ? "wk-end" : ""}`;
      if (kind === "day") return `<td class="${cls} mc-click ${open[0] === p.id && open[1] === key ? "open" : ""} ${v.typed ? "typed" : ""}" data-mc="${p.id}|${key}" title="${v.typed ? `Typed number (deployed: ${v.actual})` : "Guys deployed"} — click to see who">${v.n || ""}</td>`;
      if (!edit) return `<td class="${cls}">${v.typed ? v.n : v.n ? `<span class="muted">${v.n}</span>` : ""}</td>`;
      return `<td class="${cls}"><input class="mc-in" type="number" min="0" max="999" inputmode="numeric" data-plan="${p.id}|${kind === "week" ? "weeks" : "months"}|${key}" value="${v.typed ? v.n : ""}" placeholder="${v.hint && v.n ? v.n : ""}" aria-label="${esc(p.data.name)} ${kind} ${key}"></td>`;
    };
    const expandRow = p => {
      if (open[0] !== p.id) return "";
      const day = open[1], here = guys(p.id, day, day), edit = PM.can(p.id, "manpower", "standard"), pl = plan(p.id);
      return `<tr class="mc-expand"><td colspan="${cols.length + 1}"><div class="mc-x">
        <div class="mc-x-head"><strong>${esc(p.data.name)} · ${esc(parse(day).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }))}</strong>
          <span class="muted">${here.length} deployed</span><span class="spacer"></span><button class="btn small" data-mc-close>Close</button></div>
        <div class="mc-guys">${here.map(d => { const u = personById(people, d.data.userId); return `<div class="mc-guy">${edit ? `<input type="checkbox" class="mc-pick" value="${d.id}" aria-label="Select ${esc(u.name)}">` : ""}${avatar(u, 28)}<div><strong>${esc(u.name)}</strong><div class="muted">${esc(u.trade || "")}${d.data.note ? " · " + esc(d.data.note) : ""}</div></div>
          ${edit ? `<button class="btn small" data-mc-rm="${d.id}" data-day="${day}" title="Remove for this day">✕</button>` : ""}</div>`; }).join("") || `<p class="muted" style="margin:0">Nobody deployed here this day.</p>`}</div>
        ${edit ? `<div class="mc-x-foot"><button class="btn small primary" data-mc-add="${p.id}" data-day="${day}">+ Add guys</button>
          ${here.length ? `<button class="btn small danger" id="mcRmSel" data-day="${day}" disabled>Remove selected</button>` : ""}
          <label>Count for the chart <input class="mc-in" type="number" min="0" max="999" data-plan="${p.id}|days|${day}" value="${pl.days[day] != null ? pl.days[day] : ""}" placeholder="${here.length}" style="width:70px"></label>
          <span class="muted" style="font-size:12px">Leave empty to use the number deployed. Type a number when the guys aren't in the app yet.</span></div>` : ""}
      </div></td></tr>`;
    };
    return `
      <div class="page-head"><h1>Manpower</h1>
        <div class="actions">
          <a class="btn" href="#/manpower/chart?week=${addDays(week, -7)}">‹ Prev week</a>
          <a class="btn" href="#/manpower/chart?week=${mondayOf(todayS)}">This week</a>
          <a class="btn" href="#/manpower/chart?week=${addDays(week, 7)}">Next week ›</a>
        </div></div>
      ${tabs}
      <p class="muted" style="margin-top:0">Each box is the number of guys on that job. Days count who is deployed — click a day to see the guys and add or remove them. Type numbers for the later weeks and months.</p>
      <div class="panel flush"><div class="table-wrap"><table class="mc-table">
        <thead><tr><th class="mc-job">Job</th>${cols.map(([kind, key]) => `<th class="mc-${kind} ${key === todayS ? "today" : ""} ${kind === "day" && key === dayCols[4] ? "wk-end" : ""}">${head(kind, key)}</th>`).join("")}</tr></thead>
        <tbody>${projects.map(p => { const edit = PM.can(p.id, "manpower", "standard");
          return `<tr><th class="mc-job"><a href="#/p/${p.id}">${esc(p.data.name)}</a>${p.data.number ? ` <span class="muted">${esc(p.data.number)}</span>` : ""}</th>${cols.map(([kind, key]) => cellHTML(p, kind, key, edit)).join("")}</tr>${expandRow(p)}`; }).join("")
          || `<tr><td colspan="${cols.length + 1}" class="empty">No active jobs you can see.</td></tr>`}</tbody>
        <tfoot>
          <tr class="mc-total"><th class="mc-job">Total</th>${totals.map((t, i) => `<td class="mc-${cols[i][0]} ${cols[i][1] === todayS ? "today" : ""}">${t}</td>`).join("")}</tr>
          <tr class="mc-diff"><th class="mc-job">Missing (−) / extra (+)<div class="muted" style="font-weight:400">Headcount ${headcount} ${PM.isCompanyAdmin() ? `<a href="#" id="mcHeadcount">change</a>` : ""}</div></th>
            ${totals.map((t, i) => { const d = t - headcount; return `<td class="mc-${cols[i][0]} ${d < 0 ? "neg" : d > 0 ? "pos" : ""}">${d > 0 ? "+" + d : d}</td>`; }).join("")}</tr>
        </tfoot></table></div></div>
      <p class="muted" style="font-size:13px">Numbers in grey are suggestions from who is deployed (later weeks) — type over them to set the plan. A dot in a day box means the number was typed in instead of counted.</p>`;
  }

  function wireChart(people, projects) {
    $$("[data-mc]").forEach(td => td.onclick = () => { chartOpen = chartOpen === td.dataset.mc ? "" : td.dataset.mc; PM.render(); });
    $$("[data-mc-close]").forEach(b => b.onclick = () => { chartOpen = ""; PM.render(); });
    $$("[data-mc-add]").forEach(b => b.onclick = () => assignModal(people, "", b.dataset.mcAdd, b.dataset.day));
    $$("[data-mc-rm]").forEach(b => b.onclick = () => removeDays(Store.get(b.dataset.mcRm), b.dataset.day, b.dataset.day, people));
    const rmSel = $("#mcRmSel");
    if (rmSel) {
      const picks = () => $$(".mc-pick:checked").map(c => c.value);
      $$(".mc-pick").forEach(c => c.onchange = () => { const n = picks().length; rmSel.disabled = !n; rmSel.textContent = n ? `Remove ${n} for this day` : "Remove selected"; });
      rmSel.onclick = async () => {
        const ids = picks(); rmSel.disabled = true;
        let n = 0; for (const id of ids) if (await removeDays(Store.get(id), rmSel.dataset.day, rmSel.dataset.day, people, true)) n++;
        toast(`${n} removed for ${dayLabel(rmSel.dataset.day)}`); PM.render();
      };
    }
    $$("[data-plan]").forEach(inp => inp.onchange = async () => {
      const [pid, part, key] = inp.dataset.plan.split("|");
      inp.disabled = true;
      if (await savePlan(pid, part, key, inp.value.trim())) { toast("Saved"); PM.render(); } else inp.disabled = false;
    });
    const hc = $("#mcHeadcount");
    if (hc) hc.onclick = e => {
      e.preventDefault();
      const cur = Store.get(MP_SET);
      PM.openModal({
        title: "Company headcount",
        body: `<div class="field"><label for="hcN">Number of guys on the payroll</label><input id="hcN" type="number" min="0" value="${esc(cur && cur.data.headcount != null ? cur.data.headcount : "")}" placeholder="${people.length}">
          <div class="muted help">Used for the Missing / extra row. Leave empty to use the number of people in the app (${people.length}).</div></div>`,
        onSave: async root => {
          const v = $("#hcN", root).value.trim();
          try { await Store.save({ id: MP_SET, type: "setting", projectId: "", data: { ...(cur ? cur.data : {}), headcount: v === "" ? null : Math.max(0, Number(v)), updatedBy: PM.meName(), updatedAt: new Date().toISOString() } }); }
          catch (err) { toast(err.message, true); return false; }
          return true;
        }
      });
    };
  }

  function weekEnd(day) { const d = parse(day); const toFri = (5 - d.getDay() + 7) % 7; return addDays(day, d.getDay() === 6 || d.getDay() === 0 ? 0 : toFri); }
  function clashes(userId, start, end, exceptId) {
    return Store.all("deploy").filter(d => d.id !== exceptId && d.data.userId === userId && overlaps(d, start, end));
  }
  const clashText = (list) => list.map(d => `${(Store.get(d.projectId) || { data: { name: "another project" } }).data.name} (${PM.fmtDate(d.data.start)} – ${PM.fmtDate(d.data.end)})`).join(", ");

  // Deploy one or several people to a job for a range of days
  function assignModal(people, userIds, projectId, day) {
    const p = Store.get(projectId);
    const pre = [].concat(userIds || []).filter(Boolean);
    PM.openModal({
      title: "Deploy to " + p.data.name,
      saveLabel: "Deploy",
      body: `<div class="form-grid">
          <div class="field full"><label>People <span class="muted" id="dpCount"></span></label>
            <input type="search" id="dpSearch" placeholder="Search…" style="margin-bottom:6px">
            <div class="checks dp-people" id="dpPeople">${people.map(u => `<label data-n="${esc(u.name.toLowerCase())}"><input type="checkbox" name="dpUser" value="${u.id}" ${pre.includes(u.id) ? "checked" : ""}> ${esc(u.name)}${u.trade ? ` <span class="muted">${esc(u.trade)}</span>` : ""}<span class="dp-warn" data-warn="${u.id}"></span></label>`).join("") || `<span class="muted">No people yet. Add crew in the Directory (Paste a list…).</span>`}</div></div>
          <div class="field"><label for="dpStart">From</label><input type="date" id="dpStart" value="${day}"></div>
          <div class="field"><label for="dpEnd">Through</label><input type="date" id="dpEnd" value="${weekEnd(day)}"></div>
          <div class="field full"><label for="dpNote">Note (optional)</label><input id="dpNote" placeholder="e.g. Night shift, bring lift"></div></div>`,
      onOpen: root => {
        const picked = () => $$("input[name=dpUser]:checked", root).map(i => i.value);
        const warn = () => {
          const s = $("#dpStart", root).value, e = $("#dpEnd", root).value;
          $$("[data-warn]", root).forEach(el => { const c = s && e ? clashes(el.dataset.warn, s, e) : []; el.textContent = c.length ? " ⚠ already on " + clashText(c) : ""; });
          $("#dpCount", root).textContent = picked().length ? `(${picked().length} selected)` : "";
        };
        ["#dpStart", "#dpEnd"].forEach(sel => $(sel, root).addEventListener("change", warn));
        $("#dpPeople", root).addEventListener("change", warn);
        $("#dpSearch", root).oninput = e => { const q = e.target.value.trim().toLowerCase(); $$("#dpPeople label", root).forEach(l => { l.hidden = q && !l.dataset.n.includes(q); }); };
        warn();
      },
      onSave: async root => {
        const ids = $$("input[name=dpUser]:checked", root).map(i => i.value), s = $("#dpStart", root).value, e = $("#dpEnd", root).value;
        if (!ids.length) { toast("Pick at least one person", true); return false; }
        if (!s || !e || e < s) { toast("Check the dates", true); return false; }
        const note = $("#dpNote", root).value.trim(), at = new Date().toISOString();
        const recs = ids.map(u => ({ id: uid("dep"), type: "deploy", projectId, data: { userId: u, name: personById(people, u).name, start: s, end: e, note, by: PM.meName(), at } }));
        try { await Store.saveMany(recs); } catch (err) { toast("Not saved: " + err.message, true); return false; }
        toast(ids.length === 1 ? `${recs[0].data.name} deployed to ${p.data.name}` : `${ids.length} people deployed to ${p.data.name}`);
        return true;
      }
    });
  }

  // Shift someone to another project from a given day (splits their current assignment)
  function moveModal(people, dep, toProject, day) {
    if (!dep) return;
    const u = personById(people, dep.data.userId), from = Store.get(dep.projectId), to = Store.get(toProject);
    if (toProject === dep.projectId && day >= dep.data.start && day <= dep.data.end) return;
    PM.openModal({
      title: `Shift ${u.name}`,
      saveLabel: "Shift",
      body: `<p style="margin-top:0">Move <strong>${esc(u.name)}</strong> from <strong>${esc(from ? from.data.name : "?")}</strong> to <strong>${esc(to.data.name)}</strong>.</p>
        <div class="form-grid">
          <div class="field"><label for="mvStart">Starting</label><input type="date" id="mvStart" value="${day}"></div>
          <div class="field"><label for="mvEnd">Through</label><input type="date" id="mvEnd" value="${dep.data.end >= day ? dep.data.end : weekEnd(day)}"></div></div>
        <p class="muted" style="font-size:13px">Days outside these dates stay on ${esc(from ? from.data.name : "the original project")}.</p>`,
      onSave: async root => {
        const s = $("#mvStart", root).value, e = $("#mvEnd", root).value;
        if (!s || !e || e < s) { toast("Check the dates", true); return false; }
        const recs = [], removes = [];
        const before = dep.data.start < s ? { ...dep, data: { ...dep.data, end: addDays(s, -1) } } : null;
        const after = dep.data.end > e ? { id: uid("dep"), type: "deploy", projectId: dep.projectId, data: { ...dep.data, start: addDays(e, 1) } } : null;
        if (before) recs.push(before); else if (!(dep.data.end < s || dep.data.start > e)) removes.push(dep.id); else recs.push(dep);
        if (after) recs.push(after);
        recs.push({ id: uid("dep"), type: "deploy", projectId: toProject, data: { userId: u.id, name: u.name, start: s, end: e, note: dep.data.note || "", by: PM.meName(), at: new Date().toISOString() } });
        try {
          await Store.saveMany(recs);
          for (const id of removes) await Store.remove(id);
        } catch (err) { toast("Not saved: " + err.message, true); return false; }
        toast(`${u.name} shifted to ${to.data.name}`);
        return true;
      }
    });
  }

  // Take days out of an assignment (one day, or a range): trims it, splits it in two, or removes it
  async function removeDays(dep, from, to, people, quiet) {   // quiet = part of a batch (no toast / redraw)
    if (!dep) return false;
    const u = personById(people || [], dep.data.userId);
    if (to < from) [from, to] = [to, from];
    from = from < dep.data.start ? dep.data.start : from;
    to = to > dep.data.end ? dep.data.end : to;
    if (from > to) { toast("Those days aren't part of this assignment", true); return false; }
    const label = from === to ? PM.fmtDate(from) : `${PM.fmtDate(from)} – ${PM.fmtDate(to)}`;
    try {
      if (from <= dep.data.start && to >= dep.data.end) await Store.remove(dep.id);
      else if (from <= dep.data.start) await Store.save({ ...dep, data: { ...dep.data, start: addDays(to, 1) } });
      else if (to >= dep.data.end) await Store.save({ ...dep, data: { ...dep.data, end: addDays(from, -1) } });
      else await Store.saveMany([{ ...dep, data: { ...dep.data, end: addDays(from, -1) } }, { id: uid("dep"), type: "deploy", projectId: dep.projectId, data: { ...dep.data, start: addDays(to, 1) } }]);
    } catch (e) { toast("Not removed: " + e.message, true); return false; }
    if (!quiet) { toast(`${u.name} removed for ${label}`); PM.render(); }
    return true;
  }
  // Remove several people from a job at once (this day, through Friday, or their whole assignment)
  function removeManyModal(people, projectId, day) {
    const p = Store.get(projectId);
    const here = Store.all("deploy").filter(d => d.projectId === projectId && overlaps(d, day, day));
    if (!here.length) return;
    PM.openModal({
      title: `Remove from ${p.data.name}`,
      saveLabel: "Remove selected",
      body: `<div class="field"><label>Who <span class="muted" id="rmCount"></span></label>
          <label class="inline-check"><input type="checkbox" id="rmAll"> Everyone (${here.length})</label>
          <div class="checks dp-people">${here.map(d => `<label><input type="checkbox" name="rmDep" value="${d.id}"> ${esc(personById(people, d.data.userId).name)} <span class="muted">${esc(PM.fmtDate(d.data.start))} – ${esc(PM.fmtDate(d.data.end))}</span></label>`).join("")}</div></div>
        <div class="field"><label>For</label><div class="radio-list">
          <label><input type="radio" name="rmWhen" value="day" checked> Just ${esc(dayLabel(day))}</label>
          <label><input type="radio" name="rmWhen" value="week"> ${esc(dayLabel(day))} through ${esc(dayLabel(weekEnd(day)))}</label>
          <label><input type="radio" name="rmWhen" value="all"> Their whole assignment here</label></div></div>`,
      onOpen: root => {
        const sync = () => { const n = $$("input[name=rmDep]:checked", root).length; $("#rmCount", root).textContent = n ? `(${n} selected)` : ""; };
        $("#rmAll", root).onchange = e => { $$("input[name=rmDep]", root).forEach(c => { c.checked = e.target.checked; }); sync(); };
        root.addEventListener("change", sync);
      },
      onSave: async root => {
        const ids = $$("input[name=rmDep]:checked", root).map(c => c.value), when = $("input[name=rmWhen]:checked", root).value;
        if (!ids.length) { toast("Tick who to remove", true); return false; }
        let n = 0;
        for (const id of ids) {
          const dep = Store.get(id);
          const [f, t] = when === "all" ? [dep.data.start, dep.data.end] : [day, when === "week" ? weekEnd(day) : day];
          if (await removeDays(dep, f, t, people, true)) n++;
        }
        toast(`${n} removed from ${p.data.name}`);
        return true;
      }
    });
  }

  function editDeployment(people, dep, day) {
    if (!dep) return;
    const u = personById(people, dep.data.userId), editable = PM.can(dep.projectId, "manpower", "standard");
    PM.openModal({
      title: `${u.name} — ${(Store.get(dep.projectId) || { data: { name: "" } }).data.name}`,
      saveLabel: "Save",
      hideSave: !editable,
      body: `<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">${avatar(u, 56)}<div><strong>${esc(u.name)}</strong><div class="muted">${esc(u.trade || "")}</div>${u.phone ? `<div><a href="tel:${esc(u.phone)}">${esc(u.phone)}</a></div>` : ""}</div></div>
        <div class="form-grid">
          <div class="field full"><label for="edProj">Project</label><select id="edProj" ${editable ? "" : "disabled"}>${boardProjects().filter(p => PM.can(p.id, "manpower", "standard") || p.id === dep.projectId).map(p => `<option value="${p.id}" ${p.id === dep.projectId ? "selected" : ""}>${esc(p.data.name)}</option>`).join("")}</select></div>
          <div class="field"><label for="edStart">From</label><input type="date" id="edStart" value="${dep.data.start}" ${editable ? "" : "disabled"}></div>
          <div class="field"><label for="edEnd">Through</label><input type="date" id="edEnd" value="${dep.data.end}" ${editable ? "" : "disabled"}></div>
          <div class="field full"><label for="edNote">Note</label><input id="edNote" value="${esc(dep.data.note || "")}" ${editable ? "" : "disabled"}></div></div>
        ${editable ? `<div class="ed-remove">
          <div class="field"><label>Remove days</label><div class="inline-check" style="gap:6px;flex-wrap:wrap">
            <input type="date" id="edRmFrom" value="${esc(day || dep.data.start)}" min="${dep.data.start}" max="${dep.data.end}" aria-label="Remove from"> to
            <input type="date" id="edRmTo" value="${esc(day || dep.data.start)}" min="${dep.data.start}" max="${dep.data.end}" aria-label="Remove through">
            <button type="button" class="btn small" id="edRmDays">Remove these days</button></div>
            <div class="muted help">Pick one day (same date twice) or a range. The rest of the assignment stays.</div></div>
          <button type="button" class="btn danger small" id="edRemove">Remove from project (all ${PM.fmtDate(dep.data.start)} – ${PM.fmtDate(dep.data.end)})</button></div>` : ""}`,
      onOpen: root => {
        const rd = $("#edRmDays", root);
        if (rd) rd.onclick = async () => { const f = $("#edRmFrom", root).value, t = $("#edRmTo", root).value; if (!f || !t) return; if (await removeDays(dep, f, t, people)) PM.closeModal(); };
        const rm = $("#edRemove", root);
        if (rm) rm.onclick = async () => {
          try { await Store.remove(dep.id); PM.closeModal(); PM.render(); toast("Removed"); } catch (e) { toast("Not removed: " + e.message, true); }
        };
      },
      onSave: async root => {
        const s = $("#edStart", root).value, e = $("#edEnd", root).value;
        if (!s || !e || e < s) { toast("Check the dates", true); return false; }
        return PM.saveRec({ ...dep, projectId: $("#edProj", root).value, data: { ...dep.data, start: s, end: e, note: $("#edNote", root).value.trim() } }, "Saved");
      }
    });
  }

  async function copyLastWeek(week) {
    const prevS = addDays(week, -7), prevE = addDays(week, -1);
    const prev = Store.all("deploy").filter(d => overlaps(d, prevS, prevE) && PM.can(d.projectId, "manpower", "standard"));
    if (!prev.length) { toast("Nobody was deployed last week", true); return; }
    if (!window.confirm(`Copy last week's ${prev.length} assignment(s) into this week? People already deployed this week are skipped.`)) return;
    const recs = [];
    prev.forEach(d => {
      const s = (d.data.start < prevS ? prevS : d.data.start), e = (d.data.end > prevE ? prevE : d.data.end);
      const ns = addDays(s, 7), ne = addDays(e, 7);
      if (clashes(d.data.userId, ns, ne).length) return;
      recs.push({ id: uid("dep"), type: "deploy", projectId: d.projectId, data: { ...d.data, start: ns, end: ne, by: PM.meName(), at: new Date().toISOString() } });
    });
    if (!recs.length) { toast("Everyone from last week is already deployed this week"); return; }
    try { await Store.saveMany(recs); toast(`Copied ${recs.length} assignment(s)`); PM.render(); } catch (e) { toast("Not copied: " + e.message, true); }
  }

  // Crew on a project for a given day (project home + daily log)
  async function crewOn(p, day) {
    if (!PM.can(p.id, "manpower")) return null;
    await Store.load("deploy", p.id);
    const people = await loadPeople();
    return Store.all("deploy", p.id).filter(d => overlaps(d, day, day)).map(d => ({ dep: d, person: personById(people, d.data.userId) }));
  }
  function crewPanel(p, day, opts = {}) {
    if (!PM.can(p.id, "manpower")) return "";
    const id = "crew_" + uid("c");
    crewOn(p, day).then(list => {
      const box = document.getElementById(id);
      if (!box || !list) return;
      box.innerHTML = list.length
        ? `<div class="crew-list">${list.map(x => `<div class="crew-item" title="${esc(x.person.name)}${x.dep.data.note ? " — " + esc(x.dep.data.note) : ""}">${avatar(x.person, 30)}<span>${esc(x.person.name)}<span class="muted">${esc(x.person.trade || "")}</span></span></div>`).join("")}</div>
          ${opts.fill ? `<button class="btn small" data-fillcrew style="margin-top:8px" data-perm="dailylog:standard">Add crew to Manpower</button>` : ""}`
        : `<p class="muted">Nobody is deployed here on this day. <a href="#/manpower?week=${mondayOf(day)}">Open the manpower board</a></p>`;
      if (opts.fill && list.length) PM.applyPerms(box);
      const b = $("[data-fillcrew]", box);
      if (b && opts.fill) b.onclick = () => opts.fill(list);
    }).catch(() => {});
    return `<div class="panel"><div class="section-head"><h2 style="margin:0">${opts.title || "Crew on site"}</h2><a href="#/manpower?week=${mondayOf(day)}">Manpower board</a></div><div id="${id}"><p class="muted">Loading…</p></div></div>`;
  }

  // ───────────────────────── Certifications ─────────────────────────
  const CERT_TYPES = ["OSHA 10", "OSHA 30", "First Aid / CPR", "NFPA 70E (Arc Flash)", "Aerial / Scissor Lift", "Forklift", "Fall Protection", "Confined Space", "Scaffold", "Journeyman License", "Master Electrician License", "Fire Alarm (NICET)", "Driver's License", "Other"];
  const WARN_DAYS = 30;
  function certStatus(c) {
    if (!c.data.expires) return { key: "none", label: "No expiry", days: null };
    const days = Math.floor((parse(c.data.expires).getTime() - parse(iso(new Date())).getTime()) / 864e5);
    if (days < 0) return { key: "expired", label: `Expired ${-days} day${days === -1 ? "" : "s"} ago`, days };
    if (days <= WARN_DAYS) return { key: "expiring", label: days === 0 ? "Expires today" : `Expires in ${days} day${days === 1 ? "" : "s"}`, days };
    return { key: "valid", label: "Valid", days };
  }
  async function certsPage(tabs) {
    await Store.load("cert");
    const people = await loadPeople();
    const admin = PM.isCompanyAdmin();
    const meId = Store.mode === "local" ? PM.me() : PM.session.user.id;
    const f = PM.lsGet("netpower_pm_certfilter", { person: "", status: "" }) || {};
    const certs = Store.all("cert").filter(c => admin || c.data.userId === meId);
    const rows = certs.filter(c => (!f.person || c.data.userId === f.person) && (!f.status || certStatus(c).key === f.status))
      .sort((a, b) => (a.data.expires || "9999").localeCompare(b.data.expires || "9999"));
    const count = k => certs.filter(c => certStatus(c).key === k).length;
    setTimeout(() => {
      const add = $("#certAdd"); if (add) add.onclick = () => editCert(people, null);
      $$("[data-cert]").forEach(el => el.onclick = e => { if (!e.target.closest("a")) editCert(people, Store.get(el.dataset.cert)); });
      $$("[data-certf]").forEach(el => el.onchange = () => { f[el.dataset.certf] = el.value; PM.lsSet("netpower_pm_certfilter", f); PM.render(); });
    }, 0);
    return `
      <div class="page-head"><h1>${admin ? "Certifications" : "My Certifications"}</h1><div class="actions"><button class="btn primary" id="certAdd">+ Add Certification</button></div></div>
      ${tabs}
      <div class="cards">
        <div class="card"><div class="num overdue">${count("expired")}</div><div class="lbl">Expired</div></div>
        <div class="card"><div class="num" style="color:#b7791f">${count("expiring")}</div><div class="lbl">Expiring within ${WARN_DAYS} days</div></div>
        <div class="card"><div class="num">${count("valid") + count("none")}</div><div class="lbl">Current</div></div>
      </div>
      <div class="panel flush"><div class="toolbar">
        ${admin ? `<select data-certf="person" aria-label="Person"><option value="">Everyone</option>${people.map(u => `<option value="${u.id}" ${f.person === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>` : ""}
        <select data-certf="status" aria-label="Status"><option value="">All statuses</option>${[["expired", "Expired"], ["expiring", "Expiring soon"], ["valid", "Valid"], ["none", "No expiry"]].map(([k, l]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="table-wrap"><table class="list"><thead><tr><th>Person</th><th>Certification</th><th>Number</th><th>Issued</th><th>Expires</th><th>Status</th><th>File</th></tr></thead><tbody>
        ${rows.map(c => { const u = personById(people, c.data.userId), st = certStatus(c);
          return `<tr class="click" data-cert="${c.id}"><td><span class="person-cell">${avatar(u, 26)} ${esc(u.name)}</span></td><td>${esc(c.data.name)}</td><td>${esc(c.data.number || "")}</td><td>${PM.fmtDate(c.data.issued)}</td><td>${PM.fmtDate(c.data.expires) || "—"}</td>
            <td><span class="pill cert-${st.key}">${esc(st.label)}</span></td><td>${c.data.file ? `<a href="#" data-dl="${esc(c.data.file.url)}" data-name="${esc(c.data.file.name)}">View</a>` : ""}</td></tr>`; }).join("")
          || `<tr><td colspan="7" class="empty">No certifications${f.person || f.status ? " match the filters" : " yet"}.</td></tr>`}
      </tbody></table></div></div>
      <p class="muted" style="font-size:13px">People get a 🔔 reminder ${WARN_DAYS} days before a certification expires (company admins see everyone's). Email reminders will use the same rules once email is connected.</p>`;
  }

  function editCert(people, c) {
    const admin = PM.isCompanyAdmin();
    const meId = Store.mode === "local" ? PM.me() : PM.session.user.id;
    const d = c ? c.data : { userId: admin ? "" : meId };
    let file = d.file || null, added = null;
    PM.openModal({
      title: c ? "Edit Certification" : "Add Certification",
      noRender: false,
      body: `<div class="form-grid">
          <div class="field full"><label for="ctUser">Person <span class="req">*</span></label><select id="ctUser" ${admin ? "" : "disabled"}><option value="">Select a person</option>${people.filter(u => admin || u.id === meId).map(u => `<option value="${u.id}" ${u.id === d.userId ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></div>
          <div class="field full"><label for="ctName">Certification <span class="req">*</span></label><input id="ctName" list="ctTypes" value="${esc(d.name || "")}" placeholder="Select or type"><datalist id="ctTypes">${CERT_TYPES.map(t => `<option value="${esc(t)}">`).join("")}</datalist></div>
          <div class="field"><label for="ctNumber">Card / license #</label><input id="ctNumber" value="${esc(d.number || "")}"></div>
          <div class="field"><label for="ctIssuer">Issued by</label><input id="ctIssuer" value="${esc(d.issuer || "")}"></div>
          <div class="field"><label for="ctIssued">Issue date</label><input type="date" id="ctIssued" value="${esc(d.issued || "")}"></div>
          <div class="field"><label for="ctExpires">Expiration date</label><input type="date" id="ctExpires" value="${esc(d.expires || "")}"><div class="muted help">Leave blank if it never expires (e.g. OSHA 10 cards).</div></div>
          <div class="field full"><label>Copy of the card</label><div id="ctFileBox"></div><label class="btn small">Upload photo / PDF<input type="file" id="ctFile" accept="image/*,application/pdf" hidden></label></div>
          <div class="field full"><label for="ctNotes">Notes</label><input id="ctNotes" value="${esc(d.notes || "")}"></div></div>
        ${c ? `<button type="button" class="btn danger small" id="ctDelete">Delete certification</button>` : ""}`,
      onOpen: root => {
        const showFile = () => { $("#ctFileBox", root).innerHTML = file ? `<span>📎 ${esc(file.name)}</span> <button type="button" class="btn small" id="ctFileRm">Remove</button>` : `<span class="muted">No file</span>`; const rm = $("#ctFileRm", root); if (rm) rm.onclick = () => { file = null; showFile(); }; };
        showFile();
        $("#ctFile", root).onchange = async e => {
          const f = e.target.files[0];
          const userId = $("#ctUser", root).value;
          if (!f) return;
          if (!userId) { toast("Pick the person first", true); return; }
          $("#ctFileBox", root).textContent = "Uploading…";
          try { const url = await PM.files.upload(`certs/${userId}`, f); added = url; file = { url, name: f.name, size: f.size }; }
          catch (err) { toast("Upload failed: " + err.message, true); }
          showFile();
        };
        const del = $("#ctDelete", root);
        if (del) del.onclick = async () => {
          if (!window.confirm("Delete this certification?")) return;
          try { await Store.remove(c.id); if (d.file) PM.files.deleteFiles([d.file.url]).catch(() => {}); PM.closeModal(); PM.render(); toast("Deleted"); } catch (err) { toast("Not deleted: " + err.message, true); }
        };
        $$("[data-close]", root).forEach(b => b.addEventListener("click", () => { if (added && (!file || file.url !== (d.file && d.file.url))) PM.files.deleteFiles([added]).catch(() => {}); }));
      },
      onSave: async root => {
        const vals = { userId: $("#ctUser", root).value, name: $("#ctName", root).value.trim(), number: $("#ctNumber", root).value.trim(), issuer: $("#ctIssuer", root).value.trim(),
          issued: $("#ctIssued", root).value, expires: $("#ctExpires", root).value, notes: $("#ctNotes", root).value.trim(), file };
        if (!vals.userId || !vals.name) { toast("Person and certification are required", true); return false; }
        const ok = await PM.saveRec({ id: c ? c.id : uid("cert"), type: "cert", projectId: "", data: { ...(c ? c.data : { createdAt: new Date().toISOString(), createdBy: PM.meName() }), ...vals } }, "Certification saved");
        if (ok && d.file && (!file || file.url !== d.file.url)) PM.files.deleteFiles([d.file.url]).catch(() => {});
        peopleCache = null;
        notesAt = 0;
        return ok;
      }
    });
  }

  // ───────────────────────── Notifications (🔔) ─────────────────────────
  let notes = [], notesAt = 0;
  async function refreshBell(force) {
    const btn = $("#bellBtn");
    if (!btn) return;
    if (Store.mode === "local" || !PM.session) { btn.hidden = true; return; }
    btn.hidden = false;
    if (!force && Date.now() - notesAt < 60000) return paintBell();
    notesAt = Date.now();
    notesP = PM.api("/api/pm?action=notifications").then(d => d.notifications || [], () => []);
    notes = await notesP;
    notesP = null;
    paintBell();
  }
  let notesP = null;
  function paintBell() {
    const n = $("#bellN");
    if (!n) return;
    n.textContent = notes.length ? String(notes.length) : "";
    n.hidden = !notes.length;
    $("#bellBtn").classList.toggle("alert", notes.some(x => x.level === "danger"));
    // The red number on the app's home-screen icon = unread 🔔 items (iPhone 16.4+ home-screen app, Android, desktop apps)
    try {
      if (navigator.setAppBadge) (notes.length ? navigator.setAppBadge(notes.length) : navigator.clearAppBadge()).catch(() => {});
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ badge: notes.length });
    } catch (e) { /* not supported */ }
  }
  async function bellMenu(e) {
    e.stopPropagation();
    let m = $("#bellMenu");
    if (m) { m.remove(); return; }
    m = document.createElement("div");
    m.id = "bellMenu";
    m.className = "user-menu bell-menu";
    if (notesP) { m.innerHTML = `<div class="um-head"><strong>Notifications</strong></div><div class="muted" style="padding:10px 14px">Loading…</div>`; document.body.appendChild(m); await notesP; m.remove(); if (!document.body.contains(m) && $("#bellMenu")) return; }
    const icon = x => x.kind === "cert" ? "🪪" : x.kind === "drawings" ? "📐" : x.kind === "tool" ? "🧰" : x.kind === "changeorder" ? "💲" : x.kind === "task" ? "☑" : "📋";
    const paint = () => {
      m.innerHTML = `<div class="um-head bell-head"><strong>Notifications</strong>${notes.length ? `<button type="button" class="linkish" id="bellAll">Mark all read</button>` : ""}</div>` + (notes.length
        ? notes.map(x => `<a href="${esc(x.href || "#")}" class="note-${esc(x.level)}" data-note="${esc(x.key || "")}">${icon(x)} ${esc(x.text)}</a>`).join("")
        : `<div class="muted" style="padding:10px 14px">You're all caught up.</div>`);
    };
    paint();
    document.body.appendChild(m);
    const close = ev => { if (!document.body.contains(m) || !ev.target.closest("#bellMenu")) { m.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
    m.onclick = ev => {
      if (ev.target.closest("#bellAll")) { ev.stopPropagation(); markRead(notes.map(x => x.key)); paint(); return; }
      const a = ev.target.closest("a[data-note]");
      if (a) { markRead([a.dataset.note]); m.remove(); }
    };
  }
  // Read = gone from the list (saved on the server, so it's gone on the phone and the computer)
  function markRead(keys) {
    keys = keys.filter(Boolean);
    if (!keys.length) return;
    notes = notes.filter(x => !keys.includes(x.key));
    paintBell();
    PM.api("/api/pm?action=notificationsRead", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys }) })
      .then(() => { notesAt = Date.now(); }, e => toast(e.message, true));
  }

  // ───────────────────────── Daily log reminders ─────────────────────────
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const settingsOf = p => Store.get("ls_" + p.id);
  const fmtTime = hhmm => { const [h, m] = String(hhmm || "16:00").split(":").map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
  // Expected log days in the last 7 days that have no log (browser's clock; the server uses the saved time zone)
  function missingLogs(p) {
    const s = settingsOf(p);
    if (!s || !s.data.enabled) return [];
    const st = s.data, now = new Date(), [dh, dm] = String(st.due || "16:00").split(":").map(Number);
    const has = date => Store.get("log_" + p.id + "_" + date.replace(/-/g, ""));
    const out = [];
    for (let k = 0; k < 7; k++) {
      const date = addDays(iso(now), -k), dow = parse(date).getDay();
      const expected = st.frequency === "weekly" ? dow === Number(st.weekDay ?? 5) : (st.days || [1, 2, 3, 4, 5]).map(Number).includes(dow);
      if (!expected || (st.since && date < st.since)) continue;
      const done = st.frequency === "weekly" ? [0, 1, 2, 3, 4, 5, 6].some(i => has(addDays(date, -i))) : has(date);
      if (done) continue;
      const pastDue = k > 0 || now.getHours() * 60 + now.getMinutes() >= dh * 60 + (dm || 0);
      out.push({ date, pastDue });
    }
    return out;
  }
  function dailyLogPanels(p, date, fillCrew) {
    const s = settingsOf(p), st = s ? s.data : null;
    const missing = missingLogs(p);
    const isAdmin = PM.can(p.id, "dailylog", "admin");
    setTimeout(() => { const b = $("#logRemBtn"); if (b) b.onclick = () => reminderSettings(p); }, 0);
    const summary = st && st.enabled
      ? `<p style="margin:0 0 6px">🔔 On — ${st.frequency === "weekly" ? "weekly, every " + DOW[Number(st.weekDay ?? 5)] : (st.days || []).map(d => DOW[d]).join(", ")} by ${fmtTime(st.due)}</p>
         <p class="muted" style="margin:0;font-size:13px">Reminds: ${esc((st.foremanNames || []).join(", ") || "nobody yet")}. If it's still missing ${st.escalateHours ?? 2} h after the due time, notifies: ${esc((st.pmNames || []).join(", ") || "nobody")}.</p>`
      : `<p class="muted" style="margin:0">Reminders are off for this project.</p>`;
    return `
      <div class="panel"><div class="section-head"><h2 style="margin:0">Reminders</h2>${isAdmin ? `<button class="btn small" id="logRemBtn">Settings</button>` : ""}</div>${summary}
        ${missing.length ? `<div class="missing-logs">${missing.map(m => `<a href="#/p/${p.id}/dailylog/${m.date}" class="${m.pastDue ? "overdue" : ""}">${m.pastDue ? "⚠ Missing" : "Due today"}: ${PM.fmtDate(m.date)}</a>`).join("")}</div>` : st && st.enabled ? `<p class="muted" style="font-size:13px;margin:6px 0 0">✓ No missing logs this week.</p>` : ""}</div>
      ${crewPanel(p, date, { fill: fillCrew, title: "Crew deployed this day" })}`;
  }
  async function reminderSettings(p) {
    const people = await loadPeople();
    const s = settingsOf(p), st = s ? s.data : { enabled: true, frequency: "daily", days: [1, 2, 3, 4, 5], weekDay: 5, due: "16:00", escalateHours: 2, foremanIds: [], pmIds: [] };
    const tz = st.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const checks = (name, sel) => people.map(u => `<label><input type="checkbox" name="${name}" value="${u.id}" ${(sel || []).includes(u.id) ? "checked" : ""}> ${esc(u.name)}${u.trade ? ` <span class="muted">${esc(u.trade)}</span>` : ""}</label>`).join("") || `<span class="muted">No people yet.</span>`;
    PM.openModal({
      title: "Daily Log Reminders — " + p.data.name,
      wide: true,
      body: `
        <label class="inline-check"><input type="checkbox" id="rmOn" ${st.enabled ? "checked" : ""}> Remind the foreman to fill out the daily log</label>
        <div class="form-grid" style="margin-top:10px">
          <div class="field"><label>How often</label>
            <div class="radio-list"><label><input type="radio" name="rmFreq" value="daily" ${st.frequency !== "weekly" ? "checked" : ""}> Every work day</label>
            <label><input type="radio" name="rmFreq" value="weekly" ${st.frequency === "weekly" ? "checked" : ""}> Once a week</label></div></div>
          <div class="field" id="rmDaysF"><label>Work days</label><div class="day-checks">${DOW.map((d, i) => `<label><input type="checkbox" name="rmDay" value="${i}" ${(st.days || []).map(Number).includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div></div>
          <div class="field" id="rmWeekF"><label for="rmWeekDay">Due every</label><select id="rmWeekDay">${DOW.map((d, i) => `<option value="${i}" ${Number(st.weekDay ?? 5) === i ? "selected" : ""}>${d}</option>`).join("")}</select></div>
          <div class="field"><label for="rmDue">Due by (time of day)</label><input type="time" id="rmDue" value="${esc(st.due || "16:00")}"><div class="muted help">Time zone: ${esc(tz)}</div></div>
          <div class="field"><label for="rmEsc">Notify the PM if still missing after</label><div class="inline-check"><input type="number" id="rmEsc" min="0" max="168" step="0.5" value="${esc(st.escalateHours ?? 2)}" style="width:90px"> hours</div></div>
        </div>
        <div class="form-grid">
          <div class="field"><label>Foreman / people to remind</label><div class="checks">${checks("rmForeman", st.foremanIds)}</div></div>
          <div class="field"><label>PM / people to notify when it's missing</label><div class="checks">${checks("rmPM", st.pmIds)}</div></div>
        </div>
        <p class="muted" style="font-size:13px">Reminders appear in the 🔔 in the top bar now. Email / WhatsApp reminders will use these same settings once they're connected.</p>`,
      onOpen: root => {
        const sync = () => { const weekly = $("input[name=rmFreq]:checked", root).value === "weekly"; $("#rmDaysF", root).hidden = weekly; $("#rmWeekF", root).hidden = !weekly; };
        $$("input[name=rmFreq]", root).forEach(r => r.onchange = sync);
        sync();
      },
      onSave: async root => {
        const vals = n => $$(`input[name=${n}]:checked`, root).map(i => i.value);
        const foremanIds = vals("rmForeman"), pmIds = vals("rmPM");
        const data = {
          enabled: $("#rmOn", root).checked, frequency: $("input[name=rmFreq]:checked", root).value,
          days: vals("rmDay").map(Number), weekDay: Number($("#rmWeekDay", root).value), due: $("#rmDue", root).value || "16:00", tz,
          escalateHours: Math.max(0, Number($("#rmEsc", root).value) || 0), foremanIds, pmIds,
          since: st.enabled && st.since ? st.since : iso(new Date()),
          foremanNames: foremanIds.map(i => personById(people, i).name), pmNames: pmIds.map(i => personById(people, i).name),
          updatedBy: PM.meName(), updatedAt: new Date().toISOString()
        };
        if (data.enabled && data.frequency === "daily" && !data.days.length) { toast("Pick at least one work day", true); return false; }
        const ok = await PM.saveRec({ id: "ls_" + p.id, type: "logsetting", projectId: p.id, data }, "Reminder settings saved");
        if (ok) notesAt = 0;
        return ok;
      }
    });
  }

  // ───────────────────────── Hooks ─────────────────────────
  function decorateTopbar() {
    const nav = $(".topnav");
    if (nav && !$("[data-nav=manpower]", nav)) nav.insertAdjacentHTML("beforeend", `<a href="#/manpower" data-nav="manpower" hidden>Manpower</a>`);
    const mp = $("[data-nav=manpower]", nav);
    if (mp) mp.hidden = !canManpower() && Store.mode !== "local";
    const ub = $("#userBtn");
    if (ub && !$("#bellBtn")) {
      ub.insertAdjacentHTML("beforebegin", `<button class="bell-btn" id="bellBtn" title="Notifications" aria-label="Notifications" hidden>🔔<span class="bell-n" id="bellN" hidden></span></button>`);
      $("#bellBtn").onclick = bellMenu;
    }
    refreshBell();
  }

  const invalidate = () => { peopleCache = null; };
  PM.people = { invalidate, photoToDataURL, page, avatar, loadPeople, profileFieldsHTML, wireProfileFields, readProfile, myProfile, crewPanel, crewOn, dailyLogPanels, decorateTopbar, refreshBell, missingLogs, certStatus };
})();

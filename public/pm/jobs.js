// NetPower PM — Job Tracker: the same list of steps for every job (company-wide), with each job's progress.
//   #/jobs          all jobs × steps (tab on the home page)
//   #/jobs/<pid>    one job's steps
// Step list: "setting" record set_jobsteps (company admins edit). Progress: one "jobstatus" record per project (jst_<projectId>).
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast, Store } = PM;

  const STEPS_ID = "set_jobsteps";
  // Starting list — company admins can rename, reorder, add or remove steps
  const DEFAULT_STEPS = ["Contract / PO received", "Permit filed", "Submittals approved", "Material ordered", "Temporary power", "Underground / slab",
    "Rough-in", "Rough-in inspection", "Fixtures & trim-out", "Final inspection", "Sign-off / certificate", "Closeout documents", "Final billing"]
    .map((name, i) => ({ id: "s" + (i + 1), name }));
  const STATES = [["", "Not started"], ["progress", "In progress"], ["done", "Done"], ["blocked", "Blocked"], ["na", "N/A"]];
  const LABEL = Object.fromEntries(STATES);

  const steps = () => { const s = Store.get(STEPS_ID); return (s && s.data.steps && s.data.steps.length ? s.data.steps : DEFAULT_STEPS).filter(x => !x.hidden); };
  const statusId = pid => "jst_" + pid;
  const statusOf = pid => { const r = Store.get(statusId(pid)); return (r && r.data.steps) || {}; };
  const canEdit = pid => PM.can(pid, "admin", "standard");
  async function loadAll() { await Promise.all([Store.load("setting"), Store.load("jobstatus")]); }
  function progress(pid) {
    const st = statusOf(pid), list = steps().filter(s => (st[s.id] || {}).state !== "na");
    const done = list.filter(s => (st[s.id] || {}).state === "done").length;
    const cur = list.find(s => (st[s.id] || {}).state !== "done");
    return { done, total: list.length, pct: list.length ? Math.round(done / list.length * 100) : 0, current: cur, blocked: list.filter(s => (st[s.id] || {}).state === "blocked") };
  }
  const projects = showDone => Store.all("project").filter(p => p.data.status !== "Archived" && (showDone || p.data.status !== "Completed"))
    .sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));
  const bar = pct => `<span class="jt-bar" title="${pct}% done"><span style="width:${pct}%"></span></span>`;

  async function saveStep(p, stepId, val) {
    const id = statusId(p.id), cur = Store.get(id);
    const prev = (cur && cur.data.steps) || {};
    const step = steps().find(s => s.id === stepId);
    const next = { ...prev, [stepId]: { ...val, by: PM.meName(), at: new Date().toISOString() } };
    if (!val.state && !val.date && !val.note) delete next[stepId];
    const rec = PM.withHistory({ id, type: "jobstatus", projectId: p.id, data: { ...(cur ? cur.data : {}), steps: next } },
      `${step ? step.name : stepId}: ${LABEL[val.state || ""]}${val.date ? " (" + PM.fmtDate(val.date) + ")" : ""}`);
    return PM.saveRec(rec, "Saved");
  }

  function stepModal(p, stepId) {
    const s = steps().find(x => x.id === stepId), v = statusOf(p.id)[stepId] || {};
    PM.openModal({
      title: `${s.name} — ${p.data.name}`,
      body: `<div class="field"><label>Status</label><div class="radio-list jt-states">${STATES.map(([k, l]) => `<label><input type="radio" name="jtState" value="${k}" ${(v.state || "") === k ? "checked" : ""}> <span class="jt-dot jt-${k || "none"}"></span> ${l}</label>`).join("")}</div></div>
        <div class="field"><label for="jtDate">Date <span class="muted">(done date, or target date)</span></label><input id="jtDate" type="date" value="${esc(v.date || "")}"></div>
        <div class="field"><label for="jtNote">Note</label><textarea id="jtNote" placeholder="e.g. Waiting on DOB, permit # …">${esc(v.note || "")}</textarea></div>
        ${v.by ? `<p class="muted" style="font-size:13px">Last changed by ${esc(v.by)} · ${esc(PM.fmtDateTime(v.at))}</p>` : ""}`,
      onOpen: root => $$("input[name=jtState]", root).forEach(i => i.onchange = () => { if (i.value === "done" && !$("#jtDate", root).value) $("#jtDate", root).value = PM.today(); }),
      onSave: async root => saveStep(p, stepId, { state: $("input[name=jtState]:checked", root).value, date: $("#jtDate", root).value, note: $("#jtNote", root).value.trim() })
    });
  }

  function stepsModal() {
    let list = steps().map(s => ({ ...s }));
    const draw = root => {
      $("#jsList", root).innerHTML = list.map((s, i) => `<div class="jt-edit-row"><span class="muted">${i + 1}.</span><input data-name="${i}" value="${esc(s.name)}" aria-label="Step ${i + 1}">
        <button type="button" class="btn small" data-up="${i}" aria-label="Move up" ${i ? "" : "disabled"}>↑</button><button type="button" class="btn small" data-down="${i}" aria-label="Move down" ${i < list.length - 1 ? "" : "disabled"}>↓</button>
        <button type="button" class="btn small danger" data-rm="${i}" aria-label="Remove">✕</button></div>`).join("");
    };
    PM.openModal({
      title: "Job Steps (all jobs)",
      body: `<p class="muted" style="margin-top:0">These steps are the same for every job. Removing a step hides it; what was recorded for it is kept.</p><div id="jsList"></div>
        <button type="button" class="btn small" id="jsAdd" style="margin-top:8px">+ Add step</button>`,
      onOpen: root => {
        draw(root);
        $("#jsList", root).oninput = e => { const i = e.target.dataset.name; if (i != null) list[i].name = e.target.value; };
        $("#jsList", root).onclick = e => {
          const b = e.target.closest("button"); if (!b) return;
          const i = Number(b.dataset.up ?? b.dataset.down ?? b.dataset.rm);
          if (b.dataset.up != null) [list[i - 1], list[i]] = [list[i], list[i - 1]];
          if (b.dataset.down != null) [list[i + 1], list[i]] = [list[i], list[i + 1]];
          if (b.dataset.rm != null) list.splice(i, 1);
          draw(root);
        };
        $("#jsAdd", root).onclick = () => { list.push({ id: "s" + Date.now().toString(36), name: "" }); draw(root); $$("#jsList input", root).pop().focus(); };
      },
      onSave: async () => {
        list = list.map(s => ({ ...s, name: s.name.trim() })).filter(s => s.name);
        if (!list.length) { toast("Keep at least one step", true); return false; }
        const cur = Store.get(STEPS_ID);
        const old = cur && cur.data.steps && cur.data.steps.length ? cur.data.steps : DEFAULT_STEPS;
        const hidden = old.filter(o => !list.some(s => s.id === o.id)).map(o => ({ ...o, hidden: true }));
        try { await Store.save({ id: STEPS_ID, type: "setting", projectId: "", data: { steps: [...list.map(({ hidden: h, ...s }) => s), ...hidden], updatedBy: PM.meName(), updatedAt: new Date().toISOString() } }); }
        catch (e) { toast(e.message, true); return false; }
        toast("Steps saved");
        return true;
      }
    });
  }

  const cell = (p, s, v) => {
    const st = v.state || "";
    return `<td class="jt-cell jt-${st || "none"} ${canEdit(p.id) ? "click" : ""}" data-jt="${p.id}|${s.id}" title="${esc(s.name)}: ${esc(LABEL[st])}${v.date ? " · " + esc(PM.fmtDate(v.date)) : ""}${v.note ? "\n" + esc(v.note) : ""}">
      ${st === "done" ? "✓" : st === "blocked" ? "!" : st === "progress" ? "…" : st === "na" ? "—" : ""}${v.date ? `<small>${esc(PM.fmtDate(v.date).replace(/, \d{4}$/, ""))}</small>` : ""}${v.note ? `<i class="jt-note"></i>` : ""}</td>`;
  };

  function wire() {
    $$("[data-jt]").forEach(td => td.onclick = () => {
      const [pid, sid] = td.dataset.jt.split("|");
      if (!canEdit(pid)) { toast("You can view this job's steps but not change them", true); return; }
      stepModal(Store.get(pid), sid);
    });
    const e = $("#jtEditSteps"); if (e) e.onclick = stepsModal;
    const d = $("#jtShowDone"); if (d) d.onchange = () => { PM.lsSet("netpower_pm_jt_done", d.checked); PM.render(); };
  }

  async function page(pid) {
    await loadAll();
    setTimeout(wire, 0);
    const tabs = `<div class="tabs"><a href="#/">Projects</a><a href="#/jobs" class="on">Job Tracker</a></div>`;
    const admin = PM.isCompanyAdmin();
    if (pid) return jobPage(Store.get(pid), tabs);
    const showDone = !!PM.lsGet("netpower_pm_jt_done", false);
    const list = projects(showDone), S = steps();
    return `<div class="page-head"><h1>Job Tracker</h1><span class="sub">${list.length} job${list.length === 1 ? "" : "s"} · ${S.length} steps</span>
        <div class="actions">${admin ? `<button class="btn" id="jtEditSteps">Edit steps</button>` : ""}</div></div>
      ${tabs}
      <div class="jt-legend">${STATES.map(([k, l]) => `<span><span class="jt-dot jt-${k || "none"}"></span>${l}</span>`).join("")}
        <label class="inline-check" style="margin-left:auto"><input type="checkbox" id="jtShowDone" ${showDone ? "checked" : ""}> Show completed jobs</label></div>
      <div class="panel flush">${list.length ? `<div class="table-wrap jt-wrap"><table class="list jt-table"><thead><tr><th class="jt-job">Job</th><th>Progress</th>${S.map(s => `<th class="jt-step"><span>${esc(s.name)}</span></th>`).join("")}</tr></thead><tbody>
        ${list.map(p => { const st = statusOf(p.id), pr = progress(p.id); return `<tr>
          <td class="jt-job"><a href="#/jobs/${p.id}"><strong>${esc(p.data.name)}</strong></a>${p.data.number ? ` <span class="muted">${esc(p.data.number)}</span>` : ""}
            <div class="muted" style="font-size:12px">${pr.blocked.length ? `<span class="overdue">Blocked: ${esc(pr.blocked.map(s => s.name).join(", "))}</span>` : pr.current ? "Next: " + esc(pr.current.name) : "All steps done"}</div></td>
          <td class="nowrap">${bar(pr.pct)} <span class="muted">${pr.done}/${pr.total}</span></td>
          ${S.map(s => cell(p, s, st[s.id] || {})).join("")}</tr>`; }).join("")}
        </tbody></table></div>` : `<div class="empty">No jobs yet. Create a project first.</div>`}</div>
      <p class="muted" style="font-size:13px">Click a box to update a step. ${admin ? "Use “Edit steps” to change the list for all jobs." : ""}</p>`;
  }

  function jobPage(p, tabs) {
    if (!p || p.type !== "project") return `<div class="empty">Job not found. <a href="#/jobs">Back to Job Tracker</a></div>`;
    const st = statusOf(p.id), pr = progress(p.id), edit = canEdit(p.id);
    return `<div class="crumb"><a href="#/jobs">Job Tracker</a> / ${esc(p.data.name)}</div>
      <div class="page-head"><h1>${esc(p.data.name)}</h1><span class="sub">${bar(pr.pct)} ${pr.done} of ${pr.total} steps done</span>
        <div class="actions"><a class="btn" href="#/p/${p.id}">Open project</a></div></div>
      ${tabs}
      <div class="panel flush"><div class="table-wrap"><table class="list jt-job-steps"><thead><tr><th>#</th><th>Step</th><th>Status</th><th>Date</th><th>Note</th><th>Updated</th></tr></thead><tbody>
        ${steps().map((s, i) => { const v = st[s.id] || {}; return `<tr class="${edit ? "click" : ""}" data-jt="${p.id}|${s.id}">
          <td>${i + 1}</td><td><strong>${esc(s.name)}</strong></td>
          <td class="nowrap"><span class="jt-dot jt-${v.state || "none"}"></span> ${esc(LABEL[v.state || ""])}</td>
          <td class="nowrap">${esc(PM.fmtDate(v.date) || "")}</td><td class="prose">${esc(v.note || "")}</td>
          <td class="muted nowrap" style="font-size:12px">${v.by ? esc(v.by) + " · " + esc(PM.fmtDate(v.at)) : ""}</td></tr>`; }).join("")}
      </tbody></table></div></div>
      ${edit ? `<p class="muted" style="font-size:13px">Click a step to update it.</p>` : ""}`;
  }

  // Project home: progress at a glance (loads the step data in the background the first time)
  function homePanel(p) {
    if (!Store.loaded.has("jobstatus|") && Store.mode !== "local") { loadAll().then(() => { const el = $("#jtHome"); if (el) el.outerHTML = homePanel(p); }).catch(() => {}); }
    const pr = progress(p.id);
    return `<div class="panel" id="jtHome"><h2>Job Steps <a class="btn small" style="float:right" href="#/jobs/${p.id}">Open</a></h2>
      <div>${bar(pr.pct)} <span class="muted">${pr.done} of ${pr.total} done</span></div>
      <div style="margin-top:6px">${pr.blocked.length ? `<span class="overdue">Blocked: ${esc(pr.blocked.map(s => s.name).join(", "))}</span>` : pr.current ? "Next: <strong>" + esc(pr.current.name) + "</strong>" : "All steps done ✓"}</div></div>`;
  }

  PM.jobs = { page, homePanel, steps, progress, DEFAULT_STEPS };
})();

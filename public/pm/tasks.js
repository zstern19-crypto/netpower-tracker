// NetPower PM — Tasks: to-dos per project (assignee, due date, status), plus "My Tasks" across all jobs.
// Claude can create them too (create_task in the connector and the ✦ Ask AI assistant).
//   #/p/<pid>/tasks          the project's tasks          #/p/<pid>/tasks/<id>   open one (edit dialog)
//   #/tasks                  my tasks across all projects
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast, Store } = PM;

  const STATUSES = ["Open", "In Progress", "Done"];
  const PILL = { Open: "open", "In Progress": "revise-and-resubmit", Done: "approved" };
  const people = () => PM.contacts().slice().sort((a, b) => a.data.name.localeCompare(b.data.name));
  const order = (a, b) => (a.data.status === "Done") - (b.data.status === "Done") || String(a.data.due || "9999").localeCompare(String(b.data.due || "9999")) || (b.data.priority === "High") - (a.data.priority === "High") || a.data.number - b.data.number;
  const late = d => d.status !== "Done" && d.due && d.due < PM.today();

  function editTask(p, rec) {
    const d = rec ? rec.data : { status: "Open", priority: "Normal" };
    PM.openModal({
      title: rec ? `Task #${d.number}` : "New Task",
      body: `<div class="form-grid">
          <div class="field full"><label for="tkTitle">Task *</label><input id="tkTitle" value="${esc(d.title || "")}" placeholder="e.g. Pull feeders to MDP"></div>
          <div class="field"><label for="tkWho">Assigned to</label><select id="tkWho"><option value="">— nobody yet —</option>${people().map(c => `<option value="${c.id}" ${d.assigneeId === c.id ? "selected" : ""}>${esc(c.data.name)}</option>`).join("")}</select></div>
          <div class="field"><label for="tkDue">Due</label><input id="tkDue" type="date" value="${esc(d.due || "")}"></div>
          <div class="field"><label for="tkStatus">Status</label><select id="tkStatus">${STATUSES.map(s => `<option ${d.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
          <div class="field"><label for="tkPri">Priority</label><select id="tkPri">${["Normal", "High"].map(s => `<option ${d.priority === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
          <div class="field full"><label for="tkDesc">Details</label><textarea id="tkDesc">${esc(d.description || "")}</textarea></div>
        </div>
        ${rec ? `<p class="muted" style="font-size:12px">Created by ${esc(d.createdBy || "")}${d.source === "Claude" ? " via Claude" : ""} · ${esc(PM.fmtDateTime(d.createdAt))}</p>` : ""}
        ${rec && PM.can(p.id, "tasks", "admin") ? `<button type="button" class="btn small danger" id="tkDel">Delete task</button>` : ""}`,
      onOpen: root => {
        const del = $("#tkDel", root);
        if (del) del.onclick = async () => { if (!window.confirm("Delete this task?")) return; try { await Store.remove(rec.id); PM.closeModal(); toast("Deleted"); location.hash = `#/p/${p.id}/tasks`; PM.render(); } catch (e) { toast(e.message, true); } };
      },
      onSave: async root => {
        const v = id => $("#" + id, root).value.trim();
        if (!v("tkTitle")) { toast("Enter the task", true); return false; }
        const data = { ...(rec ? rec.data : { number: PM.nextNumber("task", p.id), createdBy: PM.meName(), createdById: PM.me() || "", createdAt: new Date().toISOString() }),
          title: v("tkTitle"), assigneeId: v("tkWho"), due: v("tkDue"), status: v("tkStatus"), priority: v("tkPri"), description: v("tkDesc") };
        if (data.status === "Done" && (!rec || rec.data.status !== "Done")) Object.assign(data, { doneAt: new Date().toISOString(), doneBy: PM.meName() });
        const next = PM.withHistory({ id: rec ? rec.id : PM.uid("tsk"), type: "task", projectId: p.id, data }, rec ? (rec.data.status !== data.status ? `Status changed to ${data.status}` : "Edited") : "Created");
        return PM.saveRec(next, rec ? "Task saved" : `Task #${data.number} added`);
      }
    });
  }

  async function toggleDone(rec) {
    const done = rec.data.status !== "Done";
    const next = PM.withHistory({ ...rec, data: { ...rec.data, status: done ? "Done" : "Open", ...(done ? { doneAt: new Date().toISOString(), doneBy: PM.meName() } : {}) } }, done ? "Marked done" : "Reopened");
    if (await PM.saveRec(next, done ? "Done ✓" : "Reopened")) PM.render();
  }

  const row = (r, p, showProject) => {
    const d = r.data, edit = PM.can(r.projectId, "tasks", "standard");
    return `<tr class="${d.status === "Done" ? "tk-done" : ""}">
      <td class="tk-check">${edit ? `<input type="checkbox" data-tk-done="${r.id}" ${d.status === "Done" ? "checked" : ""} aria-label="Done">` : ""}</td>
      <td><a href="#/p/${r.projectId}/tasks/${r.id}">${esc(d.title)}</a>${d.priority === "High" ? ` <span class="pill rejected">High</span>` : ""}${d.source === "Claude" ? ` <span class="muted" title="Created by Claude">✦</span>` : ""}
        ${d.description ? `<div class="muted" style="font-size:12px">${esc(d.description.slice(0, 140))}</div>` : ""}</td>
      ${showProject ? `<td><a href="#/p/${r.projectId}/tasks">${esc(p ? p.data.name : "")}</a></td>` : ""}
      <td>${esc(PM.contactName(d.assigneeId) || "")}</td>
      <td class="nowrap ${late(d) ? "overdue" : ""}">${esc(PM.fmtDate(d.due) || "")}</td>
      <td><span class="pill ${PILL[d.status] || ""}">${esc(d.status)}</span></td></tr>`;
  };
  function wire(open) {
    $$("[data-tk-done]").forEach(c => c.onchange = () => toggleDone(Store.get(c.dataset.tkDone)));
    $$("[data-tk-add]").forEach(b => b.onclick = () => editTask(Store.get(b.dataset.tkAdd), null));
    if (open) { const r = Store.get(open); if (r && r.type === "task") editTask(Store.get(r.projectId), r); }
  }

  function page(p, sub, query) {
    const view = PM.lsGet("netpower_pm_tk_view", "open") || "open";
    const all = Store.all("task", p.id);
    const list = all.filter(r => view === "all" || (view === "open" ? r.data.status !== "Done" : view === "mine" ? r.data.assigneeId === PM.me() && r.data.status !== "Done" : r.data.status === "Done")).sort(order);
    setTimeout(() => {
      wire(sub);
      $$("[data-tkview]").forEach(a => a.onclick = e => { e.preventDefault(); PM.lsSet("netpower_pm_tk_view", a.dataset.tkview); PM.render(); });
      if (query && query.get("new") && PM.can(p.id, "tasks", "standard")) editTask(p, null);
    }, 0);
    const open = all.filter(r => r.data.status !== "Done").length;
    return `<div class="page-head"><h1>Tasks</h1><span class="sub">${open} open</span>
        <div class="actions">${PM.can(p.id, "tasks", "standard") ? `<button class="btn primary" data-tk-add="${p.id}">+ Add Task</button>` : ""}</div></div>
      <div class="tabs">${[["open", "Open"], ["mine", "Mine"], ["done", "Done"], ["all", "All"]].map(([k, l]) => `<a href="#" data-tkview="${k}" class="${view === k ? "on" : ""}">${l}</a>`).join("")}</div>
      <div class="panel flush">${list.length ? `<div class="table-wrap"><table class="list tk-list"><thead><tr><th></th><th>Task</th><th>Assigned to</th><th>Due</th><th>Status</th></tr></thead><tbody>
        ${list.map(r => row(r, p, false)).join("")}</tbody></table></div>` : `<div class="empty">No tasks here. ${PM.can(p.id, "tasks", "standard") ? "Add one, or ask ✦ Ask AI: “Add a task on this job for Hugo to pull feeders by Friday”." : ""}</div>`}</div>`;
  }

  // "My Tasks": everything assigned to me (or that I created) across projects
  async function myTasks() {
    await Store.load("task");
    const me = PM.me();
    const mine = Store.all("task").filter(r => r.data.status !== "Done" && (r.data.assigneeId === me || (!r.data.assigneeId && r.data.createdById === me))).sort(order);
    const projects = Store.all("project");
    setTimeout(() => wire(), 0);
    return `<div class="page-head"><h1>My Tasks</h1><span class="sub">${mine.length} open</span></div>
      <div class="panel flush">${mine.length ? `<div class="table-wrap"><table class="list tk-list"><thead><tr><th></th><th>Task</th><th>Project</th><th>Assigned to</th><th>Due</th><th>Status</th></tr></thead><tbody>
        ${mine.map(r => row(r, projects.find(p => p.id === r.projectId), true)).join("")}</tbody></table></div>` : `<div class="empty">Nothing assigned to you. 🎉</div>`}</div>`;
  }

  function homePanel(p) {
    if (!PM.can(p.id, "tasks")) return "";
    const open = Store.all("task", p.id).filter(r => r.data.status !== "Done").sort(order).slice(0, 5);
    return `<div class="panel"><h2>Open Tasks <a class="btn small" style="float:right" href="#/p/${p.id}/tasks">All</a></h2>
      ${open.length ? open.map(r => `<div style="padding:3px 0"><a href="#/p/${p.id}/tasks/${r.id}">${esc(r.data.title)}</a> <span class="muted">${esc(PM.contactName(r.data.assigneeId) || "")}${r.data.due ? " · " + esc(PM.fmtDate(r.data.due)) : ""}</span>${late(r.data) ? ` <span class="overdue">late</span>` : ""}</div>`).join("") : `<p class="muted">No open tasks.</p>`}</div>`;
  }

  PM.tasks = { page, myTasks, homePanel, editTask };
})();

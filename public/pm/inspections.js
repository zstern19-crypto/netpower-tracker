// NetPower PM — Inspections per job, with Outlook calendar files (.ics) and email invites (draft with the .ics attached).
(() => {
  const PM = window.NetPowerPM;
  const { $, $$, esc, toast, Store } = PM;

  const TYPES = ["Underground / Slab", "Rough-in", "Above Ceiling", "Service / Meter", "Temporary Power", "Fire Alarm", "Emergency Lighting", "Final", "Re-inspection", "Other"];
  const STATUSES = ["Scheduled", "Passed", "Partial", "Failed", "Cancelled"];
  const PILL = { Scheduled: "open", Passed: "approved", Partial: "revise-and-resubmit", Failed: "rejected", Cancelled: "closed" };
  const all = p => Store.all("inspection", p.id);
  const when = d => (d.date || "") + "T" + (d.time || "00:00");
  const isUpcoming = d => d.status === "Scheduled" && d.date >= PM.today();

  // ── Calendar file (iCalendar, RFC 5545)
  const icsText = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const fold = line => {   // lines over 75 bytes continue on the next line, starting with a space
    const bytes = new TextEncoder().encode(line);
    if (bytes.length <= 75) return line;
    const out = []; let cur = "", n = 0;
    for (const ch of line) {
      const b = new TextEncoder().encode(ch).length;
      if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; n = 0; }
      cur += ch; n += b;
    }
    out.push(cur);
    return out.join("\r\n ");
  };
  const utc = dt => dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  function projectAddress(p) { return [p.data.address, p.data.city, p.data.state].filter(Boolean).join(", "); }
  function summary(p, d) { return `Inspection: ${d.type || "Inspection"}${d.title ? " - " + d.title : ""} — ${p.data.name}`; }
  function icsFor(p, rec) {
    const d = rec.data;
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NetPower Electric//NetPower PM//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
      `UID:${rec.id}@netpower-pm`, `SEQUENCE:${d.seq || 0}`, `DTSTAMP:${utc(new Date())}`];
    if (d.time) {
      const start = new Date(when(d));   // the time typed in, in this computer's time zone
      const end = new Date(start.getTime() + (Number(d.hours) || 1) * 3600000);
      lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
    } else {
      const day = d.date.replace(/-/g, ""), next = PM.addDays(d.date, 1).replace(/-/g, "");
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`);
    }
    const desc = [`Project: ${p.data.name}${p.data.number ? " (" + p.data.number + ")" : ""}`, d.type ? `Type: ${d.type}` : "", d.area ? `Area: ${d.area}` : "",
      d.inspector ? `Inspector: ${d.inspector}${d.agency ? " (" + d.agency + ")" : ""}` : (d.agency ? `Agency: ${d.agency}` : ""), d.phone ? `Phone: ${d.phone}` : "",
      (d.attendees || []).length ? `NetPower attending: ${(d.attendees || []).map(PM.contactName).filter(Boolean).join(", ")}` : "", d.notes ? `\n${d.notes}` : "",
      `\nOpen in NetPower PM: ${location.origin}/pm#/p/${p.id}/inspections`].filter(Boolean).join("\n");
    lines.push(`SUMMARY:${icsText(summary(p, d))}`, `LOCATION:${icsText([projectAddress(p) || p.data.name, d.area].filter(Boolean).join(" — "))}`, `DESCRIPTION:${icsText(desc)}`,
      `STATUS:${d.status === "Cancelled" ? "CANCELLED" : "CONFIRMED"}`);
    if (d.status !== "Cancelled") lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(summary(p, d))}`, "TRIGGER:-PT1H", "END:VALARM");
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }
  const icsName = (p, d) => `Inspection ${d.date} ${d.type || ""} ${p.data.name}`.replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "").replace(/\s+/g, " ").trim().slice(0, 90) + ".ics";
  function downloadIcs(p, rec) {
    PM.exporter.saveFile(new Blob([icsFor(p, rec)], { type: "text/calendar" }), icsName(p, rec.data));
    toast("Calendar file downloaded — open it to add the inspection to Outlook");
  }

  function emailInvite(p, rec) {
    const d = rec.data;
    const people = [...new Set([...(d.attendees || []), p.data.pmId, p.data.superId].filter(Boolean))].map(id => Store.get(id)).filter(c => c && c.data.email);
    PM.openModal({
      title: "Email inspection invite",
      saveLabel: "Create email",
      noRender: true,
      body: `<p class="muted" style="margin-top:0">Downloads an email draft for Outlook with the calendar invite attached. Open it, check it and press Send — each person opens the attachment to add the inspection to their calendar.</p>
        <div class="field"><label>To</label><div class="checks">${people.map(c => `<label><input type="checkbox" name="ivTo" value="${esc(c.data.email)}" ${(d.attendees || []).includes(c.id) ? "checked" : ""}> ${esc(c.data.name)} <span class="muted">${esc(c.data.email)}</span></label>`).join("") || `<span class="muted">Nobody attending has an email address in the Directory.</span>`}</div></div>
        <div class="field"><label for="ivMore">Other recipients</label><input id="ivMore" placeholder="name@company.com"></div>
        <div class="field"><label for="ivNote">Message (optional)</label><textarea id="ivNote"></textarea></div>`,
      onSave: async root => {
        const to = [...$$("input[name=ivTo]:checked", root).map(i => i.value), ...$("#ivMore", root).value.split(/[,;\s]+/).filter(x => /@/.test(x))];
        const body = [$("#ivNote", root).value.trim(), "", summary(p, d), `When: ${PM.fmtDate(d.date)}${d.time ? " at " + fmtTime(d.time) : " (time to be confirmed)"}`,
          `Where: ${[projectAddress(p) || p.data.name, d.area].filter(Boolean).join(" — ")}`, d.inspector || d.agency ? `Inspector: ${[d.inspector, d.agency].filter(Boolean).join(", ")}` : "",
          d.notes ? `\n${d.notes}` : "", "", "Open the attached invite to add it to your calendar.", "", `— ${PM.meName()}`].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
        const eml = await PM.exporter.emlDraft({ to, subject: summary(p, d), body, attachments: [{ blob: new Blob([icsFor(p, rec)], { type: "text/calendar" }), name: "inspection.ics", type: "text/calendar; method=PUBLISH; charset=utf-8" }] });
        PM.exporter.saveFile(eml, icsName(p, d).replace(/\.ics$/, ".eml"));
        toast("Email draft downloaded — open it to send the invite from Outlook");
        return true;
      }
    });
  }

  const fmtTime = t => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

  // ── Add / edit
  function editInspection(p, rec, preset) {
    const d = rec ? rec.data : { status: "Scheduled", date: PM.today(), time: "09:00", hours: 1, attendees: [p.data.superId].filter(Boolean), ...(preset || {}) };
    const contacts = PM.projectContacts ? PM.projectContacts(p) : PM.contacts();
    let files = (d.attachments || []).slice();
    const drawFiles = root => { $("#inFiles", root).innerHTML = files.map((f, i) => `<div>📎 ${esc(f.name)} <button type="button" class="btn small" data-rmf="${i}">Remove</button></div>`).join(""); };
    PM.openModal({
      title: rec ? "Edit Inspection" : "Schedule Inspection",
      wide: true,
      body: `<div class="form-grid">
          <div class="field"><label for="inType">Inspection type</label><select id="inType">${TYPES.map(t => `<option ${d.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
          <div class="field"><label for="inTitle">Description</label><input id="inTitle" value="${esc(d.title || "")}" placeholder="e.g. 2nd floor rough-in, units 2A–2F"></div>
          <div class="field"><label for="inDate">Date</label><input id="inDate" type="date" value="${esc(d.date || "")}"></div>
          <div class="field"><label for="inTime">Time <span class="muted">(leave empty if not confirmed)</span></label><input id="inTime" type="time" value="${esc(d.time || "")}"></div>
          <div class="field"><label for="inStatus">Status</label><select id="inStatus">${STATUSES.map(t => `<option ${d.status === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
          <div class="field full"><label>Who from our side is attending</label><div class="checks">${contacts.map(c => `<label><input type="checkbox" name="inAtt" value="${c.id}" ${(d.attendees || []).includes(c.id) ? "checked" : ""}> ${esc(c.data.name)}</label>`).join("") || `<span class="muted">Add people in the Directory first.</span>`}</div></div>
          <div class="field full"><label for="inNotes">Notes</label><textarea id="inNotes">${esc(d.notes || "")}</textarea></div>
          <div class="field full"><label>Files (permit, sign-off sheet, photos)</label><div id="inFiles"></div><input type="file" id="inUpload" multiple></div>
        </div>`,
      onOpen: root => {
        drawFiles(root);
        $("#inFiles", root).onclick = e => { const b = e.target.closest("[data-rmf]"); if (b) { files.splice(Number(b.dataset.rmf), 1); drawFiles(root); } };
        $("#inUpload", root).onchange = async e => {
          for (const file of e.target.files) {
            const row = document.createElement("div"); row.textContent = "Uploading " + file.name + "…"; $("#inFiles", root).appendChild(row);
            try { files.push({ name: file.name, url: await PM.files.upload(`attachments/${p.id}/inspections`, file), type: file.type, size: file.size }); }
            catch (err) { toast("Upload failed: " + err.message, true); }
          }
          e.target.value = ""; drawFiles(root);
        };
      },
      onSave: async root => {
        const v = id => $("#" + id, root).value.trim();
        if (!v("inDate")) { toast("Pick a date", true); return false; }
        if ($("#inFiles", root).textContent.includes("Uploading")) { toast("Wait for the files to finish uploading", true); return false; }
        const data = { ...(rec ? rec.data : { createdBy: PM.meName(), createdAt: new Date().toISOString() }),
          type: v("inType"), title: v("inTitle"), date: v("inDate"), time: v("inTime"), status: v("inStatus"),
          notes: v("inNotes"),
          attendees: $$("input[name=inAtt]:checked", root).map(i => i.value), attachments: files };
        // Calendar programs only update an existing event when its sequence number goes up
        if (rec && ["date", "time", "status", "type", "title"].some(k => String(rec.data[k] || "") !== String(data[k] || ""))) data.seq = (rec.data.seq || 0) + 1;
        const removed = rec ? (rec.data.attachments || []).filter(f => !files.some(x => x.url === f.url)).map(f => f.url) : [];
        const next = PM.withHistory({ id: rec ? rec.id : PM.uid("insp"), type: "inspection", projectId: p.id, data },
          rec ? (rec.data.status !== data.status ? `Status changed to ${data.status}` : "Edited") : "Scheduled");
        if (!(await PM.saveRec(next, rec ? "Inspection saved" : "Inspection scheduled"))) return false;
        if (removed.length) PM.files.deleteFiles(removed).catch(() => {});
        if (!rec && data.status === "Scheduled") setTimeout(() => afterCreate(p, Store.get(next.id) || next), 50);
        return true;
      }
    });
  }
  function afterCreate(p, rec) {
    PM.openModal({
      title: "Add it to Outlook?",
      hideSave: true,
      noRender: true,
      body: `<p style="margin-top:0">${esc(summary(p, rec.data))}<br><span class="muted">${esc(PM.fmtDate(rec.data.date))}${rec.data.time ? " at " + fmtTime(rec.data.time) : ""}</span></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="acIcs">📅 Add to my calendar</button><button class="btn" id="acMail">✉ Email invite…</button><button class="btn" data-close>Not now</button></div>`,
      onOpen: root => {
        $("#acIcs", root).onclick = () => { downloadIcs(p, rec); PM.closeModal(); };
        $("#acMail", root).onclick = () => { PM.closeModal(); emailInvite(p, rec); };
        $$("[data-close]", root).forEach(b => b.onclick = PM.closeModal);
      }
    });
  }

  // ── Page
  function page(p, query) {
    const key = "netpower_pm_insp_view";
    const view = PM.lsGet(key, "upcoming") || "upcoming";
    const list = all(p).filter(r => view === "all" || (view === "upcoming" ? r.data.status === "Scheduled" : r.data.status !== "Scheduled"))
      .sort((a, b) => (view === "past" ? -1 : 1) * when(a.data).localeCompare(when(b.data)));
    const canEdit = PM.can(p.id, "inspections", "standard"), canDel = PM.can(p.id, "inspections", "admin");
    setTimeout(() => {
      const add = $("#inAdd"); if (add) add.onclick = () => editInspection(p, null);
      $$("[data-inview]").forEach(b => b.onclick = e => { e.preventDefault(); PM.lsSet(key, b.dataset.inview); PM.render(); });
      $$("[data-in]").forEach(b => b.onclick = async () => {
        const rec = Store.get(b.dataset.id);
        const act = b.dataset.in;
        if (act === "ics") downloadIcs(p, rec);
        if (act === "mail") emailInvite(p, rec);
        if (act === "edit") editInspection(p, rec);
        if (act === "reinspect") editInspection(p, null, { type: "Re-inspection", title: [rec.data.type, rec.data.title].filter(Boolean).join(" - "), area: rec.data.area, inspector: rec.data.inspector, agency: rec.data.agency, phone: rec.data.phone, attendees: rec.data.attendees, date: PM.addDays(PM.today(), 1), notes: rec.data.notes ? "Previous inspection: " + rec.data.notes : "" });
        if (act === "del") {
          if (!window.confirm("Delete this inspection?")) return;
          try { await Store.remove(rec.id); PM.files.deleteFiles((rec.data.attachments || []).map(f => f.url)).catch(() => {}); toast("Deleted"); PM.render(); } catch (e) { toast(e.message, true); }
        }
      });
      if (query && query.get("new") && canEdit) editInspection(p, null);
    }, 0);
    const counts = { upcoming: all(p).filter(r => r.data.status === "Scheduled").length };
    return `<div class="page-head"><h1>Inspections</h1><span class="sub">${counts.upcoming} scheduled</span>
        <div class="actions">${canEdit ? `<button class="btn primary" id="inAdd">+ Schedule Inspection</button>` : ""}</div></div>
      <div class="tabs">${[["upcoming", "Scheduled"], ["past", "Results"], ["all", "All"]].map(([k, l]) => `<a href="#" data-inview="${k}" class="${view === k ? "on" : ""}">${l}</a>`).join("")}</div>
      <div class="panel flush">${list.length ? `<div class="table-wrap"><table class="list insp-list"><thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Attending</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.map(r => { const d = r.data; const late = d.status === "Scheduled" && d.date < PM.today(); return `<tr>
          <td class="nowrap ${late ? "overdue" : ""}"><strong>${esc(PM.fmtDate(d.date))}</strong>${d.date === PM.today() ? ` <span class="pill open">Today</span>` : ""}</td>
          <td class="nowrap">${esc(fmtTime(d.time)) || `<span class="muted">TBD</span>`}</td>
          <td>${esc(d.type)}${d.title ? `<div class="muted">${esc(d.title)}</div>` : ""}</td>
          <td>${esc((d.attendees || []).map(PM.contactName).filter(Boolean).join(", "))}</td>
          <td><span class="pill ${PILL[d.status] || ""}">${esc(d.status)}</span>${(d.attachments || []).length ? `<div>${d.attachments.map(f => `<a href="#" data-dl="${esc(f.url)}" data-name="${esc(f.name)}" title="${esc(f.name)}">📎</a>`).join(" ")}</div>` : ""}</td>
          <td class="nowrap">
            ${d.status === "Scheduled" ? `<button class="btn small" data-in="ics" data-id="${r.id}" title="Download a calendar file for Outlook">📅 Calendar</button> <button class="btn small" data-in="mail" data-id="${r.id}" title="Email an invite with the calendar file attached">✉ Invite</button>` : ""}
            ${["Failed", "Partial"].includes(d.status) && canEdit ? `<button class="btn small" data-in="reinspect" data-id="${r.id}">Schedule re-inspection</button>` : ""}
            ${canEdit ? `<button class="btn small" data-in="edit" data-id="${r.id}">Edit</button>` : ""}
            ${canDel ? `<button class="btn small danger" data-in="del" data-id="${r.id}">Delete</button>` : ""}</td></tr>`; }).join("")}
        </tbody></table></div>` : `<div class="empty">${view === "upcoming" ? "No inspections scheduled." : "Nothing here yet."}${canEdit && view === "upcoming" ? " Click “Schedule Inspection” to add one — you can then add it to Outlook." : ""}</div>`}</div>`;
  }

  // Small panel for the project home page
  function homePanel(p) {
    if (!PM.can(p.id, "inspections")) return "";
    const next = all(p).filter(r => isUpcoming(r.data)).sort((a, b) => when(a.data).localeCompare(when(b.data))).slice(0, 4);
    return `<div class="panel"><h2>Upcoming Inspections <a class="btn small" style="float:right" href="#/p/${p.id}/inspections">All</a></h2>
      ${next.length ? next.map(r => `<div style="padding:4px 0"><strong>${esc(PM.fmtDate(r.data.date))}</strong> ${esc(fmtTime(r.data.time))} · ${esc(r.data.type)}${r.data.area ? " · " + esc(r.data.area) : ""}</div>`).join("") : `<p class="muted">None scheduled.</p>`}</div>`;
  }

  PM.inspections = { page, homePanel, icsFor, editInspection, TYPES, STATUSES };
})();

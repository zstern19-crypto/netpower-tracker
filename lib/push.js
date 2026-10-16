// NetPower PM — phone push notifications (Web Push).
//
// Each person turns notifications on per phone (the home-screen app on iPhone) and picks what they want in
// Notification settings. Records (never served by the normal API — only through the actions in api/pm.js):
//   pushkeys_company   type "pushkeys"  the server's VAPID key pair (created automatically on first use)
//   psub_<hash>        type "pushsub"   one phone/browser subscription; ProjectID = user id
//   npref_<userId>     type "pushpref"  which categories the user wants
import crypto from "node:crypto";
import webpush from "web-push";
import * as db from "./db.js";
import * as auth from "./auth.js";

export const CATEGORIES = [
  ["assigned", "Assigned to me / ball in my court", "RFIs, tasks, punch items and Job Tracker steps handed to you", true],
  ["rfi", "Responses on my RFIs", "Someone answers an RFI you manage or created", true],
  ["changeorder", "Change orders", "Your “remind me” comes due, and when a change order is approved or rejected", true],
  ["daily", "Morning summary", "Once a day: missing daily logs, overdue tasks, expiring certifications, late tools", false]
];
const KEYS_ID = "pushkeys_company";
const SUBJECT = "mailto:" + (process.env.PUSH_CONTACT_EMAIL || "zevy@netpowerelectric.com");

let keysP = null;
async function keys() {
  if (!keysP) keysP = (async () => {
    const k = await db.get(KEYS_ID);
    if (k && k.data.publicKey) return k.data;
    const fresh = webpush.generateVAPIDKeys();
    await db.save([{ id: KEYS_ID, type: "pushkeys", projectId: "", data: { ...fresh, createdAt: new Date().toISOString() } }]);
    return fresh;
  })().catch(e => { keysP = null; throw e; });
  return keysP;
}
export async function publicKey() { return (await keys()).publicKey; }

const subId = endpoint => "psub_" + crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 32);
export async function subscribe(user, sub, ua) {
  const ok = sub && typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000 &&
    sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string";
  if (!ok) throw auth.httpError(400, "That isn't a valid push subscription");
  const id = subId(sub.endpoint);
  await db.save([{ id, type: "pushsub", projectId: user.id, data: { userId: user.id, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, ua: String(ua || "").slice(0, 200), at: new Date().toISOString() } }]);
}
export async function unsubscribe(user, endpoint) {
  const rows = (await db.listRows(db.eq("RecID", subId(endpoint)))).filter(row => { const r = db.toRecord(row); return r.type === "pushsub" && r.projectId === user.id; });
  if (rows.length) await db.removeRows(rows.map(row => row.id));
}
// The user's phones/browsers; `endpoint` (optional) marks the one asking, so the app can tell whether *this* phone is signed up
export async function devices(user, endpoint) {
  const mine = endpoint ? subId(endpoint) : "";
  return (await db.find(db.and([db.eq("Type", "pushsub"), db.eq("ProjectID", user.id)]))).map(r => ({
    ua: r.data.ua, at: r.data.at, thisDevice: r.id === mine, lastError: r.data.lastError || "", lastErrorAt: r.data.lastErrorAt || "", lastOkAt: r.data.lastOkAt || "" }));
}
// Admins: who has notifications turned on (device count and whether "assigned to me" is on)
export async function team() {
  const [users, subs] = await Promise.all([db.find(db.eq("Type", "user")), db.find(db.eq("Type", "pushsub"))]);
  const active = users.filter(u => u.data.active !== false);
  const prefRecs = await db.getMany(active.map(u => "npref_" + u.id));
  return active.map(u => {
    const saved = (prefRecs["npref_" + u.id] && prefRecs["npref_" + u.id].rec.data.cats) || {};
    const errs = subs.filter(s => s.projectId === u.id && s.data.lastError);
    return { name: u.data.name, devices: subs.filter(s => s.projectId === u.id).length, assigned: saved.assigned != null ? !!saved.assigned : true, problem: errs.length ? errs[0].data.lastError : "" };
  }).sort((a, b) => b.devices - a.devices || a.name.localeCompare(b.name));
}

export async function prefs(userId) {
  const r = await db.get("npref_" + userId);
  const saved = (r && r.data.cats) || {};
  return Object.fromEntries(CATEGORIES.map(([k, , , def]) => [k, saved[k] != null ? !!saved[k] : def]));
}
export async function savePrefs(userId, cats) {
  const clean = Object.fromEntries(CATEGORIES.map(([k]) => [k, !!(cats && cats[k])]));
  await db.save([{ id: "npref_" + userId, type: "pushpref", projectId: userId, data: { cats: clean, at: new Date().toISOString() } }]);
  return clean;
}

// Send one notification to each of these users (who have this category on). Dead subscriptions are removed.
export async function sendToUsers(userIds, category, payload, opts = {}) {
  userIds = [...new Set(userIds.filter(id => db.ID_RE.test(id || "")))];
  if (!userIds.length) return 0;
  const subs = (await db.listRows(db.and([db.eq("Type", "pushsub"), db.or(userIds.map(id => db.eq("ProjectID", id)))]))).map(row => ({ ...db.toRecord(row), row: row.id }));
  if (!subs.length) return 0;
  const withSubs = [...new Set(subs.map(s => s.projectId))];
  const prefRecs = await db.getMany(withSubs.map(id => "npref_" + id));
  const wants = id => { const p = prefRecs["npref_" + id]; const cats = (p && p.rec.data.cats) || {}; const def = CATEGORIES.find(c => c[0] === category); return cats[category] != null ? !!cats[category] : !!(def && def[3]); };
  const k = await keys();
  const body = JSON.stringify({ title: payload.title || "NetPower PM", body: payload.body || "", url: payload.url || "/pm/", tag: payload.tag || category });
  const dead = [], marks = [];   // marks: subscriptions whose last-error note changes (saved, so Notification settings can show it)
  let sent = 0;
  const now = new Date().toISOString();
  await Promise.allSettled(subs.filter(s => opts.force || wants(s.projectId)).map(async s => {
    try {
      await webpush.sendNotification(s.data.sub, body, { vapidDetails: { subject: SUBJECT, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 24 * 3600, urgency: "high" });
      sent++;
      if (s.data.lastError) marks.push({ id: s.id, type: s.type, projectId: s.projectId, data: { ...s.data, lastError: "", lastErrorAt: "", lastOkAt: now } });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(s);
      else {
        console.error("push failed", e.statusCode || "", e.message, e.body || "");
        const why = `${e.statusCode || ""} ${String(e.body || e.message || "").slice(0, 160)}`.trim();
        marks.push({ id: s.id, type: s.type, projectId: s.projectId, data: { ...s.data, lastError: why, lastErrorAt: now } });
      }
    }
  }));
  if (dead.length) await db.removeRows(dead.map(s => s.row)).catch(() => {});
  if (marks.length) await db.save(marks).catch(() => {});
  return sent;
}

// ── What changed in a save → who gets told. Never notifies the person who made the change.
export async function onSaved(ctx, records, existing) {
  const interesting = records.filter(r => ["rfi", "task", "punch", "jobstatus", "changeorder"].includes(r.type));
  if (!interesting.length) return;
  const users = await auth.cached("push:users", 60000, () => db.find(db.eq("Type", "user")));
  const userOfContact = cid => { const u = cid && users.find(x => x.data.contactId === cid && x.data.active !== false); return u ? u.id : ""; };
  const me = ctx.user.id;
  const sends = [];   // [userIds, category, payload]
  const projects = await db.getMany([...new Set(interesting.map(r => r.projectId))]);
  const pname = pid => (projects[pid] ? projects[pid].rec.data.name : "");
  const by = ctx.user.data.name;
  for (const r of interesting) {
    const old = existing[r.id] ? existing[r.id].rec.data : null, d = r.data, url = id => `/pm/#/p/${r.projectId}/${id}`;
    if (r.type === "rfi") {
      const was = old && old.status !== "Draft" ? (old.assignees || []) : [];
      const added = d.status === "Draft" ? [] : (d.assignees || []).filter(c => !was.includes(c));
      if (added.length) sends.push([added.map(userOfContact), "assigned", { title: `RFI #${d.number} needs your answer`, body: `${d.subject || ""} — ${pname(r.projectId)} (from ${by})`, url: url("rfis/" + r.id) }]);
      if (old && (d.responses || []).length > (old.responses || []).length) {
        const x = d.responses[d.responses.length - 1];
        sends.push([[userOfContact(d.managerId), d.createdByUserId], "rfi", { title: `${x.official ? "Official answer" : "New response"} on RFI #${d.number}`, body: `${x.by}: ${String(x.text || "").slice(0, 120)} — ${pname(r.projectId)}`, url: url("rfis/" + r.id) }]);
      }
    }
    if ((r.type === "task" || r.type === "punch") && d.assigneeId && d.assigneeId !== (old && old.assigneeId) && d.status !== "Done" && d.status !== "Closed") {
      sends.push([[userOfContact(d.assigneeId)], "assigned", { title: r.type === "task" ? "New task for you" : `Punch item #${d.number} assigned to you`, body: `${d.title || ""} — ${pname(r.projectId)}${d.due ? " · due " + d.due : ""} (from ${by})`, url: url((r.type === "task" ? "tasks/" : "punch/") + r.id) }]);
    }
    if (r.type === "jobstatus") {
      for (const [sid, v] of Object.entries(d.steps || {})) {
        const was = old && old.steps && old.steps[sid] ? old.steps[sid].bic : "";
        if (v.bic && v.bic !== was && !["done", "na"].includes(v.state)) sends.push([[userOfContact(v.bic)], "assigned", { title: "Ball in your court", body: `${v.stepName || "Job step"} — ${pname(r.projectId)} (from ${by})`, url: `/pm/#/jobs/${r.projectId}` }]);
      }
    }
    if (r.type === "changeorder" && old && d.status !== old.status && ["Approved", "Rejected"].includes(d.status)) {
      sends.push([[d.remindUserId, d.createdByUserId], "changeorder", { title: `CO #${d.number} ${d.status.toLowerCase()}`, body: `${d.title || ""} — ${pname(r.projectId)} (by ${by})`, url: url("changeorders/" + r.id) }]);
    }
  }
  for (const [ids, cat, payload] of sends) await sendToUsers(ids.filter(id => id && id !== me), cat, payload).catch(e => console.error("push", e.message));
}

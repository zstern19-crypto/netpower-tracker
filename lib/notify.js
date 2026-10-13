// NetPower PM — reminders and alerts (daily logs, certifications).
// Used by the app's notification bell; the same rules will drive email / WhatsApp reminders.
//
// Daily log reminder settings: type "logsetting", id "ls_<projectId>", ProjectID = project, Data =
//   { enabled, since: "YYYY-MM-DD", frequency: "daily"|"weekly", days: [1..5] (0 = Sun), weekDay: 5, due: "16:00",
//     tz: "America/New_York", foremanIds: [userId], pmIds: [userId], escalateHours: 2 }
// Certifications: type "cert", ProjectID = "", Data = { userId, name, number, issuer, issued, expires, file }

import * as db from "./db.js";

const DAY = 864e5;
export const CERT_WARN_DAYS = 30;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Local calendar date / time in a time zone
export function localParts(date, tz) {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(date).map(p => [p.type, p.value]));
  } catch (e) { return localParts(date, "UTC"); }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), dow: DOW.indexOf(parts.weekday) };
}
const toMin = hhmm => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : 16 * 60; };
const logId = (pid, date) => "log_" + pid + "_" + date.replace(/-/g, "");
export const fmtTime = hhmm => { const m = toMin(hhmm), h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0"); return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`; };

// Days (last 7, newest first) on which a log is expected for these settings
export function expectedLogs(st, now = new Date()) {
  const out = [];
  const nowL = localParts(now, st.tz);
  const due = toMin(st.due);
  for (let k = 0; k < 7; k++) {
    const L = localParts(new Date(now.getTime() - k * DAY), st.tz);
    const expected = st.frequency === "weekly" ? L.dow === Number(st.weekDay ?? 5) : (st.days || [1, 2, 3, 4, 5]).map(Number).includes(L.dow);
    if (!expected || (st.since && L.date < st.since)) continue;  // nothing is "missing" from before reminders were turned on
    const overdueMin = k * 1440 + nowL.minutes - due;  // minutes past the due time (negative = not due yet)
    out.push({ date: L.date, overdueMin, today: k === 0 });
  }
  return out;
}
// For weekly logs any log in the 7 days up to the due day counts
function hasLog(st, pid, date, logIds) {
  if (st.frequency !== "weekly") return logIds.has(logId(pid, date));
  const d0 = new Date(date + "T12:00:00Z").getTime();
  for (let i = 0; i < 7; i++) if (logIds.has(logId(pid, new Date(d0 - i * DAY).toISOString().slice(0, 10)))) return true;
  return false;
}

// Missing / due daily logs for a set of settings records
export async function dailyLogStatus(settings, now = new Date()) {
  const active = settings.filter(s => s.data.enabled && s.projectId);
  if (!active.length) return [];
  const dates = new Set();
  active.forEach(s => expectedLogs(s.data, now).forEach(e => { for (let i = 0; i < 7; i++) dates.add(new Date(new Date(e.date + "T12:00:00Z").getTime() - i * DAY).toISOString().slice(0, 10).replace(/-/g, "")); }));
  const logs = await db.find(db.and([db.eq("Type", "dailylog"), db.or(active.map(s => db.eq("ProjectID", s.projectId))), db.or([...dates].map(d => `FIND('_${d}',{RecID})`))]));
  const logIds = new Set(logs.map(l => l.id));
  const out = [];
  for (const s of active) {
    for (const e of expectedLogs(s.data, now)) {
      if (hasLog(s.data, s.projectId, e.date, logIds)) continue;
      const escalateMin = Math.max(0, Number(s.data.escalateHours ?? 2)) * 60;
      out.push({ projectId: s.projectId, date: e.date, today: e.today, due: s.data.due || "16:00", overdueMin: e.overdueMin,
        state: e.overdueMin < 0 ? "due" : e.overdueMin >= escalateMin ? "escalated" : "missing", settings: s.data });
    }
  }
  return out;
}

export function certState(c, now = new Date()) {
  if (!c.data.expires) return "valid";
  const days = Math.floor((new Date(c.data.expires + "T23:59:59Z").getTime() - now.getTime()) / DAY);
  return days < 0 ? "expired" : days <= CERT_WARN_DAYS ? "expiring" : "valid";
}

// Notifications for one signed-in user
export async function forUser(ctx, now = new Date()) {
  const uid = ctx.user.id;
  const [settings, certs, projects] = await Promise.all([db.find(db.eq("Type", "logsetting")), db.find(db.eq("Type", "cert")), db.find(db.eq("Type", "project"))]);
  const pname = id => { const p = projects.find(x => x.id === id); return p ? p.data.name : "a project"; };
  const out = [];
  const mine = settings.filter(s => (s.data.foremanIds || []).includes(uid) || (s.data.pmIds || []).includes(uid));
  // One line per project: "missing" for the foreman, "escalated" for the PM
  const status = await dailyLogStatus(mine, now);
  const days = list => (list.length === 1 ? list[0].date : `${list.length} days (latest ${list[0].date})`);
  for (const pid of [...new Set(status.map(m => m.projectId))]) {
    const ms = status.filter(m => m.projectId === pid);  // newest first
    const st = ms[0].settings, isForeman = (st.foremanIds || []).includes(uid), isPM = (st.pmIds || []).includes(uid);
    const missing = ms.filter(m => m.state !== "due"), escalated = ms.filter(m => m.state === "escalated"), dueToday = ms.find(m => m.state === "due" && m.today);
    if (isForeman && dueToday) out.push({ kind: "dailylog", level: "info", projectId: pid, href: `#/p/${pid}/dailylog/${dueToday.date}`, text: `Daily log for ${pname(pid)} is due today by ${fmtTime(dueToday.due)}` });
    if (isForeman && missing.length) out.push({ kind: "dailylog", level: "warn", projectId: pid, href: `#/p/${pid}/dailylog/${missing[0].date}`, text: `Daily log missing: ${pname(pid)} — ${days(missing)}` });
    if (isPM && !isForeman && escalated.length) out.push({ kind: "dailylog", level: "danger", projectId: pid, href: `#/p/${pid}/dailylog/${escalated[0].date}`, text: `Foreman hasn't submitted the daily log: ${pname(pid)} — ${days(escalated)}` });
  }
  // Drawing uploads waiting for review (drawing admins)
  const pendingSets = (await db.find(db.and([db.eq("Type", "drawset"), `FIND('"status":"pending"',{Data})`]))).filter(s => ctx.can(s.projectId, "drawings", "admin"));
  for (const s of pendingSets) out.push({ kind: "drawings", level: "warn", projectId: s.projectId, href: `#/p/${s.projectId}/drawings/review/${s.id}`, text: `Drawings waiting for your review: ${s.data.name} (${(s.data.pendingSheets || []).length} sheets) — ${pname(s.projectId)}` });
  const users = ctx.isAdmin ? await db.find(db.eq("Type", "user")) : [];
  const uname = id => (id === uid ? "Your" : ((users.find(u => u.id === id) || { data: { name: "Someone" } }).data.name + "'s"));
  for (const c of certs.filter(c => ctx.isAdmin || c.data.userId === uid)) {
    const st = certState(c, now);
    if (st === "valid") continue;
    out.push({ kind: "cert", level: st === "expired" ? "danger" : "warn", href: "#/manpower/certs", text: `${uname(c.data.userId)} ${c.data.name || "certification"} ${st === "expired" ? "expired" : "expires"} ${c.data.expires}` });
  }
  return out;
}

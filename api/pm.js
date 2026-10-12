// NetPower PM — API with logins and per-project permissions (see lib/auth.js).
//
// Auth actions:
//   GET  /api/pm?action=me                    → current user + permissions (401 if signed out)
//   POST /api/pm?action=setup     {name,email,password}   → first company admin (only when no users exist)
//   POST /api/pm?action=login     {email,password}
//   POST /api/pm?action=logout
//   POST /api/pm?action=password  {current,password}
//   GET  /api/pm?action=users                 → company admins only
//   POST /api/pm?action=saveUser  {id?,name,email,companyAdmin,active,password?,contactId?,companyId?}
// Records:
//   GET    /api/pm?type=rfi&project=abc
//   POST   /api/pm  { records: [{ id, type, projectId, data }] }   (upsert by id)
//   DELETE /api/pm?id=abc[&children=1]

import * as db from "../lib/db.js";
import * as auth from "../lib/auth.js";

const { ID_RE } = db;
const { TYPE_TOOL, ensure, httpError } = auth;
const TYPES = ["project", "company", "contact", "lookup", "member", "permtemplate", ...Object.keys(TYPE_TOOL)];
const PRIVATE_TYPES = ["rfi", "submittal"];

// ── Helpers ──

// The project a record belongs to. Photos are stored under their punch item.
async function projectOf(type, projectId) {
  if (type !== "photo") return projectId;
  const punch = await db.get(projectId);
  return punch && punch.type === "punch" ? punch.projectId : null;
}

function canSeePrivate(ctx, rec) {
  if (!PRIVATE_TYPES.includes(rec.type) || !rec.data.private) return true;
  if (ctx.can(rec.projectId, TYPE_TOOL[rec.type], "admin")) return true;
  const me = ctx.contactId;
  if (!me) return false;
  const d = rec.data;
  return [d.managerId, d.receivedFromId, d.responsibleId, d.createdById,
    ...(d.assignees || []), ...(d.distribution || []), ...(d.workflow || []).map(w => w.contactId)].includes(me);
}

async function checkRead(ctx, type, project) {
  if (type === "project" || type === "company" || type === "contact") return;
  if (type === "member" || type === "permtemplate") return ensure(ctx.isAdmin);
  ensure(project && ID_RE.test(project), "A project is required");
  const pid = await projectOf(type, project);
  ensure(pid, "Not found");
  if (type === "lookup") return ensure(ctx.isMember(pid));
  ensure(ctx.can(pid, TYPE_TOOL[type], "read"));
}

// Write check for one record (new state) and, for updates, its stored version.
async function checkWrite(ctx, rec, stored) {
  const t = rec.type;
  if (t === "user") ensure(false);
  if (t === "company" || t === "contact" || t === "member" || t === "permtemplate") return ensure(ctx.isAdmin, "Only company admins can change this");
  if (t === "project") {
    if (!stored) return ensure(ctx.isAdmin, "Only company admins can create projects");
    return ensure(ctx.isAdmin || ctx.can(rec.id, "admin", "admin") || ctx.can(rec.id, "directory", "admin"));
  }
  for (const r of stored ? [rec, stored] : [rec]) {
    ensure(r.projectId && ID_RE.test(r.projectId), "A project is required");
    const pid = await projectOf(r.type, r.projectId);
    ensure(pid, "Not found");
    if (t === "lookup") {
      ensure(auth.TOOL_IDS.some(tool => ctx.can(pid, tool, "standard")));
      continue;
    }
    ensure(ctx.can(pid, TYPE_TOOL[t], "standard"));
    if (t === "markup" && !ctx.can(pid, "drawings", "admin")) ensure(r.data.ownerId === ctx.contactId, "You can only change your own markups");
  }
  if (stored && PRIVATE_TYPES.includes(t)) ensure(canSeePrivate(ctx, stored));
}

async function checkDelete(ctx, rec) {
  const t = rec.type;
  if (["project", "company", "contact", "member", "permtemplate", "user"].includes(t)) return ensure(ctx.isAdmin, "Only company admins can delete this");
  const pid = await projectOf(t, rec.projectId);
  ensure(pid, "Not found");
  if (t === "lookup") return ensure(ctx.can(pid, "admin", "admin"));
  const tool = TYPE_TOOL[t];
  if (ctx.can(pid, tool, "admin")) return;
  // Standard users may remove their own markups and photos
  const own = (t === "markup" && rec.data.ownerId === ctx.contactId) || (t === "photo" && rec.data.byId && rec.data.byId === ctx.contactId);
  ensure(own && ctx.can(pid, tool, "standard"), "Only admins of this tool can delete it");
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
}

// ── Auth actions ──

async function createUser({ name, email, password, companyAdmin, contactId, companyId }) {
  name = String(name || "").trim();
  email = auth.normEmail(email);
  if (!name) throw httpError(400, "Name is required");
  if (!auth.EMAIL_RE.test(email)) throw httpError(400, "Enter a valid email address");
  auth.validatePassword(password);
  if ((await db.find(db.and([db.eq("Type", "user"), db.eq("ProjectID", email)]))).length) throw httpError(400, "A user with this email already exists");

  const now = new Date().toISOString();
  const records = [];
  if (!contactId || !ID_RE.test(contactId) || !(await db.get(contactId))) {
    contactId = "ct_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    records.push({ id: contactId, type: "contact", projectId: "", data: { name, email, companyId: ID_RE.test(companyId || "") ? companyId : "" } });
  }
  const user = {
    id: "usr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), type: "user", projectId: email,
    data: { name, email, companyAdmin: !!companyAdmin, active: true, contactId, sessionVersion: 1, createdAt: now, ...auth.hashPassword(password) }
  };
  records.push(user);
  await db.save(records);
  auth.clearCache();
  return user;
}

async function handleAction(req, res, action) {
  const b = body(req);

  if (action === "me") {
    const ctx = await auth.getContext(req);
    if (!ctx) {
      const setup = (await auth.userCount()) === 0;
      throw httpError(401, setup ? "Create the first admin account" : "Please sign in", setup ? "SETUP_REQUIRED" : "AUTH_REQUIRED");
    }
    return res.status(200).json({ ok: true, user: auth.publicUser(ctx.user), isAdmin: ctx.isAdmin, perms: ctx.perms, tools: auth.TOOLS, levels: auth.LEVELS });
  }

  if (req.method !== "POST" && action !== "users") throw httpError(405, "Method not allowed");

  if (action === "setup") {
    ensure((await db.find(db.eq("Type", "user"))).length === 0, "Setup has already been completed — please sign in");
    const user = await createUser({ ...b, companyAdmin: true });
    if (!(await auth.templates()).length) {
      await db.save(auth.DEFAULT_TEMPLATES.map(t => ({ id: t.id, type: "permtemplate", projectId: "", data: { name: t.name, perms: t.perms } })));
      auth.clearCache();
    }
    res.setHeader("Set-Cookie", auth.sessionCookie(user));
    return res.status(200).json({ ok: true });
  }

  if (action === "login") {
    const email = auth.normEmail(b.email);
    const users = auth.EMAIL_RE.test(email) ? await db.find(db.and([db.eq("Type", "user"), db.eq("ProjectID", email)])) : [];
    const user = users[0];
    if (!user || user.data.active === false || !auth.checkPassword(b.password, user.data.salt, user.data.hash)) {
      await new Promise(r => setTimeout(r, 400));
      throw httpError(401, "Wrong email or password", "LOGIN_FAILED");
    }
    res.setHeader("Set-Cookie", auth.sessionCookie(user));
    return res.status(200).json({ ok: true });
  }

  if (action === "logout") {
    res.setHeader("Set-Cookie", auth.clearCookie());
    return res.status(200).json({ ok: true });
  }

  const ctx = await auth.requireContext(req);

  if (action === "password") {
    const u = ctx.user;
    if (!auth.checkPassword(b.current, u.data.salt, u.data.hash)) throw httpError(400, "Current password is wrong");
    auth.validatePassword(b.password);
    const next = { ...u, data: { ...u.data, ...auth.hashPassword(b.password), sessionVersion: (u.data.sessionVersion || 1) + 1 } };
    await db.save([next]);
    auth.clearCache();
    res.setHeader("Set-Cookie", auth.sessionCookie(next));
    return res.status(200).json({ ok: true });
  }

  ensure(ctx.isAdmin, "Only company admins can manage users");

  if (action === "users") {
    const users = await db.find(db.eq("Type", "user"));
    return res.status(200).json({ ok: true, users: users.map(auth.publicUser) });
  }

  if (action === "saveUser") {
    if (!b.id) {
      const user = await createUser(b);
      return res.status(200).json({ ok: true, user: auth.publicUser(user) });
    }
    ensure(ID_RE.test(b.id), "Bad user id");
    const u = await db.get(b.id);
    if (!u || u.type !== "user") throw httpError(404, "User not found");
    const data = { ...u.data };
    if (b.name != null) data.name = String(b.name).trim() || data.name;
    let email = u.projectId;
    if (b.email != null && auth.normEmail(b.email) !== email) {
      email = auth.normEmail(b.email);
      if (!auth.EMAIL_RE.test(email)) throw httpError(400, "Enter a valid email address");
      if ((await db.find(db.and([db.eq("Type", "user"), db.eq("ProjectID", email)]))).length) throw httpError(400, "A user with this email already exists");
      data.email = email;
    }
    if (b.companyAdmin != null) data.companyAdmin = !!b.companyAdmin;
    if (b.active != null) data.active = !!b.active;
    if (b.password) {
      auth.validatePassword(b.password);
      Object.assign(data, auth.hashPassword(b.password));
      data.sessionVersion = (data.sessionVersion || 1) + 1;  // signs the user out everywhere
    }
    if (b.active === false) data.sessionVersion = (data.sessionVersion || 1) + 1;
    // Never leave the company without an active admin
    if (u.data.companyAdmin && (!data.companyAdmin || data.active === false)) {
      const admins = (await db.find(db.eq("Type", "user"))).filter(x => x.id !== u.id && x.data.companyAdmin && x.data.active !== false);
      ensure(admins.length > 0, "There must be at least one active company admin");
    }
    const next = { ...u, projectId: email, data };
    await db.save([next]);
    auth.clearCache();
    return res.status(200).json({ ok: true, user: auth.publicUser(next) });
  }

  throw httpError(400, "Unknown action");
}

// ── Handler ──

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (!db.configured()) {
    res.status(503).json({ ok: false, code: "NOT_CONFIGURED", error: "PM_AIRTABLE_TOKEN / PM_AIRTABLE_BASE are not set" });
    return;
  }

  try {
    const action = req.query && req.query.action;
    if (action) return await handleAction(req, res, action);

    const ctx = await auth.requireContext(req);

    if (req.method === "GET") {
      const { type, project } = req.query;
      ensure(TYPES.includes(type), "Unknown type");
      if (project) ensure(ID_RE.test(project), "Bad project id");
      await checkRead(ctx, type, project);
      let records = await db.find(db.and([db.eq("Type", type), ...(project ? [db.eq("ProjectID", project)] : [])]));
      if (type === "project" && !ctx.isAdmin) records = records.filter(r => ctx.isMember(r.id));
      records = records.filter(r => r.id && canSeePrivate(ctx, r));
      // Other people's markups: only what they've published
      if (type === "markup") records = records.map(r => (r.data.ownerId === ctx.contactId ? r
        : { ...r, data: { ...r.data, shapes: (r.data.shapes || []).filter(s => s && s.published) } }));
      return res.status(200).json({ ok: true, records });
    }

    if (req.method === "POST") {
      const records = body(req).records || [];
      ensure(Array.isArray(records) && records.length, "No records");
      for (const r of records) {
        ensure(ID_RE.test(r.id || ""), "Bad record id");
        ensure(TYPES.includes(r.type), "Unknown type");
        ensure(!r.projectId || ID_RE.test(r.projectId), "Bad project id");
        r.data = r.data && typeof r.data === "object" ? r.data : {};
      }
      const existing = await db.getMany(records.map(r => r.id));
      for (const r of records) {
        const stored = existing[r.id] ? existing[r.id].rec : null;
        ensure(!stored || stored.type === r.type, "Record type cannot change");
        await checkWrite(ctx, r, stored);
        if (!stored && TYPE_TOOL[r.type]) {
          r.data.createdById = r.data.createdById || ctx.contactId;
          r.data.createdByUserId = ctx.user.id;
        }
      }
      const result = await db.save(records, existing);
      if (records.some(r => r.type === "member" || r.type === "permtemplate")) auth.clearCache();
      return res.status(200).json({ ok: true, ...result });
    }

    if (req.method === "DELETE") {
      const id = req.query.id;
      ensure(ID_RE.test(id || ""), "Bad record id");
      const rows = await db.listRows(db.eq("RecID", id));
      if (!rows.length) return res.status(200).json({ ok: true, deleted: 0 });
      const rec = db.toRecord(rows[0]);
      await checkDelete(ctx, rec);
      let all = rows;
      if (req.query.children === "1" && rec.type === "punch") all = all.concat(await db.listRows(db.and([db.eq("Type", "photo"), db.eq("ProjectID", id)])));
      const deleted = await db.removeRows(all.map(r => r.id));
      if (rec.type === "member" || rec.type === "permtemplate") auth.clearCache();
      return res.status(200).json({ ok: true, deleted });
    }

    throw httpError(405, "Method not allowed");
  } catch (err) {
    auth.sendError(res, err);
  }
}

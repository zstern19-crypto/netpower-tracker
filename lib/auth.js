// NetPower PM — logins, sessions and per-project tool permissions.
//
// Users:        type "user", ProjectID = lowercase email, Data = { name, email, companyAdmin, active,
//               contactId, salt, hash, sessionVersion }
// Templates:    type "permtemplate", Data = { name, perms: { tool: level } }
// Memberships:  type "member", ProjectID = project id, Data = { userId, templateId, perms|null }
//               (perms set → custom permissions; otherwise the template's)
//
// Company admins can do everything. Everyone else needs a membership on a project, and each
// tool's level decides what they can do: none < read < standard < admin.
//   read      – view
//   standard  – view, create and edit
//   admin     – also delete and manage

import crypto from "node:crypto";
import * as db from "./db.js";

export const TOOLS = [
  ["rfis", "RFIs"],
  ["submittals", "Submittals"],
  ["punch", "Punch List"],
  ["dailylog", "Daily Log"],
  ["drawings", "Drawings"],
  ["specs", "Specifications"],
  ["photos", "Photos"],
  ["manpower", "Manpower"],
  ["inspections", "Inspections"],
  ["directory", "Directory"],
  ["admin", "Admin"]
];
export const TOOL_IDS = TOOLS.map(t => t[0]);
export const LEVELS = ["none", "read", "standard", "admin"];
export const rank = l => Math.max(0, LEVELS.indexOf(l));

// Which tool governs each project-scoped record type
export const TYPE_TOOL = {
  rfi: "rfis", submittal: "submittals", punch: "punch", photo: "punch",
  dailylog: "dailylog", drawing: "drawings", drawset: "drawings", markup: "drawings",
  spec: "specs", subpackage: "submittals",
  jphoto: "photos", deploy: "manpower", logsetting: "dailylog",
  inspection: "inspections", mpplan: "manpower", jobstatus: "admin"
};

const all = level => Object.fromEntries(TOOL_IDS.map(t => [t, level]));
export const DEFAULT_TEMPLATES = [
  { id: "tpl_project_admin", name: "Project Admin", perms: all("admin") },
  { id: "tpl_project_manager", name: "Project Manager", perms: { ...all("standard"), rfis: "admin", submittals: "admin", drawings: "admin", specs: "admin", photos: "admin", manpower: "admin", dailylog: "admin", inspections: "admin", admin: "standard" } },
  { id: "tpl_foreman", name: "Foreman", perms: { rfis: "standard", submittals: "read", punch: "standard", dailylog: "standard", drawings: "standard", specs: "read", photos: "standard", manpower: "read", inspections: "standard", directory: "read", admin: "none" } },
  { id: "tpl_field_crew", name: "Field Crew", perms: { rfis: "read", submittals: "none", punch: "standard", dailylog: "none", drawings: "read", specs: "read", photos: "standard", manpower: "read", inspections: "read", directory: "read", admin: "none" } }
];

export const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
export const normEmail = e => String(e || "").trim().toLowerCase();

// ── Passwords ──
export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
export function checkPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const a = Buffer.from(hashPassword(password, salt).hash, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) throw httpError(400, "Password must be at least 8 characters");
}

// ── Sessions (signed cookie) ──
// PM_SESSION_SECRET if set; otherwise derived from the (secret) Airtable token.
const SECRET = process.env.PM_SESSION_SECRET ||
  crypto.createHmac("sha256", db.TOKEN || "unset").update("netpower-pm-session-v1").digest("hex");
const COOKIE = "pm_session";
const SESSION_DAYS = 30;

const b64u = s => Buffer.from(s).toString("base64url");
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");

export function sessionCookie(user) {
  const payload = b64u(JSON.stringify({ uid: user.id, v: user.data.sessionVersion || 1, exp: Date.now() + SESSION_DAYS * 864e5 }));
  const token = payload + "." + sign(payload);
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readSession(req) {
  const raw = String(req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!s.exp || s.exp < Date.now() || !db.ID_RE.test(s.uid || "")) return null;
    return s;
  } catch (e) { return null; }
}

// ── Short-lived cache (per warm serverless instance) ──
const cache = new Map();
export async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}
export const clearCache = () => cache.clear();

export async function userCount() {
  return cached("userCount", 20000, async () => (await db.find(db.eq("Type", "user"))).length);
}
export async function templates() {
  return cached("templates", 20000, () => db.find(db.eq("Type", "permtemplate")));
}

export function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Public view of a user (never includes password data)
export const publicUser = u => ({
  id: u.id, name: u.data.name, email: u.data.email, companyAdmin: !!u.data.companyAdmin,
  active: u.data.active !== false, contactId: u.data.contactId || "", createdAt: u.data.createdAt || "",
  photo: u.data.photo || "", phone: u.data.phone || "", trade: u.data.trade || "", title: u.data.title || "",
  hasConnector: !!u.data.mcpKeyHash, connectorAt: u.data.mcpKeyAt || ""
});

// Resolve the signed-in user and their permissions. Returns null when not signed in.
export async function getContext(req) {
  const s = readSession(req);
  if (!s) return null;
  const user = await cached("user:" + s.uid, 20000, () => db.get(s.uid));
  if (!user || user.type !== "user" || user.data.active === false || (user.data.sessionVersion || 1) !== s.v) return null;
  return contextFor(user);
}

// ── Claude connector keys: "<userId>.<secret>", only a SHA-256 hash of the secret is stored ──
export const hashKey = secret => crypto.createHash("sha256").update(String(secret)).digest("hex");
export function newConnectorKey(user) {
  const secret = crypto.randomBytes(24).toString("base64url");
  return { key: user.id + "." + secret, hash: hashKey(secret) };
}
export async function contextFromKey(key) {
  const m = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{20,})$/.exec(String(key || ""));
  if (!m) return null;
  const user = await cached("user:" + m[1], 20000, () => db.get(m[1]));
  if (!user || user.type !== "user" || user.data.active === false || !user.data.mcpKeyHash) return null;
  const a = Buffer.from(hashKey(m[2]), "hex"), b = Buffer.from(user.data.mcpKeyHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return contextFor(user);
}

export async function contextFor(user) {
  const isAdmin = !!user.data.companyAdmin;
  const members = isAdmin ? [] : await cached("members:" + user.id, 20000,
    () => db.find(db.and([db.eq("Type", "member"), `FIND('"userId":"${user.id}"',{Data})`])));
  const tpls = isAdmin ? [] : await templates();
  const perms = {};  // projectId → { tool: level }
  for (const m of members) {
    const tpl = tpls.find(t => t.id === m.data.templateId);
    const p = m.data.perms || (tpl && tpl.data.perms) || {};
    // Tools added after a template was saved fall back to the built-in template's level
    const def = !m.data.perms && DEFAULT_TEMPLATES.find(d => d.id === m.data.templateId);
    perms[m.projectId] = Object.fromEntries(TOOL_IDS.map(t => [t, LEVELS.includes(p[t]) ? p[t] : (def && def.perms[t]) || "none"]));
  }

  const level = (projectId, tool) => (isAdmin ? "admin" : (perms[projectId] && perms[projectId][tool]) || "none");
  return {
    user, isAdmin, perms,
    contactId: user.data.contactId || "",
    projectIds: Object.keys(perms),
    level,
    can: (projectId, tool, min) => rank(level(projectId, tool)) >= rank(min),
    isMember: projectId => isAdmin || !!perms[projectId]
  };
}

export async function requireContext(req) {
  const ctx = await getContext(req);
  if (!ctx) throw httpError(401, "Please sign in", "AUTH_REQUIRED");
  return ctx;
}

export function ensure(cond, message = "You don't have permission to do that") {
  if (!cond) throw httpError(403, message, "FORBIDDEN");
}

export function sendError(res, err) {
  const status = err.status || 500;
  res.status(status).json({ ok: false, code: err.code || undefined, error: err.message });
}

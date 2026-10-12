// NetPower PM — Airtable access shared by the API routes.
//
// Every record (projects, users, RFIs, drawings, …) is one row in a single table:
//   RecID (single line text) · Type (single line text) · ProjectID (single line text) · Data (long text, JSON)
//
// Environment variables:
//   PM_AIRTABLE_TOKEN  – Airtable personal access token (data.records:read + data.records:write)
//   PM_AIRTABLE_BASE   – Base ID (starts with "app"); a pasted Airtable URL also works
//   PM_AIRTABLE_TABLE  – Table name (default: "PM Records")

export const TOKEN = (process.env.PM_AIRTABLE_TOKEN || "").trim();
const BASE_RAW = (process.env.PM_AIRTABLE_BASE || "").trim();
export const BASE = (BASE_RAW.match(/app[A-Za-z0-9]{14}/) || [BASE_RAW])[0];
export const TABLE = (process.env.PM_AIRTABLE_TABLE || "").trim() || "PM Records";

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const configured = () => !!(TOKEN && BASE);

function tableUrl(query) {
  return `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}${query ? "?" + query : ""}`;
}

function headers() {
  return { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
}

// Airtable allows roughly 5 requests/second per base; space out calls within one invocation.
let lastCall = 0;
async function throttle() {
  const wait = lastCall + 220 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

async function airtable(url, opts = {}) {
  await throttle();
  let r = await fetch(url, { ...opts, headers: headers() });
  if (r.status === 429) {
    // Rate limited: back off once, then retry
    await new Promise(res => setTimeout(res, 1500));
    r = await fetch(url, { ...opts, headers: headers() });
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    let msg = (d.error && (d.error.message || d.error.type || d.error)) || `Airtable HTTP ${r.status}`;
    if (typeof msg !== "string") msg = JSON.stringify(msg);
    if (r.status === 404 || r.status === 403) {
      // Base IDs and table names aren't secret; naming them makes setup mistakes obvious
      msg += ` (HTTP ${r.status}) — Airtable could not find base "${BASE}" / table "${TABLE}", or the token can't access them. ` +
        `Check PM_AIRTABLE_BASE (should look like app followed by 14 letters/numbers), the table name, and the token's base access.`;
    }
    throw new Error(msg);
  }
  return d;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Raw Airtable rows (with Airtable's own row id) matching a formula
export async function listRows(formula) {
  let out = [];
  let offset = null;
  do {
    const q = new URLSearchParams({ pageSize: "100" });
    if (formula) q.set("filterByFormula", formula);
    if (offset) q.set("offset", offset);
    const d = await airtable(tableUrl(q.toString()));
    out = out.concat(d.records || []);
    offset = d.offset || null;
  } while (offset);
  return out;
}

export function toRecord(row) {
  const f = row.fields || {};
  let data = {};
  try { data = JSON.parse(f.Data || "{}"); } catch (e) { data = {}; }
  return { id: f.RecID, type: f.Type, projectId: f.ProjectID || "", data };
}

// Callers must only pass values validated with ID_RE or other strict patterns (no quotes).
export const eq = (field, value) => `{${field}}='${value}'`;
export const and = parts => (parts.length > 1 ? `AND(${parts.join(",")})` : parts[0] || "");
export const or = parts => (parts.length > 1 ? `OR(${parts.join(",")})` : parts[0] || "FALSE()");

export async function find(formula) {
  return (await listRows(formula)).map(toRecord).filter(r => r.id);
}

export async function getMany(ids) {
  const out = {};
  for (const group of chunk(ids.filter(id => ID_RE.test(id)), 50)) {
    (await listRows(or(group.map(id => eq("RecID", id))))).forEach(row => { out[row.fields.RecID] = { row: row.id, rec: toRecord(row) }; });
  }
  return out;  // RecID → { row: airtable row id, rec }
}

export async function get(id) {
  const m = await getMany([id]);
  return m[id] ? m[id].rec : null;
}

// Upsert by RecID. `existing` (from getMany) may be passed to avoid a second lookup.
export async function save(records, existing) {
  existing = existing || await getMany(records.map(r => r.id));
  const toFields = r => ({ RecID: r.id, Type: r.type, ProjectID: r.projectId || "", Data: JSON.stringify(r.data || {}) });
  const creates = records.filter(r => !existing[r.id]).map(r => ({ fields: toFields(r) }));
  const updates = records.filter(r => existing[r.id]).map(r => ({ id: existing[r.id].row, fields: toFields(r) }));
  for (const batch of chunk(creates, 10)) await airtable(tableUrl(), { method: "POST", body: JSON.stringify({ records: batch }) });
  for (const batch of chunk(updates, 10)) await airtable(tableUrl(), { method: "PATCH", body: JSON.stringify({ records: batch }) });
  return { created: creates.length, updated: updates.length };
}

export async function removeRows(rowIds) {
  for (const batch of chunk(rowIds, 10)) {
    await airtable(tableUrl(batch.map(x => "records[]=" + x).join("&")), { method: "DELETE" });
  }
  return rowIds.length;
}

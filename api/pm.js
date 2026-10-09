// NetPower PM — generic record store backed by a single Airtable table.
//
// Required Vercel environment variables:
//   PM_AIRTABLE_TOKEN  – Airtable personal access token (data.records:read + data.records:write)
//   PM_AIRTABLE_BASE   – Base ID (starts with "app")
//   PM_AIRTABLE_TABLE  – Table name (default: "PM Records")
//
// The table needs four fields (all "Single line text" except Data):
//   RecID (single line text) · Type (single line text) · ProjectID (single line text) · Data (long text)
//
// Every record in the app (projects, companies, contacts, RFIs, submittals,
// daily logs, punch items, photos) is stored as one row; its fields live as JSON in Data.

const TOKEN = process.env.PM_AIRTABLE_TOKEN;
const BASE = process.env.PM_AIRTABLE_BASE;
const TABLE = process.env.PM_AIRTABLE_TABLE || "PM Records";

const TYPES = ["project", "company", "contact", "rfi", "submittal", "dailylog", "punch", "photo"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function tableUrl(query) {
  return `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}${query ? "?" + query : ""}`;
}

function headers() {
  return { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
}

async function airtable(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: headers() });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const msg = (d.error && (d.error.message || d.error.type || d.error)) || `Airtable HTTP ${r.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return d;
}

async function listAll(formula) {
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

function toRecord(row) {
  const f = row.fields || {};
  let data = {};
  try { data = JSON.parse(f.Data || "{}"); } catch (e) { data = {}; }
  return { id: f.RecID, type: f.Type, projectId: f.ProjectID || "", data };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (!TOKEN || !BASE) {
    res.status(503).json({ ok: false, code: "NOT_CONFIGURED", error: "PM_AIRTABLE_TOKEN / PM_AIRTABLE_BASE are not set" });
    return;
  }

  try {
    if (req.method === "GET") {
      // GET /api/pm?type=rfi&project=abc   (project optional)
      const type = req.query.type;
      const project = req.query.project;
      if (type && !TYPES.includes(type)) throw new Error("Unknown type");
      if (project && !ID_RE.test(project)) throw new Error("Bad project id");
      const parts = [];
      if (type) parts.push(`{Type}='${type}'`);
      if (project) parts.push(`{ProjectID}='${project}'`);
      const formula = parts.length > 1 ? `AND(${parts.join(",")})` : parts[0] || "";
      const rows = await listAll(formula);
      res.status(200).json({ ok: true, records: rows.map(toRecord).filter(r => r.id) });
      return;
    }

    if (req.method === "POST") {
      // POST /api/pm  { records: [{ id, type, projectId, data }] }  → upsert by RecID
      const records = (req.body && req.body.records) || [];
      if (!Array.isArray(records) || !records.length) throw new Error("No records");
      for (const r of records) {
        if (!ID_RE.test(r.id || "")) throw new Error("Bad record id");
        if (!TYPES.includes(r.type)) throw new Error("Unknown type");
        if (r.projectId && !ID_RE.test(r.projectId)) throw new Error("Bad project id");
      }

      const existing = {};
      for (const group of chunk(records, 50)) {
        const formula = `OR(${group.map(r => `{RecID}='${r.id}'`).join(",")})`;
        (await listAll(formula)).forEach(row => { existing[row.fields.RecID] = row.id; });
      }

      const toFields = r => ({
        RecID: r.id,
        Type: r.type,
        ProjectID: r.projectId || "",
        Data: JSON.stringify(r.data || {})
      });
      const creates = records.filter(r => !existing[r.id]).map(r => ({ fields: toFields(r) }));
      const updates = records.filter(r => existing[r.id]).map(r => ({ id: existing[r.id], fields: toFields(r) }));

      for (const batch of chunk(creates, 10)) {
        await airtable(tableUrl(), { method: "POST", body: JSON.stringify({ records: batch }) });
      }
      for (const batch of chunk(updates, 10)) {
        await airtable(tableUrl(), { method: "PATCH", body: JSON.stringify({ records: batch }) });
      }
      res.status(200).json({ ok: true, created: creates.length, updated: updates.length });
      return;
    }

    if (req.method === "DELETE") {
      // DELETE /api/pm?id=abc[&children=1]  (children=1 also deletes rows whose ProjectID = id, e.g. photos)
      const id = req.query.id;
      if (!ID_RE.test(id || "")) throw new Error("Bad record id");
      let formula = `{RecID}='${id}'`;
      if (req.query.children === "1") formula = `OR({RecID}='${id}',{ProjectID}='${id}')`;
      const rows = await listAll(formula);
      for (const batch of chunk(rows.map(r => r.id), 10)) {
        await airtable(tableUrl(batch.map(x => "records[]=" + x).join("&")), { method: "DELETE" });
      }
      res.status(200).json({ ok: true, deleted: rows.length });
      return;
    }

    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

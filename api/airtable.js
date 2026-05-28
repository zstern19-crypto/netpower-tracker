const AT_TOKEN = "patzYzQBgJXZlHCr6.8021cd1fcd6fc7d7eb4239bc5096c67b5517a91adeccd58d7eb3c3ae6fccc440";
const AT_BASE  = "appDvscikJtSDsoku";
const AT_TABLE = "Table 1";
 
export default async function handler(req, res) {
  // Allow all origins
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
 
  const action = req.query.action || "read";
  const headers = {
    "Authorization": "Bearer " + AT_TOKEN,
    "Content-Type": "application/json"
  };
 
  try {
    if (action === "read") {
      let allRecords = [];
      let offset = null;
      do {
        const url = `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}?pageSize=100${offset ? "&offset=" + offset : ""}`;
        const r = await fetch(url, { headers });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        allRecords = allRecords.concat(d.records || []);
        offset = d.offset || null;
      } while (offset);
 
      const invoices = allRecords.map(r => {
        const f = r.fields;
        try {
          return {
            id: f.InvID || r.id,
            supplier: f.Supplier || "",
            date: f.Date || "",
            invoice_number: f.InvoiceNum || null,
            weekKey: f.WeekKey || "",
            jobsite: f.Jobsite || "",
            address: f.Address || null,
            na: f.NA || "",
            ca: f.CA || "",
            items: JSON.parse(f.ItemsJSON || "[]"),
            fileName: f.FileName || "",
            uploadedBy: f.UploadedBy || ""
          };
        } catch(e) { return null; }
      }).filter(Boolean);
 
      // Rebuild items
      const items = {};
      invoices.forEach(inv => {
        (inv.items || []).forEach(it => {
          const k = it.name.toLowerCase().trim();
          if (!items[k]) items[k] = { name: it.name, cat: it.cat || "Other", weeks: {} };
          if (it.cat) items[k].cat = it.cat;
          const w = items[k].weeks;
          if (!w[inv.weekKey]) w[inv.weekKey] = { total: 0, qty: 0, unitPrice: 0, count: 0 };
          w[inv.weekKey].total += it.total || 0;
          w[inv.weekKey].qty   += it.qty || 0;
          w[inv.weekKey].count += 1;
          w[inv.weekKey].unitPrice = ((w[inv.weekKey].unitPrice * (w[inv.weekKey].count - 1)) + (it.unit_price || 0)) / w[inv.weekKey].count;
        });
      });
 
      res.status(200).json({ ok: true, data: { invoices, items } });
 
    } else if (action === "write") {
      const { invoices, items } = req.body || {};
 
      // Delete all existing records first
      let existingIds = [];
      let offset = null;
      do {
        const url = `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}?pageSize=100${offset ? "&offset=" + offset : ""}&fields[]=InvID`;
        const r = await fetch(url, { headers });
        const d = await r.json();
        existingIds = existingIds.concat((d.records || []).map(r => r.id));
        offset = d.offset || null;
      } while (offset);
 
      // Delete in batches of 10
      for (let i = 0; i < existingIds.length; i += 10) {
        const batch = existingIds.slice(i, i + 10);
        const params = batch.map(id => `records[]=${id}`).join("&");
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}?${params}`, { method: "DELETE", headers });
      }
 
      // Write new records in batches of 10
      const records = (invoices || []).map(inv => ({
        fields: {
          InvID: inv.id, Supplier: inv.supplier, Date: inv.date,
          InvoiceNum: inv.invoice_number || "",
          WeekKey: inv.weekKey, Jobsite: inv.jobsite,
          Address: inv.address || "", NA: inv.na || "", CA: inv.ca || "",
          ItemsJSON: JSON.stringify(inv.items || []),
          FileName: inv.fileName || "", UploadedBy: inv.uploadedBy || ""
        }
      }));
 
      for (let i = 0; i < records.length; i += 10) {
        const batch = records.slice(i, i + 10);
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}`, {
          method: "POST", headers,
          body: JSON.stringify({ records: batch })
        });
      }
 
      res.status(200).json({ ok: true });
 
    } else if (action === "delete") {
      const invId = req.query.invId;
      const url = `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}?filterByFormula=${encodeURIComponent("{InvID}='" + invId + "'")}`;
      const r = await fetch(url, { headers });
      const d = await r.json();
      if (d.records && d.records.length) {
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}/${d.records[0].id}`, { method: "DELETE", headers });
      }
      res.status(200).json({ ok: true });
    }
 
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

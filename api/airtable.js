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
          // Skip blank records
          if(!f.Supplier && !f.Date && !f.InvID) return null;
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

    } else if (action === "cleanup") {
      // Delete all blank records
      let blankIds = [];
      let offset2 = null;
      do {
        const url2 = `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}?pageSize=100${offset2 ? "&offset=" + offset2 : ""}`;
        const r2 = await fetch(url2, { headers });
        const d2 = await r2.json();
        (d2.records || []).forEach(r => {
          const f = r.fields;
          if(!f.Supplier && !f.Date && !f.InvID) blankIds.push(r.id);
        });
        offset2 = d2.offset || null;
      } while (offset2);
      for (let i = 0; i < blankIds.length; i += 10) {
        const batch = blankIds.slice(i, i+10);
        const params = batch.map(id => `records[]=${id}`).join("&");
        await fetch(`https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}?${params}`, { method: "DELETE", headers });
      }
      res.status(200).json({ ok: true, deleted: blankIds.length });

    } else if (action === "write") {
      const { invoices } = req.body || {};
      // If empty invoices — delete everything in Airtable
      if (!invoices || !invoices.length) {
        let allIds = [];
        let off = null;
        do {
          const ru = "https://api.airtable.com/v0/" + AT_BASE + "/" + encodeURIComponent(AT_TABLE) + "?pageSize=100" + (off ? "&offset=" + off : "");
          const rr = await fetch(ru, { headers });
          const dd = await rr.json();
          (dd.records || []).forEach(r => allIds.push(r.id));
          off = dd.offset || null;
        } while (off);
        for (let i = 0; i < allIds.length; i += 10) {
          const batch = allIds.slice(i, i + 10);
          const params = batch.map(id => "records[]=" + id).join("&");
          await fetch("https://api.airtable.com/v0/" + AT_BASE + "/" + encodeURIComponent(AT_TABLE) + "?" + params, { method: "DELETE", headers });
        }
        res.status(200).json({ ok: true, deleted: allIds.length });
        return;
      }

      // Get existing records to find which InvIDs already exist
      let existingMap = {}; // InvID -> airtable record id
      let offset = null;
      do {
        const url = "https://api.airtable.com/v0/" + AT_BASE + "/" + encodeURIComponent(AT_TABLE) + "?pageSize=100" + (offset ? "&offset=" + offset : "");
        const r = await fetch(url, { headers });
        const d = await r.json();
        if (d.error) throw new Error("Read error: " + d.error.message);
        (d.records || []).forEach(rec => {
          if (rec.fields.InvID) existingMap[rec.fields.InvID] = rec.id;
        });
        offset = d.offset || null;
      } while (offset);

      // Split into new records (create) and existing records (update)
      const toCreate = [];
      const toUpdate = [];
      invoices.forEach(inv => {
        const fields = {
          InvID: String(inv.id || ""),
          Supplier: String(inv.supplier || ""),
          Date: String(inv.date || ""),
          InvoiceNum: String(inv.invoice_number || ""),
          WeekKey: String(inv.weekKey || ""),
          Jobsite: String(inv.jobsite || ""),
          Address: String(inv.address || ""),
          NA: String(inv.na || ""),
          CA: String(inv.ca || ""),
          ItemsJSON: JSON.stringify(inv.items || []),
          FileName: String(inv.fileName || ""),
          UploadedBy: String(inv.uploadedBy || "")
        };
        if (existingMap[inv.id]) {
          toUpdate.push({ id: existingMap[inv.id], fields });
        } else {
          toCreate.push({ fields });
        }
      });

      let written = 0;

      // Create new records in batches of 10
      for (let i = 0; i < toCreate.length; i += 10) {
        const batch = toCreate.slice(i, i + 10);
        const wr = await fetch("https://api.airtable.com/v0/" + AT_BASE + "/" + encodeURIComponent(AT_TABLE), {
          method: "POST", headers,
          body: JSON.stringify({ records: batch })
        });
        const wd = await wr.json();
        if (wd.error) throw new Error("Create error: " + wd.error.message);
        written += (wd.records || []).length;
      }

      // Update existing records in batches of 10
      for (let i = 0; i < toUpdate.length; i += 10) {
        const batch = toUpdate.slice(i, i + 10);
        const wr = await fetch("https://api.airtable.com/v0/" + AT_BASE + "/" + encodeURIComponent(AT_TABLE), {
          method: "PATCH", headers,
          body: JSON.stringify({ records: batch })
        });
        const wd = await wr.json();
        if (wd.error) throw new Error("Update error: " + wd.error.message);
        written += (wd.records || []).length;
      }

      res.status(200).json({ ok: true, written, created: toCreate.length, updated: toUpdate.length });

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

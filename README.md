# netpower-tracker

Two apps deployed together on Vercel:

| Path  | App |
|-------|-----|
| `/`   | **Material Tracker** — invoice upload, price tracking, jobsites, estimates (`public/index.html`) |
| `/pm` | **NetPower PM** — Procore-style project management (`public/pm/`, API in `api/pm.js`) |

## Material Tracker setup

`api/airtable.js` reads its Airtable token from the environment. In Vercel → Project → Settings →
Environment Variables, set `AIRTABLE_TOKEN` (optional: `AIRTABLE_BASE`, `AIRTABLE_TABLE`; they default
to the existing base and "Table 1"). Without it, the tracker's API returns an error.

## NetPower PM

Modules:

- **Drawings** — upload PDF drawing sets; sheets are split out and sheet numbers/titles auto-detected from the title block (review before saving); drawing log by discipline with list/thumbnail views; revisions (new uploads of an existing sheet # become the next revision); zoomable viewer with markups (pen, highlighter, line, arrow, rectangle, revision cloud, text) that are private until published; pins that link a spot on a sheet to an RFI or punch item (or create one there); "Drawing Locations" shown on linked RFIs/punch items
- **Portfolio** — all projects with status, PM, schedule, contract value
- **Company Directory** — companies and people
- **Project Home** — open-item counts, overdue flags, "My Open Items" (ball in court), recent activity, project info and team
- **RFIs** — draft/open/closed, assignees, due dates, cost/schedule impact, threaded responses with official answers, print/PDF, CSV export
- **Submittals** — spec section, type, sequential approval workflow, Revise & Resubmit → revisions (#1.0, #1.1…), lead time / order-by date, CSV export
- **Daily Log** — one log per day: weather, manpower (copy from previous day), work performed, equipment, deliveries, visitors/inspections, safety, delays, notes; approve/lock; CSV export
- **Punch List** — assignee/manager workflow (Open → Ready for Review → Closed / Work Not Accepted), priority, photos, comments, CSV export
- **Project Directory** — project team with roles
- Change history on every item

There are no logins yet: each user picks their name (stored in their browser).

### Airtable setup

1. In Airtable, create a table (default name `PM Records`) with these fields:
   - `RecID` — Single line text
   - `Type` — Single line text
   - `ProjectID` — Single line text
   - `Data` — Long text
2. Create a personal access token with scopes `data.records:read` and `data.records:write`, limited to that base.
3. In Vercel → Project → Settings → Environment Variables, add:
   - `PM_AIRTABLE_TOKEN` — the token
   - `PM_AIRTABLE_BASE` — the base ID (starts with `app`)
   - `PM_AIRTABLE_TABLE` — optional, defaults to `PM Records`
4. Redeploy.

### Drawing file storage (Vercel Blob)

Drawing PDFs are too large for Airtable, so they are stored in Vercel Blob:

1. Vercel → your project → **Storage** → create/connect a **Blob** store. Vercel adds the credentials automatically:
   newer stores add `BLOB_STORE_ID` + `BLOB_WEBHOOK_PUBLIC_KEY` (OIDC, presigned uploads); older ones add `BLOB_READ_WRITE_TOKEN`.
   `api/blob.js` supports both.
2. Redeploy.

Files are uploaded straight from the browser (up to 500 MB per PDF) using short-lived tokens from `api/blob.js`.
Blob URLs are public but unguessable (random suffix). Check Vercel's Blob pricing/limits for your plan.

If these variables are missing, `/pm` runs in **Local demo mode** (badge in the top bar):
data is saved only in that browser and is not shared.

In local demo mode, drawing PDFs are kept in the browser's IndexedDB.

Photos are compressed in the browser to stay under Airtable's long-text size limit.

### Third-party code

`public/pm/vendor/` contains pdf.js 3.11.174 (`pdfjs-dist`) and a browser bundle of the
`@vercel/blob@2.8.0` client, both Apache-2.0 (licenses alongside). The bundle was built with:

```
echo "export { upload, uploadPresigned } from '@vercel/blob/client';" > entry.js
npx esbuild entry.js --bundle --minify --platform=browser --format=iife \
  --global-name=VercelBlob '--define:process.env={}' --outfile=vercel-blob-client-2.8.0.js
```

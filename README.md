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

- **Drawings** — upload PDF drawing sets; sheets are split out and sheet numbers/titles auto-detected from the title block (review before saving); drawing log by discipline with list/thumbnail views; revisions (new uploads of an existing sheet # become the next revision); viewer with mouse-wheel zoom and drag-to-pan at any zoom; measure distances and areas (sheet scale from a standard scale or calibrated); lasso to select many markups; markups for an RFI kept on the RFI (with "Copy to main drawing"); markups (pen, highlighter, line, arrow, box, revision cloud, formatted text boxes with font/size/bold/italic/underline/background/border) that can be moved, resized and edited, stay on until right-click/Esc, and are private until published; pins that link a spot on a sheet to an RFI or punch item (or create one there); "Drawing Locations" shown on linked RFIs/punch items
- **Portfolio** — all projects with status, PM, schedule (counts and contract value are shown to company admins only)
- **Job Tracker** (Portfolio → Job Tracker tab) — one company-wide list of job steps (company admins edit it) shown for every job: click a box to mark a step not started / in progress / done / blocked / N/A with a date and note; click a job for its own step list; progress also shows on project home. Updating steps needs the project's Admin tool at Standard or higher
- **Company Directory** — companies and people
- **Project Home** — open-item counts, overdue flags, "My Open Items" (ball in court), recent activity, project info and team
- **RFIs** — Procore-style create page (rich-text question, attachments, assignees, distribution list, responsible contractor, location, private RFIs), draft/open/closed, assignees, due dates, cost/schedule impact, threaded responses with official answers, print/PDF, CSV export
- **Submittals** — packages grouped by trade (Items / Packages tabs, trade filter); Procore-style create page (specification, number.revision, package, cost code, location, linked drawings, distribution, attachments, per-step due dates), spec section, type, sequential approval workflow, Revise & Resubmit → revisions (#1.0, #1.1…), lead time / order-by date, CSV export
- **Daily Log** — one log per day: manpower (copy from previous day), work performed, deliveries, safety, delays, notes; approve/lock; CSV export
- **Change Orders** (per project) — Draft → Pending → Approved / Rejected / Void; amount (credits allowed), schedule days, dates, owner/GC reference, related RFIs, files; approved / pending totals and (for company admins) revised contract; CSV. Own "Change Orders" permission
- **Equipment** (Submittals → Equipment) — the MEP equipment we need submittals for: start from the company's standard template (company admins edit it; paste from Excel/Word), or "✦ Read equipment schedules": pick the M/P schedule sheets and Claude lists the equipment (tag, make/model, electrical data) for review before adding; one click creates a draft submittal per item. Uses the AI assistant's access setting and monthly limit
- **Punch List** — assignee/manager workflow (Open → Ready for Review → Closed / Work Not Accepted), priority, photos, comments, CSV export
- **Specifications** — spec sections per project (used by submittals)
- **Photos** — upload jobsite photos from a phone camera or computer (resized in the browser), albums, captions; photos appear on that day's daily log
- **Manpower** (top bar) — weekly deployment board: drag people (with photo and trade) onto projects/days, drag between projects to shift them, double-booking warnings, copy last week; crew shows on project home and the daily log
- **Manpower Chart** (Manpower → Manpower Chart) — jobs × this week's and next week's days, 2 later weeks and 4 months, like the office spreadsheet: day boxes count who is deployed (or a typed number), click a day to see/add/remove the guys; later weeks and months are typed numbers; totals and missing/extra against company headcount (company admins set it)
- **Certifications** (Manpower → Certifications) — OSHA etc. per person with card upload and 30-day expiry alerts
- **Daily log reminders** — per project: work days or weekly, due time, foremen to remind, PMs to notify after a delay; shown in the 🔔 notifications
- **Voice to text** — 🎤 on RFI subject, question and responses (browser speech recognition: Chrome, Edge, Safari)
- **Drawing review** — new uploads wait in "Pending review" (only drawing admins see them): fix sheet info, compare each revision side-by-side or as a red/green overlay, then publish or reject
- **RFI / Submittal export** — Export ▾: PDF with a Procore-style cover sheet (logo, company letterhead, project, all fields, question/responses or approval workflow), followed by the attached PDFs and photos merged in (built in the browser with pdf-lib); Email with the PDF attached (computer: downloads an Outlook email draft `.eml`; phone: share sheet); plain email; view-only links for RFIs (`/pm/share.html`). Company admins set the letterhead under Admin → Company Letterhead
- **Inspections** (per project) — schedule inspections (type, description, date/time, status, who attends, notes, files), schedule re-inspections; "📅 Calendar" downloads an Outlook calendar file (.ics) and "✉ Invite" downloads an email draft with the .ics attached. (Direct Outlook calendar sync would need a Microsoft 365 permission — not set up)
- **Tools** (top bar) — tool inventory with photos, check out/in to a person and job, history, overdue reminders
- **AI assistant** — "✦ Ask AI" chat (Claude via the Anthropic API, `api/assistant.js`): answers questions and creates RFIs / punch items / daily log notes with the user's permissions; company admins only by default, with a monthly $ limit (default $25) set in the panel's Settings. 📎 attaches photos and PDFs (sent to Anthropic's Files API, kept 7 days; 3 MB per file); after it creates an RFI, one click attaches the chat's files to the RFI. Uses the `ANTHROPIC_API_KEY` env var
- **Claude connector** — user menu → Connect Claude gives each user a private link to add as a custom connector in claude.ai, so Claude can list projects/people, create and answer RFIs, create punch items and add daily log notes with that user's permissions (`api/mcp.js`, MCP Streamable HTTP)
- **Project Directory** — project team with roles
- **Project Management menu** — dropdown in the top bar listing the project's tools, with quick-create (⊕) links
- Change history on every item

### Logins and permissions

When the database is configured, everyone signs in with email + password (checked on the server).

- **First visit:** the first person to open `/pm` creates the **company admin** account. Do this right after deploying.
- **Users** (company admins only, user menu → Users): add people, set passwords, make company admins, deactivate.
- **Permission Templates** (company admins): None / Read Only / Standard / Admin per tool. Defaults: Project Admin,
  Project Manager, Foreman, Field Crew.
- **Project → Permissions** (company admins): add users to a project with a template, or customize per person.
- Users only see projects they were added to, and only the tools their permission allows. Private RFIs/submittals are
  visible only to tool admins and the people on them. Every save, delete and file upload is checked on the server.
- Sign-ins last 30 days. Optional env var `PM_SESSION_SECRET` (any long random string) signs the login cookies;
  without it a secret is derived from `PM_AIRTABLE_TOKEN` (so changing that token signs everyone out).

The Material Tracker (`/`) still has no login.

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

Files are uploaded straight from the browser (up to 500 MB per PDF; 100 MB per RFI/submittal/punch/daily log/spec
attachment) using short-lived tokens from `api/blob.js`, which first checks the user's project permissions.
Private stores are read through short-lived signed links. Check Vercel's Blob pricing/limits for your plan.

If these variables are missing, `/pm` runs in **Local demo mode** (badge in the top bar):
data is saved only in that browser and is not shared, and there are no logins.

In local demo mode, drawing PDFs are kept in the browser's IndexedDB.

Photos are compressed in the browser to stay under Airtable's long-text size limit.

### Third-party code

`public/pm/vendor/` contains pdf.js 3.11.174 (`pdfjs-dist`) and a browser bundle of the
`@vercel/blob@2.8.0` client, both Apache-2.0, and pdf-lib 1.17.1 (`dist/pdf-lib.min.js` from npm), MIT
(licenses alongside). The bundle was built with:

```
echo "export { upload, uploadPresigned } from '@vercel/blob/client';" > entry.js
npx esbuild entry.js --bundle --minify --platform=browser --format=iife \
  --global-name=VercelBlob '--define:process.env={}' --outfile=vercel-blob-client-2.8.0.js
```

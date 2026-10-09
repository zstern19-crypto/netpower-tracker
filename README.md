# netpower-tracker

Two apps deployed together on Vercel:

| Path  | App |
|-------|-----|
| `/`   | **Material Tracker** — invoice upload, price tracking, jobsites, estimates (`public/index.html`) |
| `/pm` | **NetPower PM** — Procore-style project management (`public/pm/`, API in `api/pm.js`) |

## NetPower PM

Modules:

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

If these variables are missing, `/pm` runs in **Local demo mode** (badge in the top bar):
data is saved only in that browser and is not shared.

Photos are compressed in the browser to stay under Airtable's long-text size limit.

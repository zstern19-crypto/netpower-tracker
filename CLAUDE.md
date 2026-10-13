# Notes for Claude

## Working with the owner (Zevy)

- **Ask before doing.** When a task could be done either by Claude or by Zevy (merging a PR,
  pushing, opening a PR, changing settings), say that Claude can do it and ask for permission first.
- Give step-by-step instructions one step at a time, with direct links, in plain language.
- Never ask for tokens or secrets to be pasted into chat.

## Git commits

- Commit as the repo owner so Vercel deploys the commits automatically
  (commits authored by others were not reliably deployed on this Vercel project):
  ```
  git config user.name "zstern19-crypto"
  git config user.email "zstern19@gmail.com"
  ```
  Keep the `Co-Authored-By: Claude …` trailer in commit messages.

## Deployment

- Vercel project `zevy-s-projects/netpower-tracker`, deployed from GitHub; `main` → production.
- `public/` is the published site root (see `vercel.json`); serverless functions are in `api/`.
- `package.json` has `"type": "module"` — required: without it Vercel compiles the functions to
  CommonJS and `api/blob.js` crashes with `FUNCTION_INVOCATION_FAILED` (wrong `@vercel/blob` file traced).
- Before pushing server changes, check the build locally: `npx vercel build` (with a local
  `.vercel/project.json`) and run the built functions from `.vercel/output/functions/api/`.

## Configuration (Vercel environment variables)

- `AIRTABLE_TOKEN` — Material Tracker (`api/airtable.js`), base `appDvscikJtSDsoku`, table "Table 1".
- `ANTHROPIC_API_KEY` — Material Tracker invoice reading (`api/claude.js`). Owner-only: requires a NetPower PM sign-in
  (same browser) as a company admin whose email is in `CLAUDE_ALLOWED_EMAILS` (default zevy@netpowerelectric.com).
- `PM_AIRTABLE_TOKEN`, `PM_AIRTABLE_BASE` — NetPower PM (`api/pm.js`), table "PM Records"
  (fields RecID, Type, ProjectID: single line text; Data: long text).
- Vercel Blob store connected via OIDC (`BLOB_STORE_ID`, `BLOB_WEBHOOK_PUBLIC_KEY`); `api/blob.js`
  uses presigned uploads for that, or `BLOB_READ_WRITE_TOKEN` if present.
- `PM_SESSION_SECRET` — optional; signs PM login cookies (falls back to a value derived from `PM_AIRTABLE_TOKEN`).
- PM logins: users are `user` records in the same Airtable table (scrypt password hashes); the first visitor
  creates the company admin. Permission logic lives in `lib/auth.js` and is enforced in `api/pm.js` / `api/blob.js`.
- Notifications / reminder rules (daily logs, certifications) live in `lib/notify.js` so a scheduled job can reuse them
  for email / WhatsApp (not built yet; the user's email is Outlook / Microsoft 365).
- `api/mcp.js` is the Claude connector (MCP). Keys are per user (`/api/mcp?key=<userId>.<secret>`, only a hash stored).
- Airtable free plan is ~1,000 API calls/month; the owner chose to keep Airtable for now ("decide later").
- `api/assistant.js` — in-app AI assistant (Anthropic SDK, `claude-opus-5-5`, effort low, `fallbacks: "default"`).
  Reuses `TOOLS`/`callTool` from `api/mcp.js`. Settings record `aiset_company` (type `aisetting`), monthly spend
  `aiuse_YYYYMM` (type `aiusage`). Keep the system prompt and tool list frozen (prompt cache + preserved thinking);
  per-request context goes in the user message. Owner chose "admins only first".
- Drawing uploads are held as `drawset` records with `status: "pending"` + `pendingSheets` until a drawings admin
  publishes them (`publishSet` in drawings.js); the server hides pending sets from non-admins.
- Tools (`tool` records) are company-wide; non-admins may only change checkout/condition and append history.

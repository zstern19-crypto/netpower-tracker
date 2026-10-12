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
- `PM_AIRTABLE_TOKEN`, `PM_AIRTABLE_BASE` — NetPower PM (`api/pm.js`), table "PM Records"
  (fields RecID, Type, ProjectID: single line text; Data: long text).
- Vercel Blob store connected via OIDC (`BLOB_STORE_ID`, `BLOB_WEBHOOK_PUBLIC_KEY`); `api/blob.js`
  uses presigned uploads for that, or `BLOB_READ_WRITE_TOKEN` if present.
- `PM_SESSION_SECRET` — optional; signs PM login cookies (falls back to a value derived from `PM_AIRTABLE_TOKEN`).
- PM logins: users are `user` records in the same Airtable table (scrypt password hashes); the first visitor
  creates the company admin. Permission logic lives in `lib/auth.js` and is enforced in `api/pm.js` / `api/blob.js`.

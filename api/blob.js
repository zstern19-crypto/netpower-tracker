// NetPower PM — file storage (Vercel Blob) for drawing PDFs and item attachments.
// Every request requires a signed-in user with permission on the file's project and tool.
//
// Files live at:
//   drawings/<projectId>/<file>                 (Drawings tool)
//   attachments/<projectId>/<tool>/<file>       (RFIs, Submittals, … attachments)
//
// Supports both ways a Blob store can be connected to the project:
//  • "presigned": BLOB_STORE_ID + BLOB_WEBHOOK_PUBLIC_KEY, authenticated with the
//    Vercel OIDC token (newer stores)
//  • "token": BLOB_READ_WRITE_TOKEN (older stores)
//
// GET    /api/blob            → { ok, mode } so the browser knows which upload method to use.
// GET    /api/blob?sign=<url> → { ok, url } a short-lived signed link to read a file
//                               (needed for private stores; public URLs are returned as-is).
// POST   /api/blob            → handled by @vercel/blob's handleUploadPresigned / handleUpload.
// DELETE /api/blob?url=<url>  → deletes a file.

import { handleUpload, handleUploadPresigned } from "@vercel/blob/client";
import { issueSignedToken, presignUrl, del } from "@vercel/blob";
import * as db from "../lib/db.js";
import * as auth from "../lib/auth.js";
import { sharedRfi } from "./pm.js";

const SIGNED_URL_TTL = 60 * 60 * 1000; // 1 hour
const ATTACHMENT_TOOLS = ["rfis", "submittals", "punch", "dailylog", "specs", "photos", "inspections", "changeorders", "tasks"];
const CERT_RE = /^certs\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9._-]{1,200}$/;
const DRAWING_RE = /^drawings\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9._-]{1,200}$/;
const ATTACH_RE = /^attachments\/([A-Za-z0-9_-]{1,64})\/([a-z]+)\/[A-Za-z0-9._-]{1,200}$/;

// What a path is and who may touch it
function describePath(pathname) {
  let m = DRAWING_RE.exec(pathname);
  if (m) return { projectId: m[1], tool: "drawings", maxBytes: 500 * 1024 * 1024, types: ["application/pdf"], deleteLevel: "admin" };
  m = CERT_RE.exec(pathname);
  if (m) return { certUserId: m[1], maxBytes: 25 * 1024 * 1024, types: undefined, deleteLevel: "standard" };
  m = ATTACH_RE.exec(pathname);
  if (m && ATTACHMENT_TOOLS.includes(m[2])) return { projectId: m[1], tool: m[2], maxBytes: 100 * 1024 * 1024, types: undefined, deleteLevel: "standard" };
  throw auth.httpError(400, "Invalid file path");
}

function parseBlobUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch (e) { throw auth.httpError(400, "Invalid file URL"); }
  if (u.protocol !== "https:" || !/\.blob\.vercel-storage\.com$/.test(u.hostname)) throw auth.httpError(400, "Not a Vercel Blob URL");
  const pathname = decodeURIComponent(u.pathname.replace(/^\//, ""));
  return { url: u.origin + u.pathname, pathname, isPrivate: u.hostname.includes(".private."), ...describePath(pathname) };
}

// Certification files belong to a person (company admins and that person); everything else to a project tool
function allowed(ctx, f, level) {
  if (f.certUserId) return ctx.isAdmin || ctx.user.id === f.certUserId;
  return ctx.can(f.projectId, f.tool, level);
}

function credentials(req) {
  // Vercel adds this header to function requests; the env var is a fallback
  const oidcToken = req.headers["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN || undefined;
  return oidcToken ? { oidcToken } : {};
}

function mode() {
  if (process.env.BLOB_STORE_ID && process.env.BLOB_WEBHOOK_PUBLIC_KEY) return "presigned";
  if (process.env.BLOB_READ_WRITE_TOKEN) return "token";
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const m = mode();
  if (!m) {
    res.status(503).json({ ok: false, code: "NOT_CONFIGURED", error: "No Vercel Blob store is connected to this project" });
    return;
  }

  try {
    if (!db.configured()) throw auth.httpError(503, "Database is not configured", "NOT_CONFIGURED");

    // View-only RFI links: sign only files attached to that RFI
    if (req.method === "GET" && req.query && req.query.shared) {
      const rfi = await sharedRfi(req.query.shared);
      const f = parseBlobUrl(req.query.url);
      auth.ensure(rfi && (rfi.data.attachments || []).some(a => a.url === f.url), "Not available");
      if (!f.isPrivate) return res.status(200).json({ ok: true, url: f.url });
      const token = await issueSignedToken({ pathname: f.pathname, operations: ["get"], validUntil: Date.now() + SIGNED_URL_TTL, ...credentials(req) });
      const { presignedUrl } = await presignUrl(token, { operation: "get", pathname: f.pathname, access: "private" });
      return res.status(200).json({ ok: true, url: presignedUrl });
    }

    const ctx = await auth.requireContext(req);

    if (req.method === "GET" && req.query && req.query.sign) {
      const f = parseBlobUrl(req.query.sign);
      auth.ensure(allowed(ctx, f, "read"));
      if (!f.isPrivate) return res.status(200).json({ ok: true, url: f.url });
      const token = await issueSignedToken({ pathname: f.pathname, operations: ["get"], validUntil: Date.now() + SIGNED_URL_TTL, ...credentials(req) });
      const { presignedUrl } = await presignUrl(token, { operation: "get", pathname: f.pathname, access: "private" });
      return res.status(200).json({ ok: true, url: presignedUrl, expiresAt: Date.now() + SIGNED_URL_TTL });
    }

    if (req.method === "GET") return res.status(200).json({ ok: true, mode: m });

    if (req.method === "DELETE") {
      const f = parseBlobUrl(req.query && req.query.url);
      auth.ensure(allowed(ctx, f, f.deleteLevel));
      await del(f.url, credentials(req));
      return res.status(200).json({ ok: true });
    }

    if (req.method !== "POST") throw auth.httpError(405, "Method not allowed");

    const authorize = pathname => {
      const f = describePath(pathname);
      auth.ensure(allowed(ctx, f, "standard"), "You don't have permission to upload files here");
      return f;
    };

    if (m === "presigned") {
      const result = await handleUploadPresigned({
        body: req.body,
        request: req,
        getSignedToken: async pathname => {
          const f = authorize(pathname);
          // The browser makes each pathname unique, so no random suffix is needed
          // and the delegation can be scoped to exactly this file.
          const limits = { maximumSizeInBytes: f.maxBytes, ...(f.types ? { allowedContentTypes: f.types } : {}) };
          const token = await issueSignedToken({ pathname, operations: ["put"], validUntil: Date.now() + 30 * 60 * 1000, ...limits, ...credentials(req) });
          return { token, urlOptions: { ...limits, addRandomSuffix: false } };
        }
      });
      return res.status(200).json(result);
    }

    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        const f = authorize(pathname);
        return { maximumSizeInBytes: f.maxBytes, ...(f.types ? { allowedContentTypes: f.types } : {}), addRandomSuffix: true };
      }
    });
    return res.status(200).json(result);
  } catch (err) {
    auth.sendError(res, { status: err.status || 400, code: err.code, message: err.message });
  }
}

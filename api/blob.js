// NetPower PM — authorizes direct browser uploads of drawing PDFs to Vercel Blob
// (bypassing the function body size limit).
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
// DELETE /api/blob?url=<url>  → deletes a drawing file.

import { handleUpload, handleUploadPresigned } from "@vercel/blob/client";
import { issueSignedToken, presignUrl, del } from "@vercel/blob";

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB per file
const PATH_RE = /^drawings\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,200}$/;
const TYPES = ["application/pdf"];

const SIGNED_URL_TTL = 60 * 60 * 1000; // 1 hour

// Only files in this store's drawings/ folder may be signed or deleted
function parseBlobUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch (e) { throw new Error("Invalid file URL"); }
  if (u.protocol !== "https:" || !/\.blob\.vercel-storage\.com$/.test(u.hostname)) throw new Error("Not a Vercel Blob URL");
  const pathname = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!PATH_RE.test(pathname)) throw new Error("Invalid file path");
  return { url: u.origin + u.pathname, pathname, isPrivate: u.hostname.includes(".private.") };
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
  if (req.method === "GET" && req.query && req.query.sign) {
    try {
      const f = parseBlobUrl(req.query.sign);
      if (!f.isPrivate) { res.status(200).json({ ok: true, url: f.url }); return; }
      const token = await issueSignedToken({ pathname: f.pathname, operations: ["get"], validUntil: Date.now() + SIGNED_URL_TTL, ...credentials(req) });
      const { presignedUrl } = await presignUrl(token, { operation: "get", pathname: f.pathname, access: "private" });
      res.status(200).json({ ok: true, url: presignedUrl, expiresAt: Date.now() + SIGNED_URL_TTL });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
    return;
  }
  if (req.method === "GET") {
    res.status(200).json({ ok: true, mode: m });
    return;
  }
  if (req.method === "DELETE") {
    try {
      const f = parseBlobUrl(req.query && req.query.url);
      await del(f.url, credentials(req));
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    if (m === "presigned") {
      const result = await handleUploadPresigned({
        body: req.body,
        request: req,
        getSignedToken: async pathname => {
          if (!PATH_RE.test(pathname)) throw new Error("Invalid upload path");
          // The browser makes each pathname unique, so no random suffix is needed
          // and the delegation can be scoped to exactly this file.
          const token = await issueSignedToken({
            pathname,
            operations: ["put"],
            allowedContentTypes: TYPES,
            maximumSizeInBytes: MAX_BYTES,
            validUntil: Date.now() + 30 * 60 * 1000,
            ...credentials(req)
          });
          return { token, urlOptions: { allowedContentTypes: TYPES, maximumSizeInBytes: MAX_BYTES, addRandomSuffix: false } };
        }
      });
      res.status(200).json(result);
      return;
    }

    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        if (!PATH_RE.test(pathname)) throw new Error("Invalid upload path");
        return { allowedContentTypes: TYPES, maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true };
      }
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}

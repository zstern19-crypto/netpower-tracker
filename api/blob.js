// NetPower PM — authorizes direct browser uploads of drawing PDFs to Vercel Blob
// (bypassing the function body size limit).
//
// Supports both ways a Blob store can be connected to the project:
//  • "presigned": BLOB_STORE_ID + BLOB_WEBHOOK_PUBLIC_KEY, authenticated with the
//    Vercel OIDC token (newer stores)
//  • "token": BLOB_READ_WRITE_TOKEN (older stores)
//
// GET  /api/blob → { ok, mode } so the browser knows which upload method to use.
// POST /api/blob → handled by @vercel/blob's handleUploadPresigned / handleUpload.

import { handleUpload, handleUploadPresigned } from "@vercel/blob/client";
import { issueSignedToken } from "@vercel/blob";

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB per file
const PATH_RE = /^drawings\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,200}$/;
const TYPES = ["application/pdf"];

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
  if (req.method === "GET") {
    res.status(200).json({ ok: true, mode: m });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    if (m === "presigned") {
      // Vercel adds this header to function requests; the env var is a fallback
      const oidcToken = req.headers["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN || undefined;
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
            ...(oidcToken ? { oidcToken } : {})
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

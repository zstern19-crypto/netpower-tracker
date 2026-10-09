// NetPower PM — issues short-lived client-upload tokens for Vercel Blob so the
// browser can upload large drawing PDFs directly (bypassing the function body limit).
//
// Requires a Blob store connected to the Vercel project, which sets BLOB_READ_WRITE_TOKEN.

import { handleUpload } from "@vercel/blob/client";

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB per file
const PATH_RE = /^drawings\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,200}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ ok: false, code: "NOT_CONFIGURED", error: "BLOB_READ_WRITE_TOKEN is not set — connect a Vercel Blob store to this project" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        if (!PATH_RE.test(pathname)) throw new Error("Invalid upload path");
        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true
        };
      }
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}

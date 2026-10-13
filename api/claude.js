// Material Tracker invoice reading → Anthropic API, using the server's ANTHROPIC_API_KEY.
// Locked down: only the owner may use it. They must be signed in to NetPower PM (/pm) in the same
// browser as a company admin whose email is in CLAUDE_ALLOWED_EMAILS (comma-separated; defaults to the owner).
import * as db from "../lib/db.js";
import * as auth from "../lib/auth.js";

const ALLOWED = (process.env.CLAUDE_ALLOWED_EMAILS || "zevy@netpowerelectric.com")
  .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
const MAX_TOKENS = 8192;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: { message: "Method not allowed" } }); return; }
  if (!db.configured()) { res.status(503).json({ error: { message: "Sign-in isn't set up on this site (NetPower PM database not configured)" } }); return; }

  const ctx = await auth.getContext(req).catch(() => null);
  if (!ctx) { res.status(401).json({ error: { message: "Please sign in to NetPower PM (/pm) in this browser first — invoice reading is limited to the owner." } }); return; }
  if (!ctx.isAdmin || !ALLOWED.includes(String(ctx.user.data.email || "").toLowerCase())) {
    res.status(403).json({ error: { message: "Invoice reading is limited to the account owner." } });
    return;
  }

  try {
    const { model, max_tokens, messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) { res.status(400).json({ error: { message: "No messages" } }); return; }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model, max_tokens: Math.min(Number(max_tokens) || 1024, MAX_TOKENS), messages })
    });
    const data = await response.json();
    res.status(response.ok ? 200 : response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
}

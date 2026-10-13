// NetPower PM — in-app AI assistant (Claude). Answers questions about project data and can create RFIs,
// punch items and daily log notes, using the same tools and permission checks as the Claude connector (api/mcp.js).
//
//   GET  /api/assistant                    → { allowed, access, capUsd, monthCostUsd }
//   POST /api/assistant  { messages, text, projectId? }  → { messages, reply, actions, usage }
//   POST /api/assistant?action=settings  { access: "admins"|"everyone", capUsd }   (company admins)
//
// The browser keeps the conversation (including Claude's thinking blocks, unchanged) and sends it back each turn;
// the system prompt and tools never change, so history stays valid and the prompt cache stays warm.
// Spending: each request's token usage is priced and added to a monthly total ("aiusage" record); requests stop
// once the month's cap is reached. Settings live in the "aisetting" record.

import Anthropic from "@anthropic-ai/sdk";
import * as db from "../lib/db.js";
import * as auth from "../lib/auth.js";
import { TOOLS, callTool } from "./mcp.js";

const MODEL = "claude-opus-5-5";
const MAX_STEPS = 8;              // model calls per question (each tool round is one)
const DEFAULT_CAP_USD = 25;       // per calendar month, until an admin changes it
const SETTINGS_ID = "aiset_company";
// $ per million tokens (first-party API list prices; fallback models are priced at the higher row to stay conservative)
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  default: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
};

const SYSTEM = `You are the NetPower PM assistant for NetPower Electric, an electrical contractor. You help project managers, foremen and field crews with their construction projects in NetPower PM (a Procore-style app): RFIs, submittals, punch lists, daily logs, people and projects.

How to work:
- Use the tools to look things up instead of guessing. If the project is unclear, call list_projects (or ask).
- You may create RFIs, respond to RFIs, create punch items and add daily log notes when the user asks you to. If key details are missing (which project, who should answer an RFI), ask one short question first. Never invent people — use list_people for names.
- After creating or changing something, say exactly what you did and include the link the tool returned.
- Photos can't be attached from this chat; when an RFI needs photos, give the user its "Add photos" link.
- Keep answers short and practical, in plain language for people on a jobsite. Use short lists when listing items.
- Each user message ends with a bracketed context line (who is asking, today's date, the project on screen). Use it, but don't repeat it back.
- You only see what the signed-in user is allowed to see; if a tool says permission is denied, explain that plainly.`;

const TOOL_DEFS = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

const month = () => new Date().toISOString().slice(0, 7);
const usageId = () => "aiuse_" + month().replace("-", "");
function costOf(model, u) {
  const p = PRICES[model] || PRICES.default;
  return ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output +
    (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
}
async function settings() {
  const s = await db.get(SETTINGS_ID);
  return { access: "admins", capUsd: DEFAULT_CAP_USD, ...(s ? s.data : {}) };
}
async function usage() {
  const u = await db.get(usageId());
  return u ? u.data : { month: month(), costUsd: 0, requests: 0, byUser: {} };
}
const allowed = (ctx, st) => ctx.isAdmin || st.access === "everyone";

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!db.configured()) throw auth.httpError(503, "Database is not configured", "NOT_CONFIGURED");
    const ctx = await auth.requireContext(req);
    const st = await settings();

    if (req.method === "GET") {
      const u = await usage();
      return res.status(200).json({ ok: true, allowed: allowed(ctx, st) && !!process.env.ANTHROPIC_API_KEY, configured: !!process.env.ANTHROPIC_API_KEY,
        access: st.access, capUsd: st.capUsd, monthCostUsd: Math.round(u.costUsd * 100) / 100, isAdmin: ctx.isAdmin });
    }
    if (req.method !== "POST") throw auth.httpError(405, "Method not allowed");
    const b = body(req);

    if (req.query && req.query.action === "settings") {
      auth.ensure(ctx.isAdmin, "Only company admins can change assistant settings");
      const capUsd = Math.max(0, Math.min(10000, Number(b.capUsd)));
      if (!Number.isFinite(capUsd)) throw auth.httpError(400, "Enter a monthly limit in dollars");
      const access = b.access === "everyone" ? "everyone" : "admins";
      await db.save([{ id: SETTINGS_ID, type: "aisetting", projectId: "", data: { access, capUsd, updatedBy: ctx.user.data.name, updatedAt: new Date().toISOString() } }], await db.getMany([SETTINGS_ID]));
      return res.status(200).json({ ok: true, access, capUsd });
    }

    auth.ensure(allowed(ctx, st), "The assistant is only available to company admins right now");
    if (!process.env.ANTHROPIC_API_KEY) throw auth.httpError(503, "The assistant isn't set up yet: ANTHROPIC_API_KEY is missing on the server.", "NOT_CONFIGURED");
    const text = String(b.text || "").trim().slice(0, 4000);
    if (!text) throw auth.httpError(400, "Type a question");
    const history = Array.isArray(b.messages) ? b.messages : [];
    if (JSON.stringify(history).length > 800000) throw auth.httpError(413, "This conversation is too long — start a new chat");
    if (history.some(m => !m || !["user", "assistant"].includes(m.role))) throw auth.httpError(400, "Bad conversation history");

    const used = await usage();
    if (used.costUsd >= st.capUsd) throw auth.httpError(402, `This month's assistant limit ($${st.capUsd}) has been reached. A company admin can raise it in the assistant settings.`, "CAP_REACHED");

    // Context goes in the user message (append-only), so the system prompt stays identical across requests
    let where = "";
    if (b.projectId && db.ID_RE.test(b.projectId) && ctx.isMember(b.projectId)) {
      const p = await db.get(b.projectId);
      if (p && p.type === "project") where = `; project on screen: "${p.data.name}"`;
    }
    const messages = [...history, { role: "user", content: `${text}\n\n[Context: asked by ${ctx.user.data.name}${ctx.isAdmin ? " (company admin)" : ""}; today is ${new Date().toISOString().slice(0, 10)}${where}]` }];

    const client = new Anthropic();
    let cost = 0, reply = "", stopped = "";
    const actions = [];
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",               // if Claude declines on safety grounds, the API retries on a fallback model
        output_config: { effort: "low" },   // chat: quick answers; tool use still works
        cache_control: { type: "ephemeral" },
        system: SYSTEM,
        tools: TOOL_DEFS,
        messages
      });
      cost += costOf(response.model, response.usage || {});
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "refusal") { reply = "Sorry — I can't help with that request."; stopped = "refusal"; break; }
      if (response.stop_reason === "pause_turn") continue;
      const calls = response.content.filter(x => x.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !calls.length) {
        reply = response.content.filter(x => x.type === "text").map(x => x.text).join("\n").trim();
        if (response.stop_reason === "max_tokens") reply += "\n\n(Answer cut short — ask me to continue.)";
        break;
      }
      const results = [];
      for (const call of calls) {
        try {
          const out = await callTool(ctx, req, call.name, call.input);
          results.push({ type: "tool_result", tool_use_id: call.id, content: out });
          if (/^(create_|respond_|add_)/.test(call.name)) actions.push({ tool: call.name, text: out.split("\n")[0] });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: e.userFacing ? e.message : "Error: " + e.message, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
      if (used.costUsd + cost >= st.capUsd) { reply = "I stopped because this month's assistant spending limit was reached."; stopped = "cap"; break; }
      if (step === MAX_STEPS - 1) { reply = "That took more steps than I'm allowed in one go — ask me to continue."; stopped = "steps"; }
    }

    // Record spend (read-modify-write; small races only make the total slightly low)
    const fresh = await usage();
    const by = { ...(fresh.byUser || {}) };
    by[ctx.user.id] = { name: ctx.user.data.name, costUsd: ((by[ctx.user.id] || {}).costUsd || 0) + cost, requests: ((by[ctx.user.id] || {}).requests || 0) + 1 };
    const next = { month: month(), costUsd: (fresh.costUsd || 0) + cost, requests: (fresh.requests || 0) + 1, byUser: by, updatedAt: new Date().toISOString() };
    await db.save([{ id: usageId(), type: "aiusage", projectId: "", data: next }], await db.getMany([usageId()]));

    return res.status(200).json({ ok: true, messages, reply, actions, stopped,
      usage: { costUsd: Math.round(cost * 10000) / 10000, monthCostUsd: Math.round(next.costUsd * 100) / 100, capUsd: st.capUsd } });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const msg = err.status === 429 ? "The AI service is busy — try again in a minute." : err.status === 401 ? "The AI service rejected the server's API key." : "The AI service had a problem (" + err.status + "). Try again.";
      return res.status(502).json({ ok: false, error: msg });
    }
    auth.sendError(res, err);
  }
}

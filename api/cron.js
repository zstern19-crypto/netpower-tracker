// NetPower PM — once-a-day job (Vercel Cron, see vercel.json): the "Morning summary" push for people who turned it on.
// Protected by CRON_SECRET when that's set in Vercel; either way it runs at most once per day.
import * as db from "../lib/db.js";
import * as auth from "../lib/auth.js";
import * as notify from "../lib/notify.js";
import * as push from "../lib/push.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!db.configured()) return res.status(200).json({ ok: true, skipped: "no database" });
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: "Not allowed" });
    const today = new Date().toISOString().slice(0, 10);
    const lock = await db.get("pushcron_daily");
    if (lock && lock.data.date === today) return res.status(200).json({ ok: true, skipped: "already ran today" });
    await db.save([{ id: "pushcron_daily", type: "pushcron", projectId: "", data: { date: today, at: new Date().toISOString() } }]);

    // Only people with a phone signed up and the morning summary switched on
    const subs = await db.find(db.eq("Type", "pushsub"));
    const userIds = [...new Set(subs.map(s => s.projectId))];
    let sent = 0;
    for (const id of userIds) {
      if (!(await push.prefs(id)).daily) continue;
      const u = await db.get(id);
      if (!u || u.type !== "user" || u.data.active === false) continue;
      const list = await notify.unreadFor(await auth.contextFor(u));
      if (!list.length) continue;
      sent += await push.sendToUsers([id], "daily", { title: `Good morning — ${list.length} thing${list.length === 1 ? "" : "s"} need${list.length === 1 ? "s" : ""} attention`,
        body: list.slice(0, 3).map(x => x.text).join(" · ") + (list.length > 3 ? ` · +${list.length - 3} more` : ""), url: "/pm/", tag: "daily" });
    }
    return res.status(200).json({ ok: true, people: userIds.length, sent });
  } catch (err) {
    console.error("cron", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// noop coordination plane — runs in the owner's own Cloudflare account (free plan). Not a shared service.
// One Durable Object (SQLite) holds: chat feed, owner→fleet inbox, the fleet's status/settings snapshot, media.
// The machines (which run Claude/Codex) only make outbound HTTPS calls here; nothing needs to reach them.
//
// Client API (same shape as the local hub server):
//   GET /api/feed?since=  · WS /api/stream?token=  · POST /api/messages {text, reply_to?}
//   GET /api/status  · GET|PUT /api/settings  · POST /api/media (multipart) · GET /media/<id>
// Fleet API (primary host):
//   POST /api/events (event)  · PUT /api/host/state {status, settings}  · GET /api/host/inbox?after=<seq>
//   POST /api/host/revoke-sessions (HUB_TOKEN only)
// Auth: HUB_TOKEN is the machine (fleet) credential. The owner logs in with an emailed one-time code:
//   POST /api/auth/start {email} → mail code · POST /api/auth/verify {email, code} → {session} · POST /api/auth/logout
// Web Push (owner session): GET /api/push/vapid · POST /api/push/subscribe {subscription, device_label}
//   · POST /api/push/unsubscribe {endpoint} · POST /api/push/test · POST /api/push/answer {ref, answer}
// Every other /api/* and /media/* needs Bearer <HUB_TOKEN|session> (or ?token= for WebSocket / <img>).
import { DurableObject } from "cloudflare:workers";
import { handleFiles, initFilesSchema } from "./files";
import { sendMail, type SmtpCfg } from "./smtp";
import { EmailMessage } from "cloudflare:email";

const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
async function cfMail(binding: SendEmail, from: string, to: string, subject: string, text: string) {
  const raw = [`From: noop <${from}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(text)].join("\r\n");
  await binding.send(new EmailMessage(from, to, raw));
}
import { sendPush, type PushSub, type Vapid } from "./push";

interface Env {
  HUB: DurableObjectNamespace<Hub>; HUB_TOKEN: string; ASSETS: Fetcher;
  HUB_OWNER_EMAIL?: string; // comma-separated allow-list
  HUB_SMTP?: string;        // JSON SmtpCfg
  EMAIL?: SendEmail;        // Cloudflare Email Routing binding (no SMTP needed)
  HUB_MAIL_FROM?: string;   // sender on a domain with Email Routing on, e.g. noop@example.com
  HUB_VAPID_PUBLIC?: string;  // b64url raw P-256 point
  HUB_VAPID_PRIVATE?: string; // JWK JSON
}

const PUSH_KINDS = ["decision", "menu", "proposals", "login", "notice"] as const;
const TITLES: Record<string, string> = { decision: "需要你拍板", menu: "可以选下一步", proposals: "新的提议", login: "登录提醒", notice: "noop" };
/** "23:00-08:00" in tz → is it quiet now? */
function inQuiet(range: string | undefined, tz: string | undefined, now = new Date()) {
  const m = range?.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  let hm: string;
  try { hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now); }
  catch { hm = now.toISOString().slice(11, 16); }
  const [h, mi] = hm.split(":").map(Number), t = h * 60 + mi;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a <= b ? t >= a && t < b : t >= a || t < b;
}
const plain = (s: string) => s.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>\[\]]/g, "").replace(/\(https?:[^)]*\)/g, "").replace(/\s+/g, " ").trim();

const json = (d: unknown, status = 200) => Response.json(d, { status });
const CHUNK = 1_000_000; // SQLite row limit is 2 MB
const MAX_MEDIA = 30_000_000;
const STALE_MS = 3 * 60_000;
const CODE_TTL = 10 * 60_000, CODE_TRIES = 5, RESEND_MS = 60_000, SENDS_PER_HOUR = 10, SEEN_EVERY = 3600_000;

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
function sameStr(a: string, b: string) { // constant-time for equal lengths
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function sixDigits() { // unbiased 000000–999999
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4_294_000_000);
  return String(a[0] % 1_000_000).padStart(6, "0");
}
const normEmail = (e: unknown) => typeof e === "string" ? e.trim().toLowerCase() : "";
const validEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) return env.ASSETS.fetch(req);
    if (!env.HUB_TOKEN) return json({ error: "HUB_TOKEN secret not set" }, 500);
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
  },
};

type Ev = { id: string; ts: string; from: string; kind: string; text: string; ref?: string; [k: string]: unknown };

export class Hub extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, json TEXT);
      CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS media (id TEXT, n INTEGER, type TEXT, data BLOB, PRIMARY KEY (id, n));
      CREATE TABLE IF NOT EXISTS auth_codes (email TEXT PRIMARY KEY, hash TEXT, expires INTEGER, attempts INTEGER);
      CREATE TABLE IF NOT EXISTS auth_sends (email TEXT, ts INTEGER, sent INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, email TEXT, created INTEGER, last_seen INTEGER, ua TEXT);
      CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, session TEXT, p256dh TEXT, auth TEXT, label TEXT, created INTEGER);`);
    initFilesSchema(this.sql);
  }

  get(k: string): any { const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0]; return r ? JSON.parse(r.v as string) : null; }
  set(k: string, v: unknown) { this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, JSON.stringify(v)); }

  append(e: Partial<Ev>): Ev {
    const ev = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e } as Ev;
    this.sql.exec("INSERT INTO events (ts, json) VALUES (?, ?)", ev.ts, JSON.stringify(ev));
    this.sql.exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) - 5000 FROM events)");
    const s = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) try { ws.send(s); } catch {}
    const n = this.notification(ev);
    if (n) this.ctx.waitUntil(this.pushAll(n.payload, n.urgency).catch((err) => console.error(`push: ${err}`)));
    return ev;
  }

  ownerMessage(text: string, ref?: string): Ev {
    const ev = this.append({ from: "owner", kind: "owner", text, ref });
    this.sql.exec("INSERT INTO inbox (json) VALUES (?)", JSON.stringify({ type: "message", event: ev }));
    if (!this.hostOnline()) this.append({ from: "hub", kind: "system", text: "收到。团队的电脑暂时都不在线，上线后会马上处理。", ref: ev.id });
    return ev;
  }

  // ---- web push
  vapid(): Vapid | null {
    const { HUB_VAPID_PUBLIC: pub, HUB_VAPID_PRIVATE: priv, HUB_OWNER_EMAIL: owner } = this.env;
    if (!pub || !priv) return null;
    try { return { publicKey: pub, privateJwk: JSON.parse(priv), subject: `mailto:${(owner ?? "").split(",")[0].trim() || "owner@example.com"}` }; } catch { return null; }
  }

  /** Which events become a phone notification, honoring settings.current.notify_prefs. */
  notification(ev: Ev): { payload: Record<string, unknown>; urgency: "normal" | "high" } | null {
    const kind = ev.kind;
    if (!(PUSH_KINDS as readonly string[]).includes(kind)) return null; // never system / owner
    if (kind === "notice" && /^hub(@|$)/.test(String(ev.from ?? ""))) return null; // hub's own housekeeping
    const prefs = (this.get("settings")?.current?.notify_prefs ?? {}) as { kinds?: Record<string, boolean>; quiet_hours?: string; tz?: string };
    if (prefs.kinds?.[kind] === false) return null;
    const urgent = kind === "decision" && ev.priority === "urgent";
    if (inQuiet(prefs.quiet_hours, prefs.tz) && kind !== "login" && !urgent) return null;
    const ref = typeof ev.ref === "string" ? ev.ref : undefined;
    const opts = Array.isArray(ev.options) ? (ev.options as unknown[]).map((o) => String(o).slice(0, 20)).slice(0, 3) : [];
    const decisions = (this.get("status")?.decisions ?? []) as { held?: boolean }[];
    const body = plain(String(ev.text ?? ""));
    return {
      urgency: kind === "decision" || kind === "login" ? "high" : "normal",
      payload: {
        title: TITLES[kind] ?? "noop", body: body.length > 140 ? `${body.slice(0, 139)}…` : body,
        ref, kind, options: kind === "decision" || kind === "menu" ? opts : [],
        url: ref ? `/?ref=${encodeURIComponent(ref)}` : "/", tag: ref ?? kind,
        badge: decisions.filter((d) => !d.held).length,
      },
    };
  }

  async pushAll(payload: unknown, urgency: "normal" | "high", only?: string) {
    const v = this.vapid();
    if (!v) return { sent: 0, removed: 0, error: "vapid not configured" };
    const rows = only ? this.sql.exec("SELECT * FROM push_subs WHERE session = ?", only).toArray() : this.sql.exec("SELECT * FROM push_subs").toArray();
    let sent = 0, removed = 0;
    await Promise.all(rows.map(async (r) => {
      const sub: PushSub = { endpoint: r.endpoint as string, keys: { p256dh: r.p256dh as string, auth: r.auth as string } };
      const tag = (payload as { tag?: string }).tag;
      const st = await sendPush(sub, payload, v, { ttl: 86400, urgency, topic: tag }).catch(() => 0);
      if (st === 404 || st === 410) { this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", sub.endpoint); removed++; }
      else if (st >= 200 && st < 300) sent++;
      else console.error(`push ${new URL(sub.endpoint).host}: HTTP ${st}`);
    }));
    return { sent, removed, total: rows.length };
  }

  async push(p: string, req: Request, who: "machine" | { session: string }): Promise<Response> {
    if (p === "/api/push/vapid") { const v = this.vapid(); return v ? json({ publicKey: v.publicKey }) : json({ error: "push not configured" }, 503); }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const b = (await req.json().catch(() => ({}))) as any;
    if (p === "/api/push/answer") {
      const ref = typeof b?.ref === "string" ? b.ref.trim() : "", answer = typeof b?.answer === "string" ? b.answer.trim() : "";
      if (!ref || !answer) return json({ error: "ref and answer required" }, 400);
      return json(this.ownerMessage(`${ref} ${answer}`, ref));
    }
    if (who === "machine") return json({ error: "owner session required" }, 403);
    if (p === "/api/push/subscribe") {
      const s = b?.subscription;
      if (typeof s?.endpoint !== "string" || !/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(s.endpoint) || typeof s?.keys?.p256dh !== "string" || typeof s?.keys?.auth !== "string")
        return json({ error: "invalid subscription" }, 400);
      this.sql.exec(`INSERT INTO push_subs (endpoint, session, p256dh, auth, label, created) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET session = excluded.session, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
        s.endpoint, who.session, s.keys.p256dh, s.keys.auth, String(b.device_label ?? "").slice(0, 80), Date.now());
      return json({ ok: true });
    }
    if (p === "/api/push/unsubscribe") {
      this.sql.exec("DELETE FROM push_subs WHERE endpoint = ? AND session = ?", String(b?.endpoint ?? ""), who.session);
      return json({ ok: true });
    }
    if (p === "/api/push/test") {
      const r = await this.pushAll({ title: "noop", body: "测试通知：手机推送已开通。", kind: "notice", url: "/", tag: "test", options: [], badge: 0 }, "normal", who.session);
      return json({ ok: true, ...r });
    }
    return json({ error: "not found" }, 404);
  }

  hostOnline() { const seen = this.get("host_seen"); return !!seen && Date.now() - seen < STALE_MS; }

  // ---- auth
  credential(req: Request, url: URL) {
    const h = req.headers.get("authorization") ?? "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : url.searchParams.get("token") ?? ""; // WebSocket / <img> can't send headers
  }
  /** "machine" for HUB_TOKEN, the session id for an owner session, null otherwise. */
  async who(req: Request, url: URL): Promise<"machine" | { session: string } | null> {
    const t = this.credential(req, url);
    if (!t) return null;
    if (sameStr(t, this.env.HUB_TOKEN)) return "machine";
    if (!/^[0-9a-f]{64}$/.test(t)) return null;
    const id = await sha256(t); // store only hashes of session ids
    const r = this.sql.exec("SELECT last_seen FROM sessions WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    if (Date.now() - (r.last_seen as number) > SEEN_EVERY) this.sql.exec("UPDATE sessions SET last_seen = ? WHERE id = ?", Date.now(), id);
    return { session: id };
  }

  async auth(p: string, req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
    const now = Date.now();
    if (p === "/api/auth/start") {
      const email = normEmail(body?.email);
      if (!validEmail(email)) return json({ error: "invalid email" }, 400);
      let smtp: SmtpCfg | null = null;
      try { smtp = this.env.HUB_SMTP ? JSON.parse(this.env.HUB_SMTP) : null; } catch {}
      // No email set up yet: the code is shown on the owner's own machine instead (`noop login`, needs the machine key).
      const cf = !smtp?.host && !!this.env.EMAIL && !!this.env.HUB_MAIL_FROM;
      const cli = !smtp?.host && !cf;
      this.sql.exec("DELETE FROM auth_sends WHERE ts < ?", now - 3600_000);
      // Per-email throttle applies to every address alike, so it reveals nothing about the allow-list.
      const recent = this.sql.exec("SELECT COUNT(*) AS n FROM auth_sends WHERE email = ? AND ts > ?", email, now - RESEND_MS).one().n as number;
      if (recent) return json({ error: "请稍等一分钟再重新获取验证码" }, 429);
      const sent = this.sql.exec("SELECT COUNT(*) AS n FROM auth_sends WHERE sent = 1").one().n as number;
      if (sent >= SENDS_PER_HOUR) return json({ error: "验证码发送太频繁，请一小时后再试" }, 429);
      const owners = (this.env.HUB_OWNER_EMAIL ?? "").split(",").map(normEmail).filter(Boolean);
      const isOwner = owners.includes(email) || (cli && !owners.length);
      this.sql.exec("INSERT INTO auth_sends (email, ts, sent) VALUES (?, ?, ?)", email, now, isOwner ? 1 : 0);
      if (!isOwner) return json(cli ? { ok: true, delivery: "cli" } : { ok: true });
      const code = sixDigits();
      this.sql.exec("INSERT OR REPLACE INTO auth_codes (email, hash, expires, attempts) VALUES (?, ?, ?, 0)", email, await sha256(`${email}:${code}`), now + CODE_TTL);
      if (cli) { this.set("cli_code", { email, code, expires: now + CODE_TTL }); return json({ ok: true, delivery: "cli" }); }
      if (!isOwner) return json({ ok: true });
      try {
        const subject = `noop 登录验证码：${code}`;
        const text = `你的 noop 登录验证码是：\n\n    ${code}\n\n10 分钟内有效。\n\n如果不是你本人操作，请忽略这封邮件。\n`;
        if (cf) await cfMail(this.env.EMAIL!, this.env.HUB_MAIL_FROM!, email, subject, text);
        else await sendMail(smtp!, email, subject, text);
      } catch (err) {
        console.error(`auth mail failed: ${err}`);
        this.sql.exec("DELETE FROM auth_codes WHERE email = ?", email);
        return json({ error: "验证码邮件发送失败，请稍后再试" }, 502);
      }
      return json({ ok: true });
    }
    if (p === "/api/auth/verify") {
      const email = normEmail(body?.email), code = typeof body?.code === "string" ? body.code.trim() : "";
      if (!validEmail(email) || !/^\d{6}$/.test(code)) return json({ error: "invalid request" }, 400);
      const r = this.sql.exec("SELECT hash, expires, attempts FROM auth_codes WHERE email = ?", email).toArray()[0];
      if (!r || (r.expires as number) < now) return json({ error: "验证码无效或已过期，请重新获取" }, 401);
      if ((r.attempts as number) >= CODE_TRIES) return json({ error: "尝试次数太多，请重新获取验证码" }, 401);
      this.sql.exec("UPDATE auth_codes SET attempts = attempts + 1 WHERE email = ?", email);
      if (!sameStr(await sha256(`${email}:${code}`), r.hash as string)) return json({ error: "验证码不对" }, 401);
      this.sql.exec("DELETE FROM auth_codes WHERE email = ?", email);
      this.sql.exec("DELETE FROM kv WHERE k = 'cli_code'");
      const session = hex(crypto.getRandomValues(new Uint8Array(32)));
      this.sql.exec("INSERT INTO sessions (id, email, created, last_seen, ua) VALUES (?, ?, ?, ?, ?)",
        await sha256(session), email, now, now, (req.headers.get("user-agent") ?? "").slice(0, 300));
      return json({ session });
    }
    if (p === "/api/auth/logout") {
      const w = await this.who(req, new URL(req.url));
      if (w && w !== "machine") {
        this.sql.exec("DELETE FROM sessions WHERE id = ?", w.session);
        this.sql.exec("DELETE FROM push_subs WHERE session = ?", w.session);
      }
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;

    if (p.startsWith("/api/auth/")) return this.auth(p, req);
    const who = await this.who(req, url);
    if (!who) return json({ error: "unauthorized" }, 401);
    if (p.startsWith("/api/push/")) return this.push(p, req, who);
    if (p.startsWith("/api/files/")) {
      const ownerOnly = p === "/api/files/history" || p === "/api/files/revert";
      if (ownerOnly ? who === "machine" : who !== "machine") return json({ error: "forbidden" }, 403);
      const actor = who === "machine" ? (req.headers.get("x-noop-host") ?? "machine") : "owner";
      const r = await handleFiles(this.sql, req, url, actor);
      if (r) return r;
    }
    if (p === "/api/host/login-code") { // `noop login` on the owner's machine, when email isn't configured
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const c = this.get("cli_code");
      return c && c.expires > Date.now() ? json(c) : json({ error: "no pending code" }, 404);
    }
    if (p === "/api/host/join" && m === "POST") { // a new machine, approved by the owner's login, gets the machine key
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { host } = (await req.json().catch(() => ({}))) as { host?: string };
      this.append({ from: "hub", kind: "notice", text: `新机器 ${String(host ?? "?").slice(0, 60)} 已加入团队。` });
      return json({ token: this.env.HUB_TOKEN });
    }
    if (p === "/api/host/revoke-sessions" && m === "POST") {
      await req.text().catch(() => ""); // drain body
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const n = this.sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n;
      this.sql.exec("DELETE FROM sessions");
      this.sql.exec("DELETE FROM push_subs");
      return json({ ok: true, revoked: n });
    }

    if (p === "/api/stream") {
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (p === "/api/feed") {
      const since = url.searchParams.get("since") ?? "";
      const rows = this.sql.exec("SELECT json FROM (SELECT seq, json FROM events WHERE ts > ? ORDER BY seq DESC LIMIT 300) ORDER BY seq", since).toArray();
      return json({ events: rows.map((r) => JSON.parse(r.json as string)) });
    }

    if (p === "/api/messages" && m === "POST") {
      const { text, reply_to } = (await req.json()) as { text?: string; reply_to?: string };
      if (!text?.trim()) return json({ error: "text required" }, 400);
      return json(this.ownerMessage(text, reply_to));
    }

    if (p === "/api/status") {
      const st = this.get("status") ?? {};
      return json({ ...st, hub: { online: this.hostOnline(), seen: this.get("host_seen") } });
    }

    if (p === "/api/settings" && m === "GET") return json(this.get("settings") ?? { current: {}, effective: {}, options: {} });
    if (p === "/api/settings" && m === "PUT") {
      const patch = await req.json();
      this.sql.exec("INSERT INTO inbox (json) VALUES (?)", JSON.stringify({ type: "settings", patch }));
      const view = this.get("settings") ?? { current: {} };
      const deep = (a: any, b: any): any => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deep(o[k] ?? {}, v) : v; return o; };
      view.current = deep(view.current ?? {}, patch);
      this.set("settings", view);
      return json(view);
    }

    if (p === "/api/media" && m === "POST") {
      const f = (await req.formData()).get("file") as File | null;
      if (!f) return json({ error: "file required" }, 400);
      if (f.size > MAX_MEDIA) return json({ error: "file too large" }, 413);
      const id = `${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
      const buf = new Uint8Array(await f.arrayBuffer());
      for (let i = 0, n = 0; i < buf.length; i += CHUNK, n++)
        this.sql.exec("INSERT INTO media (id, n, type, data) VALUES (?, ?, ?, ?)", id, n, f.type || "application/octet-stream", buf.slice(i, i + CHUNK));
      return json({ url: `/media/${id}` });
    }
    if (p.startsWith("/media/")) {
      const id = decodeURIComponent(p.slice(7));
      const rows = this.sql.exec("SELECT type, data FROM media WHERE id = ? ORDER BY n", id).toArray();
      if (!rows.length) return json({ error: "not found" }, 404);
      const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer));
      return new Response(new Blob(parts), { headers: { "content-type": rows[0].type as string, "cache-control": "private, max-age=31536000" } });
    }

    // ---- fleet side
    if (p === "/api/events" && m === "POST") return json(this.append((await req.json()) as Partial<Ev>));
    if (p === "/api/host/state" && m === "PUT") {
      const { status, settings } = (await req.json()) as { status?: unknown; settings?: unknown };
      if (status) this.set("status", status);
      if (settings) this.set("settings", settings);
      this.set("host_seen", Date.now());
      return json({ ok: true });
    }
    if (p === "/api/host/inbox") {
      const after = Number(url.searchParams.get("after") ?? 0);
      this.sql.exec("DELETE FROM inbox WHERE seq <= ?", after); // acked
      this.set("host_seen", Date.now());
      const items = this.sql.exec("SELECT seq, json FROM inbox ORDER BY seq LIMIT 50").toArray()
        .map((r) => ({ seq: r.seq as number, ...JSON.parse(r.json as string) }));
      return json({ items });
    }
    return json({ error: "not found" }, 404);
  }

  webSocketMessage() {}
  webSocketClose(ws: WebSocket) { try { ws.close(); } catch {} }
}

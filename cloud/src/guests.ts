// Guest workers: low-trust machines (shared / public test devices) that get one task at a time and nothing else.
// A guest never holds HUB_TOKEN: it joins with a one-time code the owner mints, and gets its own revocable token.
// Its whole API is /api/guest/{next,result,heartbeat}; every other route is closed to it (index.ts routes guests here
// before anything else). It never sees files, memory, chat, settings or other guests' tasks, and its results are
// untrusted: the primary picks them up and reviews them, nothing is applied automatically.
//
// Owner or machine: POST /api/guests/code {label} → {code, expires} · GET /api/guests → {guests} · POST /api/guests/revoke {id}
// Anyone:         POST /api/guest/join {code} → {id, token}            (the one-time code is the credential)
// Machine:        POST /api/guests/assign {guest, task: {id, title, body, repo?}} · GET /api/guests/results → {results}
//                 POST /api/guests/ack {ids}                            (the primary has consumed those results)
// Guest token:    GET /api/guest/next → {task|null} · POST /api/guest/result {id, ok, text, patch?} · PUT /api/guest/heartbeat

import type { FilesSql } from "./files";
import { L } from "./i18n";
type SqlStorage = FilesSql;

export const GUEST_TOKEN = /^g_[0-9a-f]{64}$/;
export const CODE_TTL = 10 * 60_000;
export const MAX_RESULT = 256 * 1024; // text + patch; screenshots go through a separate reviewed channel later
export const MAX_TASK = 32 * 1024;
const MAX_QUEUED = 20; // per guest
const CLAIM_TIMEOUT = 6 * 3600_000; // a claimed task with no result goes back to the queue

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const rand = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const json = (b: unknown, status = 200) => Response.json(b, { status });
const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, n);

export type GuestWho = { guest: string };

export function initGuestSchema(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS guests (id TEXT PRIMARY KEY, label TEXT, token_hash TEXT UNIQUE, created INTEGER, last_seen INTEGER, revoked INTEGER);
    CREATE TABLE IF NOT EXISTS guest_codes (hash TEXT PRIMARY KEY, label TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS guest_tasks (id TEXT PRIMARY KEY, guest TEXT, task TEXT, state TEXT, claimed INTEGER, result TEXT, ts INTEGER);
    CREATE INDEX IF NOT EXISTS guest_tasks_q ON guest_tasks (guest, state);`);
}

/** The guest behind a token, or null (unknown or revoked). */
export async function guestWho(sql: SqlStorage, token: string): Promise<GuestWho | null> {
  if (!GUEST_TOKEN.test(token)) return null;
  const r = sql.exec("SELECT id, revoked, last_seen FROM guests WHERE token_hash = ?", await sha256(token)).toArray()[0];
  if (!r || r.revoked) return null;
  if (Date.now() - Number(r.last_seen) > 60_000) sql.exec("UPDATE guests SET last_seen = ? WHERE id = ?", Date.now(), r.id);
  return { guest: String(r.id) };
}

/** Unauthenticated: trade a one-time code for a guest token. Codes are single use and expire in 10 minutes. */
export async function guestJoin(sql: SqlStorage, req: Request, notice: (t: string) => void): Promise<Response> {
  const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
  const c = String(code ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(c)) return json({ error: "invalid code" }, 400);
  const h = await sha256(c);
  const row = sql.exec("SELECT label, expires FROM guest_codes WHERE hash = ?", h).toArray()[0];
  sql.exec("DELETE FROM guest_codes WHERE hash = ? OR expires < ?", h, Date.now());
  if (!row || Number(row.expires) < Date.now()) return json({ error: "invalid code" }, 401);
  const id = `G-${rand(4)}`, token = `g_${rand(32)}`;
  sql.exec("INSERT INTO guests (id, label, token_hash, created, last_seen, revoked) VALUES (?, ?, ?, ?, ?, 0)", id, row.label, await sha256(token), Date.now(), Date.now());
  notice(L(`Guest machine ${row.label} (${id}) joined. It can only take tasks assigned to it.`, `访客机器 ${row.label}（${id}）已加入，只能领取派给它的任务。`));
  return json({ id, token });
}

/** Everything a guest token may do. */
export async function guestApi(sql: SqlStorage, req: Request, url: URL, who: GuestWho, onResult: (id: string, guest: string) => void): Promise<Response> {
  const p = url.pathname, m = req.method, g = who.guest;
  if (p === "/api/guest/heartbeat" && m === "PUT") { sql.exec("UPDATE guests SET last_seen = ? WHERE id = ?", Date.now(), g); return json({ ok: true }); }
  if (p === "/api/guest/next" && m === "GET") {
    sql.exec("UPDATE guest_tasks SET state = 'queued', claimed = NULL WHERE guest = ? AND state = 'claimed' AND claimed < ?", g, Date.now() - CLAIM_TIMEOUT);
    const r = sql.exec("SELECT id, task FROM guest_tasks WHERE guest = ? AND state = 'queued' ORDER BY ts LIMIT 1", g).toArray()[0];
    if (!r) return json({ task: null });
    sql.exec("UPDATE guest_tasks SET state = 'claimed', claimed = ? WHERE id = ?", Date.now(), r.id);
    return json({ task: JSON.parse(String(r.task)) });
  }
  if (p === "/api/guest/result" && m === "POST") {
    const raw = await req.text();
    if (raw.length > MAX_RESULT) return json({ error: "result too large" }, 413);
    let b: { id?: unknown; ok?: unknown; text?: unknown; patch?: unknown };
    try { b = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
    const id = String(b.id ?? "");
    const r = sql.exec("SELECT state FROM guest_tasks WHERE id = ? AND guest = ?", id, g).toArray()[0];
    if (!r || r.state !== "claimed") return json({ error: "not your task" }, 403);
    const result = { ok: b.ok === true, text: clean(b.text, MAX_RESULT), ...(typeof b.patch === "string" ? { patch: clean(b.patch, MAX_RESULT) } : {}) };
    sql.exec("UPDATE guest_tasks SET state = 'done', result = ? WHERE id = ?", JSON.stringify(result), id);
    onResult(id, g);
    return json({ ok: true });
  }
  return json({ error: "forbidden" }, 403); // nothing else exists for a guest
}

/** Owner session and machine routes under /api/guests/*; null when the path isn't one of them. */
export async function guestsAdmin(sql: SqlStorage, req: Request, url: URL, who: "machine" | "owner"): Promise<Response | null> {
  const p = url.pathname, m = req.method;
  if (!p.startsWith("/api/guests")) return null;
  const machine = who === "machine";
  if (p === "/api/guests" && m === "GET") {
    const guests = sql.exec("SELECT id, label, created, last_seen, revoked FROM guests ORDER BY created").toArray()
      .map((r: Record<string, unknown>) => ({ id: r.id, label: r.label, created: r.created, last_seen: r.last_seen, revoked: !!r.revoked }));
    return json({ guests });
  }
  if (p === "/api/guests/code" && m === "POST") { // owner (app) or a machine (`noop guest invite`): both already outrank a guest
    const { label } = (await req.json().catch(() => ({}))) as { label?: unknown };
    const l = clean(label, 60).trim();
    if (!l) return json({ error: "label required" }, 400);
    const code = rand(16), expires = Date.now() + CODE_TTL;
    sql.exec("INSERT INTO guest_codes (hash, label, expires) VALUES (?, ?, ?)", await sha256(code), l, expires);
    return json({ code, expires });
  }
  if (p === "/api/guests/revoke" && m === "POST") { // owner or machine (the fleet may pull a misbehaving guest)
    const { id } = (await req.json().catch(() => ({}))) as { id?: unknown };
    sql.exec("UPDATE guests SET revoked = 1 WHERE id = ?", String(id ?? ""));
    sql.exec("DELETE FROM guest_tasks WHERE guest = ? AND state != 'done'", String(id ?? ""));
    return json({ ok: true });
  }
  if (!machine) return json({ error: "forbidden" }, 403);
  if (p === "/api/guests/assign" && m === "POST") {
    const raw = await req.text();
    if (raw.length > MAX_TASK) return json({ error: "task too large" }, 413);
    const { guest, task } = (JSON.parse(raw || "{}") ?? {}) as { guest?: unknown; task?: { id?: unknown; title?: unknown; body?: unknown; repo?: unknown } };
    const g = sql.exec("SELECT id FROM guests WHERE id = ? AND revoked = 0", String(guest ?? "")).toArray()[0];
    if (!g) return json({ error: "no such guest" }, 404);
    const id = String(task?.id ?? "");
    if (!/^T-[\w-]{1,40}$/.test(id)) return json({ error: "task id required" }, 400);
    if (task?.repo && !/^https:\/\/[^\s]+$/.test(String(task.repo))) return json({ error: "repo must be an https:// URL" }, 400);
    const n = Number(sql.exec("SELECT COUNT(*) AS n FROM guest_tasks WHERE guest = ? AND state != 'done'", g.id).toArray()[0].n);
    if (n >= MAX_QUEUED) return json({ error: "queue full" }, 429);
    // only what the guest needs: the task text the primary wrote for it, never memory or the owner's profile
    const t = { id, title: clean(task?.title, 200), body: clean(task?.body, MAX_TASK), ...(task?.repo ? { repo: clean(task.repo, 200) } : {}) };
    sql.exec("INSERT OR REPLACE INTO guest_tasks (id, guest, task, state, claimed, result, ts) VALUES (?, ?, ?, 'queued', NULL, NULL, ?)", id, g.id, JSON.stringify(t), Date.now());
    return json({ ok: true });
  }
  if (p === "/api/guests/results" && m === "GET") {
    const results = sql.exec("SELECT t.id, t.guest, g.label, t.result FROM guest_tasks t JOIN guests g ON g.id = t.guest WHERE t.state = 'done' ORDER BY t.ts LIMIT 20").toArray()
      .map((r: Record<string, unknown>) => ({ id: r.id, guest: r.guest, label: r.label, untrusted: true, ...JSON.parse(String(r.result)) }));
    return json({ results });
  }
  if (p === "/api/guests/ack" && m === "POST") {
    const { ids } = (await req.json().catch(() => ({}))) as { ids?: unknown };
    for (const id of Array.isArray(ids) ? ids.slice(0, 50) : []) sql.exec("DELETE FROM guest_tasks WHERE id = ? AND state = 'done'", String(id));
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

// Hub server: runs inside the primary daemon. Chat API (for the NSH client), built-in web chat (PWA), media.
// Reach it from phone / Mac over Tailscale (`tailscale serve --bg 8787` gives HTTPS on your tailnet). No cloud.
//
// API (Bearer token = [server].token in config.local.toml):
//   GET  /api/feed?since=<iso>            → { events: Event[] }        chat timeline (newest last)
//   GET  /api/stream                      → WebSocket, pushes Event JSON as it happens
//   POST /api/messages {text, reply_to?}  → owner message: answers D-/P-/L- ids, otherwise becomes a task for `lead`
//   GET  /api/status                      → queue, decisions, hosts, accounts
//   POST /api/media (multipart file)      → { url }   (workers upload screenshots/recordings here)
//   GET  /media/<file>                    → attachment
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { type Cfg, DATA, P, allowedClis, hostName, list, loadConfig, onlineHosts, readDoc } from "./core";

export type Event = {
  id: string; ts: string; from: string; kind: "notice" | "decision" | "menu" | "proposals" | "login" | "owner" | "system";
  text: string; ref?: string; options?: string[]; attachments?: string[];
};

const MEDIA = join(DATA, "..", "media");
const NSH_WEB = join(import.meta.dir, "..", "app", "dist", "web", "noop"); // built NSH web client
const FEED_DIR = join(DATA, "..", "feed"); // primary-local (next to the data repo), append-only JSONL per day
const sockets = new Set<ServerWebSocket<unknown>>();
type Inbound = { id: string; answer: string; source: string };
const inbound: Inbound[] = [];
let ownerTask: ((text: string) => Promise<string>) | null = null;

const today = () => new Date().toLocaleDateString("sv-SE");

let mirror: ((e: Event) => void) | null = null; // cloud bridge: copies primary events to the Cloudflare hub
export const setMirror = (fn: (e: Event) => void) => { mirror = fn; };

export function appendEvent(e: Omit<Event, "id" | "ts"> & Partial<Pick<Event, "id" | "ts">>, opts: { mirror?: boolean } = {}): Event {
  mkdirSync(FEED_DIR, { recursive: true });
  const ev: Event = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e };
  if (opts.mirror !== false) mirror?.(ev);
  appendFileSync(join(FEED_DIR, `${today()}.jsonl`), JSON.stringify(ev) + "\n");
  for (const ws of sockets) ws.send(JSON.stringify(ev));
  return ev;
}

export function feed(since?: string, limit = 300): Event[] {
  if (!existsSync(FEED_DIR)) return [];
  const files = readdirSync(FEED_DIR).sort().slice(-7);
  const evs = files.flatMap((f) => readFileSync(join(FEED_DIR, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event));
  return evs.filter((e) => !since || e.ts > since).slice(-limit);
}

/** Replies the daemon should process (same shape as Slack/Discord replies). */
export const drainInbound = () => inbound.splice(0);

/** Store a local file as media; returns a server-relative URL. */
export function storeMedia(path: string): string {
  mkdirSync(MEDIA, { recursive: true });
  const name = `${Date.now()}-${basename(path).replace(/[^\w.\-]/g, "_")}`;
  writeFileSync(join(MEDIA, name), readFileSync(path));
  return `/media/${name}`;
}

/** Workers (not primary) upload media to the primary server. */
export async function uploadMedia(path: string, cfg: Cfg): Promise<string | null> {
  const url = cfg.server?.url;
  if (!url) return null;
  const fd = new FormData();
  fd.append("file", Bun.file(path), basename(path));
  const r = await fetch(`${url.replace(/\/$/, "")}/api/media`, { method: "POST", body: fd, headers: { Authorization: `Bearer ${cfg.server?.token}` } }).catch(() => null);
  return r?.ok ? ((await r.json()) as any).url : null;
}

/** Workers forward events to the primary so the chat timeline is complete. */
export async function forwardEvent(e: Omit<Event, "id" | "ts">, cfg: Cfg) {
  const url = cfg.server?.url;
  if (!url) return false;
  const r = await fetch(`${url.replace(/\/$/, "")}/api/events`, {
    method: "POST", body: JSON.stringify(e), headers: { Authorization: `Bearer ${cfg.server?.token}`, "Content-Type": "application/json" },
  }).catch(() => null);
  return !!r?.ok;
}

/** The last journal lines, for each task's timeline. */
function journalLines(): string[] {
  const dir = P("journal");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(-2);
  return files.flatMap((f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => `${f.slice(0, 10)} ${l.slice(2)}`));
}

/** What the app shows for a task: its request, state, timeline and results. */
function taskView(path: string, state: string, log: string[]) {
  const { meta: m, body } = readDoc(path);
  const request = (body.match(/> [\s\S]*?(?=\n\n[^>]|$)/)?.[0] ?? body.split("\n## ")[0]).replace(/^> ?/gm, "").trim().slice(0, 1200);
  const runs = [...body.matchAll(/## Run (\S+) · (\S+) · (\S+)\n\*\*(\w+)\*\* — ([^\n]*)/g)]
    .map((r) => ({ ts: r[1], host: r[2], cli: r[3], status: r[4], summary: r[5] })).slice(-5);
  const steps = log.filter((l) => l.includes(` ${m.id} `) || l.endsWith(` ${m.id}`)).slice(-12)
    .map((l) => { const x = l.match(/^(\S+) (\d\d:\d\d) `([^`]+)` (.*)$/); return x ? { day: x[1], time: x[2], host: x[3], text: x[4] } : { text: l }; });
  return { id: m.id, title: m.title, agent: m.agent, host: m.claimed_by, state, started: m.started, created: m.created,
    finished: m.finished, updated: m.finished ?? m.started ?? m.created, attempt: m.attempt, decision: m.decision, request, runs, steps };
}

export function status() {
  const log = journalLines();
  const count = (f: string) => list(P("tasks", f), /^T-.*\.md$/).length;
  return {
    tasks: Object.fromEntries(["proposed", "inbox", "active", "waiting", "blocked", "failed", "done"].map((f) => [f, count(f)])),
    active: list(P("tasks", "active"), /^T-.*\.md$/).map((p) => taskView(p, "active", log)),
    recent: ["done", "failed", "blocked", "waiting", "inbox"].flatMap((f) => list(P("tasks", f), /^T-.*\.md$/).map((p) => taskView(p, f, log)))
      .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")).slice(0, 12),
    decisions: list(P("decisions", "open")).map((p) => { const m = readDoc(p).meta; return { id: m.id, kind: m.kind ?? "decision", question: m.question, held: !!m.held }; }),
    hosts: onlineHosts({}),
  };
}

// ---------------------------------------------------------------- settings (UI-adjustable, shared via data repo)
const SETTABLE = ["clis", "autonomy", "routines", "host", "idle", "judge", "resources", "notify_prefs"]; // whitelisted top-level keys

export function settingsView() {
  const cfg = loadConfig();
  const agents = readdirSync(P("agents"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  return {
    current: existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {},
    effective: {
      agents: agents.map((a) => ({ id: a, clis: allowedClis({ agent: a }, cfg), autonomy: cfg.autonomy?.agents?.[a] ?? cfg.autonomy?.level ?? "onboarding" })),
      autonomy: cfg.autonomy?.level ?? "onboarding",
      routines: (cfg.routine ?? []).map((r: any) => ({ name: r.name, every: r.every, agent: r.agent, enabled: r.enabled !== false })),
      max_parallel: cfg.host?.max_parallel ?? null,
    },
    options: { clis: [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] },
  };
}

let settingsHook: ((summary: string) => Promise<void>) | null = null;
export const onSettingsSaved = (fn: (summary: string) => Promise<void>) => { settingsHook = fn; };

export async function saveSettings(patch: Record<string, unknown>) {
  const cur = existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {};
  const deep = (a: any, b: any): any => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deep(o[k] ?? {}, v) : v;
    return o;
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => SETTABLE.includes(k)));
  const next = deep(cur, clean);
  writeFileSync(P("settings.json"), JSON.stringify(next, null, 2) + "\n");
  await settingsHook?.(JSON.stringify(clean));
  return settingsView();
}

const ID = /^\s*([DLP]-[A-Z]?\d{4})\b[\s:：,，\-]*([\s\S]*)$/;

/** Owner said something (local chat or via the cloud inbox): answer an open D-/P-/L- item, or hand it to lead. */
let lastAnswer: { id: string; at: number } | null = null;
let followUp: { tid: string; at: number } | null = null;
const FOLLOW_MS = 3 * 60_000;
let appendToTask: ((tid: string, text: string) => Promise<boolean>) | null = null;
export const setAppendToTask = (fn: (tid: string, text: string) => Promise<boolean>) => { appendToTask = fn; };
const AMEND_MS = 5 * 60_000;

export async function handleOwnerMessage(text: string, reply_to?: string, noAmend = false) {
  const m = text.match(ID);
  const id = m?.[1] ?? (reply_to && /^[DLP]-[A-Z]?\d{4}$/.test(reply_to) ? reply_to : null);
  if (id) {
    inbound.push({ id, answer: (m ? m[2] : text).trim(), source: "chat" });
    if (id.startsWith("D-")) lastAnswer = { id, at: Date.now() };
  } else if (!noAmend && lastAnswer && Date.now() - lastAnswer.at < AMEND_MS) {
    // a plain message right after answering a decision is about that decision ("wait, I clicked the wrong one")
    inbound.push({ id: lastAnswer.id, answer: text.trim(), source: "chat-amend" });
  } else if (followUp && Date.now() - followUp.at < FOLLOW_MS && (await appendToTask?.(followUp.tid, text))) {
    // messages sent in a row are one request: add to the task just created instead of opening another
    followUp.at = Date.now();
    appendEvent({ from: "hub", kind: "system", text: `已补充到 ${followUp.tid}`, ref: followUp.tid });
  } else if (ownerTask) {
    const tid = await ownerTask(text);
    followUp = { tid, at: Date.now() };
    appendEvent({ from: "hub", kind: "system", text: `收到，交给 Kai 安排（${tid}）。做完带结果回来，需要你拍板时会给你选项。`, ref: tid });
  }
}

export const setOwnerTask = (fn: (text: string) => Promise<string>) => { ownerTask = fn; };

export function startServer(cfg: Cfg, onOwnerTask: (text: string) => Promise<string>) {
  const s = cfg.server ?? {};
  if (s.enabled === false) return;
  if (!s.token) { console.error("server: set [server].token in config.local.toml to enable the chat API"); return; }
  ownerTask = onOwnerTask;
  const auth = (req: Request) => {
    const h = req.headers.get("authorization") ?? "";
    const q = new URL(req.url).searchParams.get("token");
    return h === `Bearer ${s.token}` || q === s.token;
  };
  const json = (d: unknown, status = 200) => Response.json(d, { status });

  const server = Bun.serve({
    hostname: s.host ?? "0.0.0.0",
    port: s.port ?? 8787,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // The NSH client's web package (app: `nsh package --target web -o dist/web`) when built; else web/index.html.
      if (existsSync(join(NSH_WEB, "index.html")) && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) {
        const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const f = join(NSH_WEB, rel);
        if (!rel.includes("..") && existsSync(f) && statSync(f).isFile()) return new Response(Bun.file(f));
      }
      if (url.pathname === "/" || url.pathname === "/index.html")
        return new Response(Bun.file(join(import.meta.dir, "..", "web", "index.html")));
      if (url.pathname === "/manifest.webmanifest")
        return new Response(Bun.file(join(import.meta.dir, "..", "web", "manifest.webmanifest")));
      if (!auth(req)) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/stream" && srv.upgrade(req)) return undefined as unknown as Response;
      if (url.pathname.startsWith("/media/")) {
        const f = join(MEDIA, basename(url.pathname));
        return existsSync(f) ? new Response(Bun.file(f)) : json({ error: "not found" }, 404);
      }
      if (url.pathname === "/api/feed") return json({ events: feed(url.searchParams.get("since") ?? undefined) });
      if (url.pathname === "/api/status") return json(status());
      if (url.pathname === "/api/settings" && req.method === "GET") return json(settingsView());
      if (url.pathname === "/api/settings" && req.method === "PUT") return json(await saveSettings((await req.json()) as Record<string, unknown>));
      if (url.pathname === "/api/media" && req.method === "POST") {
        const f = (await req.formData()).get("file") as File | null;
        if (!f) return json({ error: "file required" }, 400);
        mkdirSync(MEDIA, { recursive: true });
        const name = `${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
        await Bun.write(join(MEDIA, name), f);
        return json({ url: `/media/${name}` });
      }
      if (url.pathname === "/api/events" && req.method === "POST") return json(appendEvent(await req.json() as Event));
      if (url.pathname === "/api/messages" && req.method === "POST") {
        const { text, reply_to } = (await req.json()) as { text: string; reply_to?: string };
        if (!text?.trim()) return json({ error: "text required" }, 400);
        const ev = appendEvent({ from: "owner", kind: "owner", text, ref: reply_to });
        await handleOwnerMessage(text, reply_to);
        return json(ev);
      }
      return json({ error: "not found" }, 404);
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message() {},
    },
  });
  console.log(`hub server on http://${server.hostname}:${server.port}  (phone: tailscale serve --bg ${server.port})`);
  return server;
}

export const hostLabel = (cfg: Cfg) => hostName(cfg);

// Guest worker client: a low-trust machine (a shared Windows test box, a public device) that runs one task at a time.
// It stores only its own guest token (no HUB_TOKEN, no DATA mirror, no memory, no GitHub credentials of ours) in
// NOOP_GUEST_HOME (default ~/.noop-guest). Each OS account / person on a shared machine uses its own home, so several
// people's guests on one device never see each other. Tasks run in a fresh scratch folder with this machine's own
// claude/codex login; the answer (text + `git diff`) goes back as an untrusted result the primary reviews.
//   noop guest join <url> <code>   ·   noop guest run [--cli claude|codex] [--once]
// Primary (machine key): noop guest invite <label> · noop guest list · noop guest assign <G-id> <T-id> [title] [-b body] [--repo url] · noop guest results · noop guest revoke <G-id>
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = () => process.env.NOOP_GUEST_HOME || join(homedir(), ".noop-guest");
type GuestCfg = { url: string; id: string; token: string };

export function readGuestCfg(): GuestCfg | null {
  const f = join(HOME(), "guest.json");
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; }
}

async function call(c: GuestCfg, path: string, init: RequestInit = {}) {
  const r = await fetch(c.url + path, { ...init, headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  return r;
}

/** A guest task's prompt: the task as the primary wrote it, plus the guest's limits. Nothing else is sent or added. */
export function guestPrompt(t: { id: string; title: string; body: string; repo?: string }) {
  return [`You are running on a shared test machine as a low-trust guest worker. Task ${t.id}: ${t.title}`, "", t.body, "",
    "Rules: work only inside the current folder. Do not push, open PRs, post comments or use any credentials you find.",
    "Finish with a short plain-text report of what you did and what you observed; code changes stay in the working tree."].join("\n");
}

async function runOne(c: GuestCfg, cli: string): Promise<boolean> {
  const r = await call(c, "/api/guest/next");
  if (r?.status === 401) throw new Error("this guest was revoked or its token is invalid: run `noop guest join` again");
  const t = r?.ok ? ((await r.json()) as any).task : null;
  if (!t) return false;
  console.log(`▶ ${t.id} ${t.title}`);
  const dir = mkdtempSync(join(tmpdir(), "noop-guest-"));
  let ok = false, text = "", patch = "";
  try {
    let cwd = dir;
    if (t.repo) {
      const clone = Bun.spawnSync(["git", "clone", "--depth", "50", t.repo, "repo"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr.toString().slice(-500)}`);
      cwd = join(dir, "repo");
    }
    const cmd = cli === "codex" ? ["codex", "exec", "--skip-git-repo-check", "-"] : ["claude", "-p", "--output-format", "text", "--permission-mode", "acceptEdits"];
    const p = Bun.spawn(cmd, { cwd, stdin: new Blob([guestPrompt(t)]), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    ok = (await p.exited) === 0;
    text = (out || err).slice(-200_000);
    if (t.repo) patch = Bun.spawnSync(["git", "diff"], { cwd }).stdout.toString().slice(0, 50_000);
  } catch (e) { text = String((e as Error).message ?? e); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  const res = await call(c, "/api/guest/result", { method: "POST", body: JSON.stringify({ id: t.id, ok, text, ...(patch ? { patch } : {}) }) });
  console.log(`${ok ? "✓" : "✗"} ${t.id} reported (${res?.status ?? "network error"})`);
  return true;
}

async function admin(cfg: any, path: string, init: RequestInit = {}) {
  const url = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
  if (!url || !cfg.server?.token) throw new Error("this machine isn't connected to a Noop cloud");
  const r = await fetch(url + path, { ...init, headers: { Authorization: `Bearer ${cfg.server.token}`, "Content-Type": "application/json" } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(b as any).error ?? ""}`);
  return b as any;
}

export async function guestCmd(rest: string[], loadCfg: () => any) {
  const [sub, ...a] = rest;
  const flag = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a.splice(i, 2)[1] : undefined; };
  switch (sub) {
    case "join": {
      const [url, code] = a;
      if (!url || !code) return void console.log("usage: noop guest join <url> <code>");
      const base = url.replace(/\/$/, "");
      const r = await fetch(`${base}/api/guest/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const b = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) return void console.log(`join failed: ${b.error ?? r.status}`);
      mkdirSync(HOME(), { recursive: true });
      const f = join(HOME(), "guest.json");
      writeFileSync(f, JSON.stringify({ url: base, id: b.id, token: b.token }, null, 2));
      try { chmodSync(f, 0o600); } catch { /* Windows */ }
      return void console.log(`joined as guest ${b.id}; run \`noop guest run\` to start taking tasks`);
    }
    case "run": {
      const c = readGuestCfg();
      if (!c) return void console.log("not joined: noop guest join <url> <code>");
      const cli = flag("--cli") ?? "claude", once = a.includes("--once");
      for (;;) {
        await call(c, "/api/guest/heartbeat", { method: "PUT" });
        const did = await runOne(c, cli);
        if (once) return;
        if (!did) await Bun.sleep(30_000);
      }
    }
    case "invite": {
      const label = a.join(" ").trim();
      if (!label) return void console.log("usage: noop guest invite <label>");
      const cfg = loadCfg(), { code } = await admin(cfg, "/api/guests/code", { method: "POST", body: JSON.stringify({ label }) });
      return void console.log(`\n  on the guest machine (valid 10 minutes, once):\n  noop guest join ${String(cfg.cloud.url).replace(/\/$/, "")} ${code}\n`);
    }
    case "list": {
      const { guests } = await admin(loadCfg(), "/api/guests");
      for (const g of guests) console.log(`${g.id}  ${g.label}  ${g.revoked ? "revoked" : `last seen ${new Date(g.last_seen).toISOString()}`}`);
      return;
    }
    case "assign": {
      const body = flag("-b") ?? "", repo = flag("--repo");
      const [guest, id, ...title] = a;
      if (!guest || !id) return void console.log("usage: noop guest assign <G-id> <T-id> [title] [-b body] [--repo url]");
      await admin(loadCfg(), "/api/guests/assign", { method: "POST", body: JSON.stringify({ guest, task: { id, title: title.join(" ") || id, body, ...(repo ? { repo } : {}) } }) });
      return void console.log(`queued ${id} for ${guest}`);
    }
    case "results": {
      const cfg = loadCfg(), { results } = await admin(cfg, "/api/guests/results");
      for (const r of results) console.log(`--- ${r.id} from guest ${r.label} (${r.guest}) · ${r.ok ? "ok" : "failed"} · UNTRUSTED\n${r.text}${r.patch ? `\n--- patch\n${r.patch}` : ""}`);
      if (results.length && a.includes("--ack")) await admin(cfg, "/api/guests/ack", { method: "POST", body: JSON.stringify({ ids: results.map((r: any) => r.id) }) });
      return;
    }
    case "revoke": {
      if (!a[0]) return void console.log("usage: noop guest revoke <G-id>");
      await admin(loadCfg(), "/api/guests/revoke", { method: "POST", body: JSON.stringify({ id: a[0] }) });
      return void console.log(`revoked ${a[0]}`);
    }
    default: console.log("usage: noop guest join|run|invite|list|assign|results|revoke");
  }
}

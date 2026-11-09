// Guest worker client: a low-trust machine (a shared Windows test box, a public device) that runs one task at a time.
// It stores only its own guest token (no HUB_TOKEN, no DATA mirror, no memory, no GitHub credentials of ours) in
// NOOP_GUEST_HOME (default ~/.noop-guest). Each OS account / person on a shared machine uses its own home, so several
// people's guests on one device never see each other. Tasks run in a fresh scratch folder with this machine's own
// claude/codex login; the answer (text + `git diff`) goes back as an untrusted result the primary reviews.
//   noop guest join <url> <code>   ·   noop guest run [--cli claude|codex] [--once]   ·   noop guest install | uninstall
// Primary (machine key): noop guest invite <label> · noop guest list · noop guest assign <G-id> <T-id> [title] [-b body] [--repo url] · noop guest results · noop guest revoke <G-id>
import { $ } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { GUEST_IDLE_MS } from "../cloud/src/budget";

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

class Revoked extends Error {}

async function runOne(c: GuestCfg, cli: string): Promise<boolean> {
  const r = await call(c, "/api/guest/next"); // also the heartbeat: the Worker refreshes last_seen on every guest request
  if (r?.status === 401) throw new Revoked("this guest was revoked or its token is invalid: run `noop guest join` again");
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

const SITE = "https://huacnlee.github.io/noop";

/** What `noop guest invite` prints: one line per OS that installs Noop and joins as this guest, no login. */
export function guestInvite(url: string, code: string): string {
  return [
    "", "  on the guest machine, in the account that runs it (valid 10 minutes, once):", "",
    "  Windows (PowerShell):",
    `  $env:NOOP_GUEST = "${url} ${code}"; irm ${SITE}/install.ps1 | iex`, "",
    "  macOS / Linux:",
    `  curl -fsSL ${SITE}/install.sh | bash -s -- --guest ${url} ${code}`, "",
    `  already has Noop:  noop guest join ${url} ${code}`, "",
  ].join("\n");
}

export async function guestCmd(rest: string[], loadCfg: () => any) {
  const [sub, ...a] = rest;
  const flag = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a.splice(i, 2)[1] : undefined; };
  switch (sub) {
    case "join": {
      const [url, code] = a;
      if (!url || !code) { process.exitCode = 1; return void console.log("usage: noop guest join <url> <code>"); }
      const base = url.replace(/\/$/, "");
      const r = await fetch(`${base}/api/guest/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const b = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) { process.exitCode = 1; return void console.log(`join failed: ${b.error ?? r.status}`); }
      mkdirSync(HOME(), { recursive: true });
      const f = join(HOME(), "guest.json");
      writeFileSync(f, JSON.stringify({ url: base, id: b.id, token: b.token }, null, 2));
      try { chmodSync(f, 0o600); } catch { /* Windows */ }
      return void console.log(`joined as guest ${b.id}; run \`noop guest run\` to start taking tasks`);
    }
    case "run": {
      const c = readGuestCfg();
      if (!c) return void console.log("not joined: noop guest join <url> <code>");
      const cli = flag("--cli") ?? defaultCli(), once = a.includes("--once");
      console.log(`guest ${c.id} on ${c.url}, running tasks with ${cli}`);
      for (;;) {
        let did = false;
        try { did = await runOne(c, cli); } catch (e) {
          if (e instanceof Revoked) {
            // Park the token so a service restarting this command does not keep asking the Worker.
            renameSync(join(HOME(), "guest.json"), join(HOME(), "guest.revoked.json"));
            return void console.log(e.message);
          }
          console.log(`guest: ${(e as Error).message ?? e}`);
        }
        if (once) return;
        if (!did) await Bun.sleep(GUEST_IDLE_MS);
      }
    }
    case "install": return installGuestService(flag("--cli"));
    case "uninstall": return uninstallGuestService();
    case "invite": {
      const label = a.join(" ").trim();
      if (!label) return void console.log("usage: noop guest invite <label>");
      const cfg = loadCfg(), { code } = await admin(cfg, "/api/guests/code", { method: "POST", body: JSON.stringify({ label }) });
      return void console.log(guestInvite(String(cfg.cloud.url).replace(/\/$/, ""), code));
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
    default: console.log("usage: noop guest join|run|install|uninstall|invite|list|assign|results|revoke");
  }
}

/** The guest runs tasks with this machine's own model login: claude when it is installed, else codex. */
function defaultCli() { return Bun.which("claude") || !Bun.which("codex") ? "claude" : "codex"; }

// ------------------------------------------------------------------ guest service
// Per OS account, like the guest home: each person's guest starts at their own login and never needs admin rights.
const GUEST_LABEL = "dev.noop.guest";

/** Run `noop guest run` in the background from now on and at every login of this account. */
export async function installGuestService(cliFlag?: string) {
  if (!readGuestCfg()) { process.exitCode = 1; return void console.log("not joined: noop guest join <url> <code>"); }
  const cli = cliFlag ?? defaultCli();
  if (!Bun.which(cli)) console.log(`! ${cli} is not installed: install it and log in, or the guest cannot run tasks`);
  const bun = process.execPath, entry = join(import.meta.dir, "cli.ts"), home = HOME(), log = join(home, "guest.log");
  const args = [bun, entry, "guest", "run", "--cli", cli];
  const path = [join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  mkdirSync(home, { recursive: true });
  if (process.platform === "linux") {
    const unit = join(homedir(), ".config/systemd/user/noop-guest.service");
    mkdirSync(join(unit, ".."), { recursive: true });
    // on-failure: a revoked guest exits 0 and stays stopped instead of asking the Worker again every few seconds
    writeFileSync(unit, `[Unit]\nDescription=Noop guest worker\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${args.join(" ")}\nRestart=on-failure\nRestartSec=60\nEnvironment=PATH=${path}\nEnvironment=NOOP_GUEST_HOME=${home}\nNice=5\n\n[Install]\nWantedBy=default.target\n`);
    await $`systemctl --user daemon-reload`.nothrow();
    await $`systemctl --user enable --now noop-guest.service`.nothrow();
    await $`systemctl --user restart noop-guest.service`.nothrow();
    console.log(`✔ guest service installed: ${unit}\n  logs: journalctl --user -u noop-guest -f`);
  } else if (process.platform === "darwin") {
    const plist = join(homedir(), `Library/LaunchAgents/${GUEST_LABEL}.plist`);
    const x = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${GUEST_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((v) => `<string>${x(v)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string><key>NOOP_GUEST_HOME</key><string>${x(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict></plist>
`);
    await $`launchctl bootout gui/${process.getuid!()} ${plist}`.quiet().nothrow();
    await $`launchctl bootstrap gui/${process.getuid!()} ${plist}`.nothrow();
    console.log(`✔ guest service installed: ${plist}\n  logs: ${log}`);
  } else if (process.platform === "win32") {
    // A hidden window started from the account's Run key: no admin rights, no task name shared with other accounts.
    const vbs = join(home, "guest.vbs"), vb = (v: string) => `"${v.replace(/"/g, '""')}"`;
    // cmd /c strips one outer pair of quotes, so the whole command line gets its own pair
    const cmd = `cmd /c ""${bun}" "${entry}" guest run --cli ${cli} >> "${log}" 2>&1"`;
    writeFileSync(vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Environment("Process")("NOOP_GUEST_HOME") = ${vb(home)}\r\nsh.Run ${vb(cmd)}, 0, False\r\n`);
    await $`reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v NoopGuest /t REG_SZ /d ${`wscript.exe "${vbs}"`} /f`.quiet().nothrow();
    await stopWindowsGuest();
    await $`wscript.exe ${vbs}`.nothrow();
    console.log(`✔ guest service installed: starts at every login of ${userInfo().username}\n  logs: ${log}`);
  }
}

export async function uninstallGuestService() {
  if (process.platform === "linux") {
    await $`systemctl --user disable --now noop-guest.service`.nothrow();
    rmSync(join(homedir(), ".config/systemd/user/noop-guest.service"), { force: true });
  } else if (process.platform === "darwin") {
    const plist = join(homedir(), `Library/LaunchAgents/${GUEST_LABEL}.plist`);
    await $`launchctl bootout gui/${process.getuid!()} ${plist}`.quiet().nothrow();
    rmSync(plist, { force: true });
  } else if (process.platform === "win32") {
    await $`reg delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v NoopGuest /f`.quiet().nothrow();
    await stopWindowsGuest();
  }
  console.log("✔ guest service removed");
}

/** This account's running `guest run` processes (other accounts' guests are left alone). */
async function stopWindowsGuest() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object { $_.CommandLine -like '*guest run*' -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  await $`powershell -NoProfile -Command ${ps}`.quiet().nothrow();
}

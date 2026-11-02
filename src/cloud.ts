// Cloud bridge: connects the fleet to the owner's own Cloudflare Worker (cloud/). Outbound HTTPS only.
//   primary: mirrors every feed event up, pulls the owner's messages/settings down, pushes status + settings snapshots.
//   workers: forward events/media straight to the Worker (cfg.server.url points there).
// `hub cloud deploy` deploys the Worker into the owner's Cloudflare account (wrangler login once) and records the URL.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Jwk, newVapidKeys } from "../cloud/src/push";
import { type Cfg, CODE, P, _commitPush, _pull, hostName, journal, locked, HOME_DIR } from "./core";
import { writeHubToml } from "./sync";
import { type Event, MEDIA, appendEvent, handleOwnerMessage, saveSettings, setMirror, settingsView, status, cancelTask, updateFleet } from "./server";

const base = (cfg: Cfg) => String(cfg.cloud?.url ?? "").replace(/\/$/, "");
const headers = (cfg: Cfg) => ({ Authorization: `Bearer ${cfg.server?.token}`, "Content-Type": "application/json" });

async function call(cfg: Cfg, path: string, init: RequestInit = {}) {
  const r = await fetch(base(cfg) + path, { ...init, headers: headers(cfg), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!r?.ok) return null;
  return r.json() as Promise<any>;
}

/** One of the Worker's media files ("/media/<id>": the owner's uploaded images), as bytes. */
export async function cloudMedia(cfg: Cfg, path: string): Promise<Uint8Array | null> {
  if (!/^\/media\/[\w.\-]+$/.test(path)) return null;
  const r = await fetch(base(cfg) + path, { headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

/** Primary: run the bridge loop. */
export function startCloudBridge(cfg: Cfg) {
  if (!base(cfg) || !cfg.server?.token) return;
  const pending: Event[] = [];
  // an event's images live in this machine's media folder ("/media/<name>"): upload them first, then point the event at the copies
  const upload = async (url: string): Promise<string | null> => {
    const f = join(MEDIA, basename(url));
    if (!url.startsWith("/media/") || !existsSync(f)) return url;
    const fd = new FormData();
    fd.append("file", Bun.file(f), basename(f));
    const r = await fetch(base(cfg) + "/api/media", { method: "POST", body: fd, headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    return r?.ok ? ((await r.json()) as { url: string }).url : null;
  };
  const flush = async () => {
    while (pending.length) {
      const e = pending[0];
      if (e.attachments?.length) {
        const urls = await Promise.all(e.attachments.map(upload));
        if (urls.some((u) => !u)) return; // retry on the next poll
        pending[0] = { ...e, attachments: urls as string[] };
      }
      if (!(await call(cfg, "/api/events", { method: "POST", body: JSON.stringify(pending[0]) }))) return;
      pending.shift();
    }
  };
  setMirror((e) => { pending.push(e); void flush(); });

  let after = 0, n = 0, busy = false, lastStatus = "";
  // push the dashboard whenever it changes (an answered decision must leave "待你决定" at once), else every 10th poll
  const pushStatus = async (force = false) => {
    const st = JSON.stringify(status());
    if (!force && st === lastStatus) return;
    if (await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ status: JSON.parse(st), settings: settingsView() }) })) lastStatus = st;
  };
  const loop = async () => {
    if (busy) return; busy = true;
    try {
      await flush();
      await pushStatus(n++ % 10 === 0);
      const r = await call(cfg, `/api/host/inbox?after=${after}`);
      for (const it of r?.items ?? []) {
        if (it.type === "message") {
          const e = it.event as Event;
          appendEvent(e, { mirror: false }); // keep the local record (learning reads it); the cloud already has it
          await handleOwnerMessage(e.text, e.ref, false, { paths: e.attachments, key: e.id, fetch: (p) => cloudMedia(cfg, p) });
        } else if (it.type === "cancel" && typeof it.id === "string") {
          await cancelTask(it.id);
        } else if (it.type === "update") {
          await updateFleet();
        } else if (it.type === "settings") {
          await saveSettings(it.patch);
          await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ settings: settingsView() }) });
        }
        after = it.seq;
      }
      if (r?.items?.length) await pushStatus();
    } catch (err) { console.error(`cloud bridge: ${err}`); }
    busy = false;
  };
  void loop();
  setInterval(loop, (cfg.cloud?.poll_seconds ?? 3) * 1000);
  console.log(`cloud bridge → ${base(cfg)}`);
}

/** Web Push VAPID keypair: generated once, kept in ~/.noop/vapid.json (0600) so redeploys keep phones subscribed. */
async function vapidKeys(): Promise<{ publicKey: string; privateJwk: Jwk }> {
  const f = join(HOME_DIR, "vapid.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const k = await newVapidKeys();
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(k), { mode: 0o600 });
  return k;
}

/** Why the last cloudDeploy returned false (for the journal: a daemon's console is out of the owner's sight). */
export let lastDeployError = "";

/** Deploy the Worker into the owner's Cloudflare account; set the token secret; record the URL (noop.toml + shared config). */
export async function cloudDeploy(cfg: Cfg) {
  lastDeployError = "";
  const fail = (why: string) => { lastDeployError = why; console.log(why); return false as const; };
  const dir = join(CODE, "cloud");
  const wr = ["bunx", "wrangler"];
  const who = await $`${wr} whoami`.cwd(dir).quiet().nothrow();
  if (!/logged in/i.test(who.stdout.toString())) {
    return fail("先登录你自己的 Cloudflare 账号（免费版即可）：\n  bunx wrangler login\n然后重新运行：hub cloud deploy");
  }
  if (!cfg.server?.token) return fail("缺少 [server] token，先运行 hub init");
  if (!existsSync(join(CODE, "app", "dist", "web", "noop", "index.html"))) console.log("提示：客户端网页还没构建，Worker 只提供接口");
  const name = cfg.cloud?.name ?? "noop";
  console.log(`部署到你的 Cloudflare 账号（Worker：${name}）…`);
  const dep = await $`${wr} deploy --name ${name}`.cwd(dir).quiet().nothrow();
  const out = dep.stdout.toString() + dep.stderr.toString();
  if (dep.exitCode !== 0) return fail(out.slice(-1500));
  const url = out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  const secrets: Record<string, string> = { HUB_TOKEN: cfg.server.token };
  const e = cfg.email ?? {};
  if (e.to && e.host) {
    secrets.HUB_OWNER_EMAIL = String(e.to);
    secrets.HUB_SMTP = JSON.stringify({ host: e.host, port: e.port ?? 465, secure: e.secure ?? (e.port ?? 465) === 465, user: e.user, pass: e.pass, from: e.from ?? e.user });
  } else if (e.to && e.from) { // Cloudflare Email Routing: no SMTP, `from` is an address on a domain with Email Routing on
    secrets.HUB_OWNER_EMAIL = String(e.to);
    secrets.HUB_MAIL_FROM = String(e.from).match(/<([^>]+)>/)?.[1] ?? String(e.from);
  } else console.log("还没配置邮箱：登录验证码发不出去，在共享的 config.toml 里填 [email] 后重新运行 noop cloud deploy");
  const vapid = await vapidKeys();
  secrets.HUB_VAPID_PUBLIC = vapid.publicKey;
  secrets.HUB_VAPID_PRIVATE = JSON.stringify(vapid.privateJwk);
  // `secret bulk` reads JSON from stdin — values never touch argv or the console.
  const sec = Bun.spawn([...wr, "secret", "bulk", "--name", name], { cwd: dir, stdin: new Blob([JSON.stringify(secrets)]), stdout: "pipe", stderr: "pipe" });
  if ((await sec.exited) !== 0) return fail("设置 Worker 密钥失败：\n" + (await new Response(sec.stderr).text()).slice(-800));
  if (!url) return fail("部署成功，但没识别到地址；请把 workers.dev 地址写进 config.toml 的 [cloud] url");
  // ---- record the URL (machine-local noop.toml first: the data sync itself goes through this Worker)
  writeHubToml({ cloud: { url, name } });
  await locked(async () => {
    await _pull();
    const f = P("config.toml");
    let s = readFileSync(f, "utf8");
    s = /^\[cloud\]/m.test(s) ? s.replace(/^\[cloud\][^\[]*/m, `[cloud]\nurl = "${url}"\nname = "${name}"\n\n`) : `${s.trimEnd()}\n\n[cloud]\nurl = "${url}"\nname = "${name}"\n`;
    writeFileSync(f, s);
    writeFileSync(P("README.md"), `# noop data\n\n私有数据（保存在你自己的 Cloudflare Worker 里）：任务、决策、记忆、日志。\n\n## 客户端\n\n地址：**${url}**\n\n打开后粘贴 token 连接（或用邮箱验证码登录；机器 token 在主机的 ~/.noop/noop.toml 里）。这个地址部署在你自己的 Cloudflare 账号里，固定不变。\n`);
    journal(hostName(cfg), `☁️ cloud hub deployed: ${url}`);
    await _commitPush(`cloud hub ${url}`);
  });
  console.log(`✓ 已部署：${url}`);
  return url;
}

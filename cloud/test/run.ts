// Exercises the files API on a live `wrangler dev` harness, then races simulated hosts to claim tasks.
//   bun cloud/test/run.ts http://127.0.0.1:8799
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/$/, "");
const b64 = (s: string) => Buffer.from(s).toString("base64");
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fails++; };
async function api(path: string, body?: unknown) {
  const r = await fetch(BASE + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-actor": "run" } });
  return { status: r.status, json: await r.json() as any };
}
const run = `r${Date.now()}`; // unique prefix: the harness DO persists between runs

// ---- API contract
let r = await api("/api/files/commit", { msg: "seed", changes: [{ path: `${run}/a.md`, base_version: 0, content: b64("A1") }, { path: `${run}/bin`, base_version: 0, content: Buffer.from([0, 255, 1, 254]).toString("base64") }] });
check("commit new files", r.status === 200 && r.json.files.length === 2, JSON.stringify(r.json).slice(0, 120));
const rev0 = r.json.rev;
r = await api("/api/files/commit", { msg: "stale", changes: [{ path: `${run}/new.md`, base_version: 0, content: b64("x") }, { path: `${run}/a.md`, base_version: 0, content: b64("A?") }] });
check("409 on stale base", r.status === 409 && r.json.conflicts?.[0] === `${run}/a.md`);
r = await api(`/api/files/history?path=${run}/new.md`);
check("409 applied nothing", r.json.history.length === 0);
r = await api("/api/files/commit", { msg: "edit", changes: [{ path: `${run}/a.md`, base_version: 1, content: b64("A2") }, { path: `${run}/bin`, base_version: 1, deleted: true }] });
check("CAS edit + delete", r.status === 200 && r.json.files[1].deleted === true);
r = await api(`/api/files/changes?since=${rev0 - 2}`);
const a = r.json.files.find((f: any) => f.path === `${run}/a.md`);
check("changes since", Buffer.from(a.content, "base64").toString() === "A2" && r.json.files.find((f: any) => f.path === `${run}/bin`).deleted);
r = await api(`/api/files/history?path=${run}/a.md&content=1`);
check("history", r.json.history.map((h: any) => h.version).join() === "2,1" && r.json.history[0].by === "run");
r = await api("/api/files/revert", { path: `${run}/a.md`, version: 1 });
check("revert", r.status === 200 && r.json.version === 3);
r = await api("/api/files/revert", { path: `${run}/bin`, version: 1 });
check("revert a delete restores binary", r.status === 200);
r = await api(`/api/files/changes?since=${rev0}`);
check("binary round trip", Buffer.from(r.json.files.find((f: any) => f.path === `${run}/bin`).content, "base64").equals(Buffer.from([0, 255, 1, 254])));
let pages = 0, since = 0, seen = 0;
for (let more = true; more; pages++) { const p = (await api(`/api/files/changes?since=${since}&limit=1`)).json; since = p.rev; more = p.more; seen += p.files.length; }
check("pagination", pages > 1 && seen >= 2, `${pages} pages, ${seen} rows`);
r = await api("/api/files/commit", { msg: "big", changes: [{ path: `${run}/big`, base_version: 0, content: Buffer.alloc(1_600_000).toString("base64") }] });
check("413 over 1.5 MB", r.status === 413, r.json.error);
r = await api("/api/files/commit", { msg: "bad", changes: [{ path: "../etc/passwd", base_version: 0, content: b64("x") }] });
check("400 on traversal", r.status === 400);

// ---- hosts racing to claim the same task (real host code: core.claim over HTTP)
const W = mkdtempSync(join(tmpdir(), "hub-race-"));
const HOSTS = ["h1", "h2", "h3"];
for (const h of HOSTS) { mkdirSync(join(W, h, "data"), { recursive: true }); writeFileSync(join(W, h, "noop.toml"), `[cloud]\nurl = "${BASE}"\n[server]\ntoken = "test"\n`); }
for (let round = 1; round <= 5; round++) {
  const id = `T-${run}-${round}`;
  await api("/api/files/commit", { msg: "task", changes: [{ path: `tasks/inbox/${id}.md`, base_version: 0, content: b64(`---\nid: ${id}\ntitle: race ${round}\n---\nbody\n`) }] });
  const startAt = Date.now() + 1500;
  const procs = HOSTS.map((h) => Bun.spawn(["bun", join(import.meta.dir, "claim-host.ts"), id, String(startAt)], {
    env: { ...process.env, HUB_DATA: join(W, h, "data"), HUB_HOST: h, HUB_SYNC: "", HUB_SYNC_FAKE: "" }, stdout: "pipe", stderr: "pipe" }));
  const out = await Promise.all(procs.map(async (p) => { await p.exited; return JSON.parse((await new Response(p.stdout).text()).trim().split("\n").pop() || "{}"); }));
  const winners = out.filter((o) => o.won).map((o) => o.host);
  const active = (await api(`/api/files/history?path=tasks/active/${id}.md&content=1`)).json.history;
  const claimedBy = active.length ? Buffer.from(active[0].content, "base64").toString().match(/claimed_by: (\S+)/)?.[1] : null;
  const losersSynced = HOSTS.filter((h) => !winners.includes(h)).every((h) => readFileSync(join(W, h, "data", "tasks", "active", `${id}.md`), "utf8").includes(`claimed_by: ${claimedBy}`));
  check(`race ${round}: exactly one winner`, winners.length === 1 && active.length === 1 && claimedBy === winners[0] && losersSynced, `winner ${winners.join(",")}`);
}
rmSync(W, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);

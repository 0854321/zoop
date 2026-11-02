#!/usr/bin/env bun
// hub — CLI + daemon for the agent fleet.
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type Cfg, P, _commitPush, _pull, agentName, chooseCli, claim, commitPush, heartbeat, hostCaps, hostName, journal,
  list, loadConfig, locked, newTask, now, onlineHosts, pickTask, pull, readDoc, remember, writeDoc,
} from "./core";
import { closeDecision, openDecision, overrideJudge, recentJudgeIds, routeDecision } from "./decisions";
import { notify, openDecisionIds, pollReplies } from "./notify";
import { buildPrompt, parseResult, runAgent } from "./runner";
import { allowedParallel, budget, canRunHeavy, ensureDisk, sample } from "./resources";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { init, install, migrateData, selfUpdate } from "./setup";
import { computeMetrics } from "./metrics";
import { collect, LEARN_PROMPT } from "./sessions";
import { medic } from "./medic";
import { githubStarved } from "./github";
import { doctor, visual } from "./visual";
import { drainInbound, onSettingsSaved, startServer } from "./server";
import { cloudDeploy, startCloudBridge } from "./cloud";
import { judgeAccuracy, level, needsApproval, proposeBatch, resolveProposals } from "./autonomy";
import { allowedClis, setApprovalGate, setIdTag } from "./core";
import { accountEnv, accountsStatus, classify, pendingLoginIds, pickAccount, reportFailure, retryLogins, submitLoginCode } from "./accounts";

// ------------------------------------------------------------------ routines (scheduled task generators)
const STATE = P("logs", "routine-state.json");

/** every: "15m" | "hourly" | "daily HH:MM" | "weekdays HH:MM" | "weekly MON HH:MM" */
export function due(every: string, last: string | undefined, t = new Date()): boolean {
  const parts = every.trim().split(/\s+/);
  const lastT = last ? new Date(last) : null;
  if (parts[0] === "hourly" || /^\d+m$/.test(parts[0])) {
    const mins = parts[0] === "hourly" ? 60 : parseInt(parts[0]);
    return !lastT || +t - +lastT >= mins * 60_000;
  }
  const [h, m] = parts.at(-1)!.split(":").map(Number);
  const target = new Date(t); target.setHours(h, m, 0, 0);
  if (t < target) return false;
  const dow = t.getDay();
  if (parts[0] === "weekdays" && (dow === 0 || dow === 6)) return false;
  if (parts[0] === "weekly" && ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][dow] !== parts[1].toUpperCase().slice(0, 3)) return false;
  if (!lastT) return +t - +target < 60 * 60_000; // first run ever: only fire near the scheduled time
  return lastT < target;
}

function runRoutines(cfg: Cfg, host: string, primary: boolean) {
  const state: Record<string, string> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  maybeProposeNext(cfg, host, state);
  for (const r of cfg.routine ?? []) {
    if (r.enabled === false) continue;
    const owner = r.scheduler ?? (r.kind === "learn" ? "each" : "primary"); // which host generates the task
    if (owner === "primary" ? !primary : owner !== "each" && owner !== host) continue;
    if (!due(r.every, state[r.name])) continue;
    if (r.kind === "learn") { // local session history → digest → task pinned to this host
      state[r.name] = new Date().toISOString();
      const d = collect(cfg);
      if (!d.file) { journal(host, `📚 learn: no new sessions`); continue; }
      const id = newTask(`learn the CEO · ${host} · ${d.sessions} sessions`, LEARN_PROMPT(d.file),
        { agent: "apprentice", host, source: `routine:learn`, priority: "normal" });
      journal(host, `📚 learn: ${d.turns} owner turns from ${d.sessions} sessions → ${id}`);
      continue;
    }
    if (r.agent === "architect") computeMetrics(r.name === "evolve-deep" ? 30 : 7);
    const id = newTask(`${r.name} · ${new Date().toLocaleString("sv-SE").slice(0, 16)}`, r.prompt, {
      agent: r.agent, cli: r.cli, requires: r.requires, prefer: r.prefer, weight: r.weight, repo: r.repo, priority: r.priority, source: `routine:${r.name}`,
    });
    state[r.name] = new Date().toISOString();
    journal(host, `⏰ routine \`${r.name}\` → ${id} (${r.agent})`);
  }
  mkdirSync(P("logs"), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

// ------------------------------------------------------------------ task processing
const pendingRoute: string[] = []; // decisions opened by workers, routed by the next tick
async function processTask(path: string, cfg: Cfg, host: string) {
  const { meta, body } = readDoc(path);
  const wanted = allowedClis(meta, cfg);
  const acct = pickAccount(cfg, wanted.filter((c: string) => Bun.which(c)));
  const agent = meta.agent || "lead";
  if (!acct) { // no usable account right now → put it back, don't fail it
    await locked(async () => {
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined }, body);
      if (existsSync(path)) unlinkSync(path);
      await _commitPush(`[${host}] requeue ${meta.id} (no AI account available)`);
    });
    return;
  }
  const cli = acct.cli;
  await locked(async () => { journal(host, `▶ ${meta.id} ${agentName(agent)}/${cli}: ${meta.title}`); await _commitPush(`[${host}] start ${meta.id}`); });

  const log = P("logs", "runs", `${meta.id}-${Date.now()}-${cli}.log`);
  const gh = await githubStarved(cfg);
  const b = budget(sample(cfg), running, meta.weight === "heavy");
  b.note += gh.note ? `\n${gh.note}` : "";
  const out = await runAgent(cli, buildPrompt(meta, body, cfg, b.note), meta.repo || P(), cfg, log, !!meta.gate_override,
    { ...b.env, ...accountEnv(acct) });
  const res = parseResult(out);
  const failure = res.status === "failed" ? classify(out) : null;
  if (failure) { // quota / auth problem is not the task's fault → rotate account, requeue
    await reportFailure(acct, failure, out, cfg);
    await locked(async () => {
      await _pull();
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, retried_after: failure }, body);
      if (existsSync(path)) unlinkSync(path);
      journal(host, `↻ ${meta.id} requeued (${cli}/${acct.name}: ${failure})`);
      await _commitPush(`[${host}] requeue ${meta.id} (${failure})`);
    });
    return;
  }
  await locked(async () => {
  await _pull();

  remember(agent, res.lessons, meta.id);
  const depth = Number(meta.depth ?? 0) + 1;
  const maxDepth = cfg.fleet?.max_followup_depth ?? 4;
  const ownerWork = meta.origin === "owner" || /^owner/.test(meta.source ?? "");
  const delegated = res.status === "delegated" && (res.followups?.length ?? 0) > 0;
  const children: string[] = [];
  for (const f of (res.followups ?? []).slice(0, depth > maxDepth ? 0 : 8)) {
    const id = newTask(f.title, f.body ?? "", { agent: f.agent ?? agent, priority: f.priority ?? meta.priority, repo: f.repo,
      source: `followup:${meta.id}`, extra: { depth: String(depth), ...((f as any).difficulty === "hard" ? { difficulty: "hard" } : {}), ...(ownerWork ? { origin: "owner" } : {}), ...(delegated ? { parent: meta.id } : {}) } });
    children.push(id);
    journal(host, `  ↳ ${id} → ${f.agent ?? agent}: ${f.title}`);
  }
  const done = { ...meta, cli_used: cli, finished: now(), status: res.status, gate_override: undefined };
  const runNote = `\n\n## Run ${now()} · ${host} · ${cli}\n**${res.status}** — ${res.summary}\n`;
  if (existsSync(path)) unlinkSync(path);

  if (delegated && children.length) { // wait for children, then wake up to consolidate
    writeDoc(P("tasks", "waiting", `${meta.id}.md`), { ...done, children: children.join(",") }, body + runNote);
    journal(host, `🧩 ${meta.id} delegated to ${children.join(", ")}`);
  } else if (res.status === "needs_decision") {
    const did = openDecision(meta, res, host);
    writeDoc(P("tasks", "blocked", `${meta.id}.md`), { ...done, decision: did }, body + runNote);
    journal(host, `⏸ ${meta.id} → ${did}: ${res.question}`);
    pendingRoute.push(did);
  } else {
    const folder = res.status === "done" ? "done" : "failed";
    writeDoc(P("tasks", folder, `${meta.id}.md`), done, body + runNote);
    journal(host, `${res.status === "done" ? "✅" : "❌"} ${meta.id} ${res.summary}`);
    // the owner asked for this (and it is not an internal sub-step) → bring back the result
    if (res.status === "done" && ownerWork && !meta.parent)
      void notify(`✅ ${meta.title}\n${res.summary}`, cfg, { kind: "notice", ref: meta.id, attachments: res.attachments, from: `${agentName(agent)}@${host}` });
    if (res.status !== "done") void handleFailure(meta, body, res.summary, out, cfg, host);
  }
  await _commitPush(`[${host}] ${res.status} ${meta.id}: ${meta.title}`);
  });
}

async function handleReplies(cfg: Cfg, host: string) {
  const open = openDecisionIds();
  const judged = recentJudgeIds();
  const replies = [...drainInbound(), ...await pollReplies(cfg, new Set([...open, ...judged, ...pendingLoginIds()]))];
  for (const r of replies) {
    if (r.id.startsWith("P-")) {
      if (resolveProposals(r.id, r.answer, `owner(${r.source})`)) {
        journal(host, `🗂 ${r.id} owner approved: ${r.answer}`);
        await notify(`👌 ${r.id} 已按你的选择排队`, cfg);
      }
      continue;
    }
    if (r.id.startsWith("L-")) {
      if (submitLoginCode(r.id, r.answer)) journal(host, `🔑 ${r.id} login code received via ${r.source}`);
      continue;
    }
    if (open.has(r.id)) {
      closeDecision(r.id, r.answer, `owner(${r.source})`);
      journal(host, `✔ ${r.id} owner answered via ${r.source}: ${r.answer}`);
      await notify(`👌 收到 ${r.id}：${r.answer} — 任务已重新排队`, cfg);
    } else if (/^override\b/i.test(r.answer) && overrideJudge(r.id, r.answer.replace(/^override[\s:：]*/i, ""), r.source, host)) {
      await notify(`🔁 已记录你对 ${r.id} 的纠正，judge 以后会参考；已创建重做任务`, cfg);
    }
  }
}

/** Requeue tasks whose claiming host went silent (crash, sleep, network loss). */
function reapStale(cfg: Cfg, host: string, ownOnly = false) {
  const alive = new Set(onlineHosts(cfg).map((h) => h.host));
  const graceMs = (cfg.fleet?.reap_after_minutes ?? 20) * 60_000;
  for (const p of list(P("tasks", "active"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    // own tasks not run by this process were orphaned by a crash/restart (we're alive, so no one else reaps them)
    if (meta.claimed_by === host ? runningIds.has(meta.id) : ownOnly || alive.has(meta.claimed_by)) continue;
    if (Date.now() - Date.parse(meta.started) < graceMs) continue;
    writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, requeued: now() },
      `${body}\n\n> Requeued: host ${meta.claimed_by} went offline mid-task. Check for partial work (branch agent/${meta.id}-*).\n`);
    require("node:fs").unlinkSync(p);
    journal(host, `♻️ requeued ${meta.id} (host ${meta.claimed_by} offline)`);
  }
}

/** Tasks whose hard requirements no online host satisfies: note once, never block the queue. */
function noteUnservable(cfg: Cfg, host: string) {
  const hosts = onlineHosts(cfg);
  for (const p of list(P("tasks", "inbox"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    const reqs = (meta.requires ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!reqs.length || meta.parked) continue;
    if (!hosts.some((h) => reqs.every((r) => h.caps.includes(r)))) {
      writeDoc(p, { ...meta, parked: now() }, body);
      journal(host, `🅿️ ${meta.id} parked until a host with ${reqs.join("+")} comes online`);
    }
  }
  for (const p of list(P("tasks", "inbox"), /^T-.*\.md$/)) { // unpark when capable host returns
    const { meta, body } = readDoc(p);
    const reqs = (meta.requires ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (meta.parked && hosts.some((h) => reqs.every((r) => h.caps.includes(r)))) writeDoc(p, { ...meta, parked: undefined }, body);
  }
}

let running = 0;

/** A good report doesn't forward raw errors. Retry, call the medic for tooling problems, and only after that
 *  tell the owner — in one plain sentence, and only for work the owner actually cares about. */
async function handleFailure(meta: Record<string, string>, body: string, summary: string, out: string, cfg: Cfg, host: string) {
  const attempt = Number(meta.attempt ?? 1);
  const tooling = /unexpected argument|command not found|No such file|ENOENT|usage:|panicked|exit 12[67]|not logged in|SyntaxError/i.test(out.slice(-3000));
  if (tooling) void medic(`Agent run for ${meta.id} failed because of a tooling problem on ${host} (not the task itself):\n${out.slice(-2500)}`,
    cfg, { auto: true, kind: `tool-${meta.cli_used ?? "agent"}` });
  if (attempt < (cfg.fleet?.max_attempts ?? 2)) {
    await locked(async () => {
      await _pull();
      const f = P("tasks", "failed", `${meta.id}.md`);
      if (existsSync(f)) unlinkSync(f);
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, status: undefined, attempt: String(attempt + 1) },
        `${body}\n\n> Attempt ${attempt} failed: ${summary.slice(0, 300)}. Try a different approach.\n`);
      journal(host, `↻ ${meta.id} retry ${attempt + 1} (${tooling ? "tooling issue → medic" : "task failure"})`);
      await _commitPush(`[${host}] retry ${meta.id}`);
    });
    return;
  }
  const ownerCares = meta.origin === "owner" || /^owner/.test(meta.source ?? "") || meta.priority === "urgent";
  if (!ownerCares || cfg.notify?.on_failure === false) return; // routine/internal work: journal only; architect reviews failures
  const reason = summary.split("\n")[0].replace(/\s+/g, " ").slice(0, 140);
  await notify(`没能完成「${meta.title}」：${reason}。我会在日报里跟进；需要换个做法可以直接告诉我。`, cfg,
    { kind: "notice", ref: meta.id, from: `${agentName(meta.agent || "lead")}@${host}` });
}
const GH_HEAVY = new Set(["dispatcher", "reviewer", "ops-watcher", "oss-triage", "release-manager"]);

/** Parent tasks waiting on delegated children: when every child is finished, requeue the parent to consolidate. */
function wakeParents(host: string) {
  for (const p of list(P("tasks", "waiting"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    const kids = (meta.children ?? "").split(",").filter(Boolean);
    const where = (id: string) => ["done", "failed", "rejected"].find((f) => existsSync(P("tasks", f, `${id}.md`)));
    if (!kids.every(where)) continue;
    const results = kids.map((id) => {
      const f = where(id)!;
      const k = readDoc(P("tasks", f, `${id}.md`));
      const last = k.body.split("## Run ").pop() ?? "";
      return `### ${id} [${k.meta.agent}] ${k.meta.title} — ${f}\n${last.slice(-1500)}`;
    }).join("\n\n");
    writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, children: undefined, status: undefined, claimed_by: undefined, consolidating: "yes", priority: "high" },
      `${body}\n\n## Results from delegated subtasks\n${results}\n\nConsolidate these into the final outcome for the owner: return "done" with a crisp result summary (+attachments), or "needs_decision" with options if the owner must choose. Do not delegate again unless something essential is missing.\n`);
    unlinkSync(p);
    journal(host, `🧩 ${meta.id} subtasks finished → consolidating`);
  }
}
const runningIds = new Set<string>();

// ------------------------------------------------------------------ idle → ask owner with a concrete menu
const inQuietHours = (cfg: Cfg) => {
  const q = cfg.idle?.quiet_hours as string | undefined; // "23:00-08:30"
  if (!q) return false;
  const [a, b] = q.split("-");
  const cur = new Date().toTimeString().slice(0, 5);
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
};

function maybeProposeNext(cfg: Cfg, host: string, state: Record<string, string>) {
  if (cfg.idle?.enabled === false || inQuietHours(cfg)) return;
  const busy = ["inbox", "active"].some((f) => list(P("tasks", f), /^T-.*\.md$/)
    .some((p) => !readDoc(p).meta.parked));
  if (busy || running > 0) { delete state.idle_since; return; }
  state.idle_since ??= new Date().toISOString();
  const idleMin = (Date.now() - Date.parse(state.idle_since)) / 60_000;
  if (idleMin < (cfg.idle?.after_minutes ?? 20)) return;
  // one menu at a time; re-offer after cooldown even if unanswered
  const pendingMenu = list(P("decisions", "open")).map((p) => readDoc(p).meta).find((m) => m.kind === "menu");
  const cooldown = (cfg.idle?.cooldown_minutes ?? 180) * 60_000;
  if (pendingMenu && Date.now() - Date.parse(pendingMenu.created) < cooldown) return;
  if (state.last_menu && Date.now() - Date.parse(state.last_menu) < 15 * 60_000) return;
  const id = newTask("Propose next actions (fleet idle)", `The fleet has been idle for ${Math.round(idleMin)} minutes.
Build the owner's next-action menu per your profile and return needs_decision.${pendingMenu ? `\nAn earlier menu ${pendingMenu.id} is still unanswered — refresh it (drop stale items) rather than repeating it verbatim.` : ""}`,
    { agent: "chief-of-staff", priority: "high", source: "idle", extra: { kind: "menu" } });
  state.last_menu = new Date().toISOString();
  journal(host, `💤 fleet idle ${Math.round(idleMin)}m → ${id} chief-of-staff drafting a next-steps menu`);
}

export async function tick(cfg: Cfg, background = false) {
  const host = hostName(cfg);
  const primary = (cfg.fleet?.primary ?? host) === host;
  await locked(async () => {
    await _pull();
    heartbeat(cfg, running, sample(cfg));
    if (primary) {
      runRoutines(cfg, host, primary);
      reapStale(cfg, host);
      wakeParents(host);
      await proposeBatch(cfg, host);
      noteUnservable(cfg, host);
    } else reapStale(cfg, host, true);
    await _commitPush(`[${host}] tick`);
  });
  await retryLogins(cfg);
  if (primary || pendingLoginIds().size) await handleReplies(cfg, host);
  if (primary) {
    const toRoute = [...pendingRoute.splice(0), ...list(P("decisions", "open")).map((p) => readDoc(p).meta)
      .filter((m) => !m.held && m.kind !== "proposals").map((m) => m.id)];
    for (const id of new Set(toRoute)) {
      if (!require("node:fs").existsSync(P("decisions", "open", `${id}.md`))) continue;
      await locked(async () => { await _pull(); await routeDecision(id, cfg, host); await _commitPush(`[${host}] route ${id}`); });
    }
  }
  // resource governor: disk first, then adaptive parallelism
  const busyRepos = new Set(list(P("tasks", "active"), /^T-.*\.md$/).map((p) => readDoc(p).meta)
    .filter((m) => m.claimed_by === host && m.repo).map((m) => resolve(m.repo.replace(/^~/, homedir()))));
  await ensureDisk(cfg, host, busyRepos, (t) => notify(t, cfg));
  const jobs: Promise<void>[] = [];
  const tried = new Set<string>();
  for (;;) {
    const s = sample(cfg);
    const max = allowedParallel(s, cfg, running);
    if (running >= max) break;
    if (!pickAccount(cfg, ["claude", "codex"].filter((c) => Bun.which(c)))) break;
    if ((await githubStarved(cfg)).starved && list(P("tasks", "inbox"), /^T-.*\.md$/).every((p) => GH_HEAVY.has(readDoc(p).meta.agent))) break;
    const t = pickTask(cfg, s.loadRatio, canRunHeavy(s, cfg, running));
    if (!t) break;
    const active = await claim(t, host);
    if (!active) { if (tried.has(t)) break; tried.add(t); continue; } // e.g. offline: don't spin on the same task
    running++;
    const tid = readDoc(active).meta.id;
    runningIds.add(tid);
    const job = processTask(active, cfg, host)
      .catch((e) => { console.error(e); journal(host, `💥 worker crashed on ${active}: ${e}`); })
      .finally(() => { running--; runningIds.delete(tid); });
    jobs.push(job);
  }
  if (!background) await Promise.all(jobs);
}

async function daemon(cfg: Cfg) {
  const host = hostName(cfg);
  const every = (cfg.host?.tick_seconds ?? 60) * 1000;
  console.log(`hub daemon on ${host} caps=${hostCaps(cfg).join(",")} tick=${every / 1000}s parallel≤${cfg.host?.max_parallel ?? "cores/3"}`);
  onSettingsSaved((summary) => locked(async () => {
    await _pull();
    journal(host, `⚙️ owner changed settings: ${summary}`);
    await _commitPush(`[${host}] settings: ${summary.slice(0, 60)}`);
  }));
  if ((cfg.fleet?.primary ?? host) === host) startCloudBridge(cfg);
  if ((cfg.fleet?.primary ?? host) === host) startServer(cfg, (text) => locked(async () => {
    await _pull();
    const id = newTask(text.split("\n")[0].slice(0, 80), `The owner (CEO) said in chat:\n\n> ${text.replace(/\n/g, "\n> ")}\n\nHandle it like a capable chief of staff (see your profile: "Owner requests").`,
      { agent: "lead", source: "owner@chat", priority: "high", extra: { origin: "owner" } });
    journal(host, `💬 ${id} from owner chat: ${text.slice(0, 80)}`);
    await _commitPush(`[${host}] chat ${id}`);
    return id;
  }));
  await locked(async () => { // recover tasks this host was running when it died/restarted
    await _pull();
    for (const p of list(P("tasks", "active"), /^T-.*\.md$/)) {
      const { meta, body } = readDoc(p);
      if (meta.claimed_by !== host) continue;
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, requeued: now() },
        `${body}\n\n> Requeued after daemon restart on ${host}; check for partial work.\n`);
      require("node:fs").unlinkSync(p);
      journal(host, `♻️ requeued ${meta.id} after restart`);
    }
    await _commitPush(`[${host}] recover`);
  });
  await locked(async () => { await _pull(); journal(host, `🟢 daemon started (${hostCaps(cfg).join(", ")})`); await _commitPush(`[${host}] up`); });
  let lastUpdate = 0, failures = 0;
  for (;;) {
    const c = loadConfig();
    try { await tick(c, true); failures = 0; } catch (e) {
      console.error("tick failed", e);
      if (++failures >= 3) void medic(`noop daemon: ${failures} consecutive tick failures on ${host}.\n${(e as Error)?.stack ?? e}`, c, { auto: true, kind: "daemon" });
    }
    if (Date.now() - lastUpdate > (c.update?.check_minutes ?? 30) * 60_000) {
      lastUpdate = Date.now();
      if (await selfUpdate().catch(() => false)) {
        journal(host, "⬆️ framework self-updated; restarting when workers finish");
        while (running > 0) await Bun.sleep(5000);
        await commitPush(`[${host}] self-update`);
        process.exit(0); // service manager restarts us on the new code
      }
    }
    await Bun.sleep(every);
  }
}

function status(cfg: Cfg, brief = false) {
  if (brief) { // what a person wants to see right after installing
    const url = cfg.cloud?.url;
    const hosts = onlineHosts(cfg).map((h) => h.host);
    console.log(`  ✓ ${hostName(cfg)} is part of your team${hosts.length > 1 ? ` (${hosts.length} machines online)` : ""}`);
    if (url) console.log(`\n  Open ${url}\n  and sign in with the code sent to your email.`);
    return;
  }
  console.log(`autonomy: ${level(cfg)}   shadow judge: ${JSON.stringify(judgeAccuracy())}`);
  console.log(`host ${hostName(cfg)}  caps: ${hostCaps(cfg).join(", ")}  primary: ${cfg.fleet?.primary}`);
  console.log("online: " + onlineHosts(cfg).map((h) => `${h.host}(busy ${h.busy}, load ${h.stats?.loadRatio}, disk ${h.stats?.diskFreeGB}GB)`).join(", "));
  const s = sample(cfg);
  console.log("accounts:\n  " + accountsStatus(cfg).join("\n  "));
  console.log(`this host: load ${s.load1}/${s.cores}  mem free ${s.memFreePct}%  disk free ${s.diskFreeGB}GB  → parallel ${allowedParallel(s, cfg, 0)}`);
  for (const f of ["proposed", "inbox", "active", "blocked", "failed", "done"]) {
    const items = list(P("tasks", f), /^T-.*\.md$/);
    console.log(`\n${f.padEnd(8)} ${items.length}`);
    if (f !== "done") for (const p of items.slice(-12)) {
      const m = readDoc(p).meta;
      console.log(`  ${m.id} [${m.agent}] ${m.title}${m.claimed_by ? ` @${m.claimed_by}` : ""}${m.requires ? ` (needs ${m.requires})` : ""}`);
    }
  }
  console.log("\nopen decisions");
  for (const p of list(P("decisions", "open"))) {
    const m = readDoc(p).meta;
    console.log(`  ${m.id} (${m.task}, ${m.agent}) ${m.question}  rec=${m.recommendation}${m.held ? "  [waiting on you]" : ""}`);
  }
}

const HELP = `noop — your own AI team

  noop init                   primary: deploy your own Cloudflare Worker (holds the fleet data), seed ~/.noop/data
  noop init --worker <hub-url> [--token <machine-token>]   join a hub (owner email login, or a machine token)
  noop migrate-data           one-time: upload the old git data repo to your Worker, retire its .git
  noop install                run as a service (systemd / launchd / Task Scheduler)
  noop update                 self-update framework now (also automatic in daemon)
  noop fix ["what is wrong"]  AI medic: diagnose & repair this install (auto-runs on install/update/daemon failures)
  noop doctor                 check dependencies (agents, gh, headless GUI tools)
  noop visual …               headless display for GUI testing: start/run/shot/record/input/stop

  noop daemon                 run forever (tick every host.tick_seconds)
  noop tick                   one cycle: pull → routines → replies → judge → run tasks → push
  noop add "title" [-b body] [-a agent] [-r os:linux (hard)] [--prefer os:macos (soft)] [-w heavy] [--host name] [--repo ~/work/x] [-p high] [--cli claude|codex]
  noop decide D-0001 "A"      answer a decision from the terminal
  noop status                 queue / decision / accounts / resources overview
  noop learn [--full] [--dry]  learn the CEO from local Claude/Codex sessions (digest stays local; principles go to memory)
  noop metrics [days]         per-agent success, judge vs owner decisions (feeds self-evolution)
  noop agents                 list fleet members
  noop notify "text"          test Slack/Discord
`;

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const cfg = loadConfig();
  setApprovalGate((src) => needsApproval(loadConfig(), src));
  { const h = hostName(cfg);
    if ((cfg.fleet?.primary ?? h) !== h) setIdTag(String(cfg.host?.id_tag ?? (h.replace(/[^a-z]/gi, "").charAt(0) || "W")).toUpperCase()); }
  const host = hostName(cfg);
  switch (cmd) {
    case "init": {
      const { values } = parseArgs({ args: rest, options: { worker: { type: "string" }, token: { type: "string" } } });
      return init(values);
    }
    case "migrate-data": return migrateData();
    case "install": return install();
    case "visual": return visual(rest);
    case "doctor": return doctor();
    case "fix": {
      const what = rest.join(" ") || "Run a health check (hub doctor, hub status, service logs, bun test) and fix whatever is broken.";
      const r = await medic(what, cfg, { kind: "manual" });
      if (!r?.fixed) process.exitCode = 1;
      return;
    }
    case "update": return void console.log((await selfUpdate()) ? "updated" : "up to date");
    case "daemon": return daemon(cfg);
    case "tick": return tick(cfg);
    case "add": {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: {
          body: { type: "string", short: "b" }, agent: { type: "string", short: "a" }, requires: { type: "string", short: "r" }, prefer: { type: "string" }, weight: { type: "string", short: "w" },
          host: { type: "string" }, repo: { type: "string" }, priority: { type: "string", short: "p" }, cli: { type: "string" },
        },
      });
      await pull();
      const id = newTask(positionals.join(" "), values.body ?? "", { ...values, source: `owner@${host}` });
      journal(host, `＋ ${id} by owner: ${positionals.join(" ")}`);
      await commitPush(`[${host}] add ${id}`);
      return console.log(id);
    }
    case "decide": {
      const [id, ...ans] = rest;
      await pull();
      if (id.startsWith("P-")) { if (!resolveProposals(id, ans.join(" "), `owner(cli@${host})`)) process.exit(1); journal(host, `🗂 ${id} owner approved via cli: ${ans.join(" ")}`); await commitPush(`[${host}] approve ${id}`); return; }
      if (!closeDecision(id, ans.join(" "), `owner(cli@${host})`)) {
        if (!overrideJudge(id, ans.join(" "), `cli@${host}`, host)) { console.error("no such open decision"); process.exit(1); }
      } else journal(host, `✔ ${id} owner answered via cli: ${ans.join(" ")}`);
      await commitPush(`[${host}] decide ${id}`);
      return;
    }
    case "status": return status(cfg, rest.includes("--brief"));
    case "learn": {
      const d = collect(cfg, { full: rest.includes("--full") });
      if (!d.file) return void console.log(`no new sessions (${d.sessions})`);
      console.log(`${d.turns} owner turns from ${d.sessions} sessions → ${d.file}`);
      if (rest.includes("--dry")) return;
      await pull();
      const id = newTask(`learn the CEO · ${host} · ${d.sessions} sessions`, LEARN_PROMPT(d.file), { agent: "apprentice", host, source: `owner@${host}`, priority: "high" });
      journal(host, `📚 ${id} learn from ${d.sessions} local sessions (owner-triggered)`);
      await commitPush(`[${host}] learn ${id}`);
      return console.log(id);
    }
    case "metrics": return void console.log(JSON.stringify(computeMetrics(Number(rest[0] ?? 7)), null, 2));
    case "agents":
      for (const p of list(P("agents"), /.*/)) {
        const prof = P("agents", p.split("/").pop()!, "profile.md");
        if (existsSync(prof)) console.log(`${p.split("/").pop()!.padEnd(16)} ${readFileSync(prof, "utf8").split("\n")[0].replace(/^# /, "")}`);
      }
      return;
    case "cloud": {
      if (rest[0] !== "deploy") return void console.log("usage: hub cloud deploy");
      return void (await cloudDeploy(cfg));
    }
    case "notify": return void console.log(await notify(rest.join(" "), cfg));
    default: console.log(HELP);
  }
}

if (import.meta.main) {
  try { await main(); } catch (e) {
    const cmd = Bun.argv[2] ?? "";
    console.error(e);
    if (["init", "install", "update", "tick", "learn"].includes(cmd) && !process.env.HUB_NO_MEDIC) {
      await medic(`\`hub ${Bun.argv.slice(2).join(" ")}\` failed:\n${(e as Error)?.stack ?? e}`, loadConfig(), { auto: true, kind: `cmd-${cmd}` });
    }
    process.exit(1);
  }
}

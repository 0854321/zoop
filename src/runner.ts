// Builds the prompt for an agent, runs Claude Code / Codex headless, parses the structured result.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  type Cfg, P, ROOT, agentName, precedents, readAll, readIf, recentJournal, signature,
} from "./core";
import { claudeDisallowed } from "./gates";

export type Result = {
  status: "done" | "needs_decision" | "failed" | "delegated" | "waiting";
  wait_minutes?: number;
  waiting_on?: string;
  summary: string;
  question?: string;
  options?: string[];
  recommendation?: string;
  lessons?: string[];
  attachments?: string[];
  followups?: { title: string; body?: string; agent?: string; priority?: string; repo?: string }[];
};

const RESULT_SPEC = `Finish the work, then end your final reply with EXACTLY one fenced \`\`\`json block:
{
  "status": "done" | "needs_decision" | "failed" | "delegated" | "waiting",   // delegated = you split the work into followups and want to be woken up to consolidate when they finish; waiting = see below
  "waiting_on": "waiting only: what you wait for and how to check it, e.g. CI run https://github.com/o/r/actions/runs/123 (gh run view 123)",
  "wait_minutes": 15,   // waiting only: when to wake you to check again (5-120)
  "summary": "1-3 sentences: what you did / found (links to PRs, commits, files)",
  "question": "needs_decision only: one short sentence (under 30 characters) naming what to decide, e.g. 现在合并 gpui-fast #97 吗？",
  "options": ["A: <recommended> — consequence", "B: ... — consequence"],
  "recommendation": "A",
  "lessons": ["durable lesson for your own memory (optional)"],
  "attachments": ["/abs/path/screenshot.png", "/abs/path/recording.mp4"],   // optional: shown to the owner with the message
  "followups": [{"title": "...", "body": "...", "agent": "<agent id>", "priority": "normal", "difficulty": "hard if it needs deep engineering/design work"}]
}
Write summary, question and options in the owner's language (Simplified Chinese unless the owner writes otherwise), plain text, no emoji; keep identifiers, links and code as they are.
Only use needs_decision after doing all preparation that does not depend on the answer.
Never sit idle waiting on something slow (GitHub Actions/CI, a release, a review, a deploy): if the next step needs it, return "waiting" with waiting_on and wait_minutes.
The machine then runs other work and wakes you later with your notes; check the condition first, then continue from where you left off.`;

export function buildPrompt(meta: Record<string, string>, body: string, cfg: Cfg, resourceNote = ""): string {
  const agent = meta.agent || "lead";
  const host = meta.claimed_by || "?";
  return `You are **${agentName(agent)}**, a permanent member of ${cfg.owner?.name ?? "the owner"}'s AI agent fleet, running headless on host \`${host}\`.
The fleet coordinates through the shared hub repository at ${ROOT} (tasks/, journal/, decisions/, agents/). Read it when you need context; you do not message other agents — you leave traces (commits, journal lines, follow-up tasks) that they pick up.

# Your profile
${readIf(P("agents", agent, "profile.md"))}

# Your memory
${readIf(P("agents", agent, "memory.md"), 8000) || "(empty)"}

# Fleet-wide policy
${readAll(P("policies"))}

# Owner profile & principles
${readAll(P("memory"))}

# Owner decision precedents (follow them; never re-ask a decided question)
${precedents(25) || "(none yet)"}

# Recent fleet journal
${recentJournal() || "(empty)"}

# Fleet roster (for follow-up routing)
${rosterLine()}

# External signature (MANDATORY)
Anything you post outside the hub — GitHub PR/issue/review comments, PR descriptions, Slack, Discord, email, OKR entries — must end with:
${signature(agent, host, cfg)}
Git commits you create must carry the trailer:  Agent: ${agent}

# Resource budget
${resourceNote}

# Task ${meta.id}: ${meta.title}
Working directory: ${meta.repo || ROOT}   Host capabilities: ${meta.host_caps ?? ""}
Priority: ${meta.priority}   Source: ${meta.source}

${body}

${RESULT_SPEC}`;
}

function rosterLine(): string {
  return readdirSync(P("agents"), { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => {
      const prof = readIf(P("agents", d.name, "profile.md"), 100000);
      const first = prof.split("\n").find((l) => l.startsWith("# ")) ?? d.name;
      return `- \`${d.name}\` ${agentName(d.name)}: ${first.replace(/^# /, "")}`;
    }).join("\n");
}

export function cliCommand(cli: string, cfg: Cfg, gateOverride = false): string[] {
  const c = cfg.clis?.[cli] ?? {};
  if (Array.isArray(c.command)) return c.command;
  if (cli === "claude") {
    const cmd = ["claude", "-p", "--output-format", "text", "--permission-mode", c.permission_mode ?? "bypassPermissions"];
    cmd.push("--model", c.model ?? "claude-opus-5-5");
    // the agent signature is the only attribution; drop Claude Code's own "Generated with" / co-author lines
    cmd.push("--settings", JSON.stringify({ attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false }));
    const deny = claudeDisallowed(cfg, gateOverride);
    if (deny.length) cmd.push("--disallowedTools", ...deny);
    return cmd;
  }
  if (cli === "codex") {
    // non-interactive: workspace-write sandbox with network, never ask for approval
    const cmd = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write",
      "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true"];
    if (c.model) cmd.push("-m", c.model);
    return [...cmd, "-"];
  }
  throw new Error(`unknown cli ${cli}`);
}

/** Running agent processes by task id (so the owner can cancel one). */
export const agentProcs = new Map<string, { kill: (sig?: number | NodeJS.Signals) => void }>();

export async function runAgent(cli: string, prompt: string, cwd: string, cfg: Cfg, logFile: string, gateOverride = false,
  extraEnv: Record<string, string> = {}): Promise<string> {
  const cmd = cliCommand(cli, cfg, gateOverride);
  const timeoutMs = (cfg.clis?.timeout_minutes ?? 60) * 60_000;
  const dir = cwd.replace(/^~/, homedir());
  const proc = Bun.spawn(cmd, {
    cwd: existsSync(dir) ? dir : ROOT, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...extraEnv, HUB_DATA: ROOT },
  });
  const tid = logFile.split("/").pop()!.match(/^([A-Z]-[\w]*?\d{4})-\d{10,}/)?.[1];
  if (tid) agentProcs.set(tid, proc);
  void proc.exited.then(() => { if (tid && agentProcs.get(tid) === proc) agentProcs.delete(tid); });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  mkdirSync(P("logs", "runs"), { recursive: true });
  writeFileSync(logFile, `$ ${cmd.join(" ")}\n(exit ${code})\n\n${out}\n\n[stderr]\n${err}`);
  return out + (code ? `\n[exit ${code}] ${err.slice(-2000)}` : "");
}

export function parseResult(out: string): Result {
  const blocks = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]).reverse();
  for (const b of blocks) {
    try {
      const r = JSON.parse(b);
      if (r.status) return r;
    } catch {}
  }
  return { status: "failed", summary: `agent returned no result block. tail: ${out.slice(-300)}` };
}

/** One-shot structured call (used by the judge). */
export async function ask(prompt: string, cfg: Cfg, logFile: string): Promise<any> {
  const cli = cfg.judge?.cli ?? "claude";
  const cmd = cli === "claude"
    ? ["claude", "-p", "--output-format", "text", "--model", cfg.judge?.model ?? "claude-opus-5-5", "--tools", ""]
    : ["codex", "exec", "--skip-git-repo-check", "-"];
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), (cfg.judge?.timeout_minutes ?? 10) * 60_000); // runs inside locked()
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  mkdirSync(P("logs", "runs"), { recursive: true });
  writeFileSync(logFile, out);
  const m = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].pop() ?? out.match(/(\{[\s\S]*\})/);
  try { return JSON.parse(m![1]); } catch { return null; }
}

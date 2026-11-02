// Graduated autonomy. Start conservative ("onboarding"): self-generated work needs owner approval,
// the judge only shadows. Graduation is proposed by the architect from metrics, decided by the owner.
import { existsSync, unlinkSync } from "node:fs";
import { type Cfg, P, journal, list, nextId, now, readDoc, writeDoc } from "./core";
import { notify } from "./notify";

export type Level = "onboarding" | "assisted" | "autonomous";
/** Global level, optionally overridden per agent ([autonomy.agents] reviewer = "assisted") as trust is earned. */
export const level = (cfg: Cfg, agent?: string): Level =>
  (agent && cfg.autonomy?.agents?.[agent]) || cfg.autonomy?.level || "onboarding";

/** Should a task from this source wait for owner approval? Owner-created & approved work never does. */
export function needsApproval(cfg: Cfg, source: string): boolean {
  if (/^owner|^override|^approved|^decision/.test(source)) return false;
  const l = level(cfg);
  if (l === "autonomous") return false;
  if (l === "assisted") return /^followup/.test(source) && cfg.autonomy?.assisted_approve_followups === true;
  // onboarding: everything self-generated, except the hub's own housekeeping
  return !/^idle|^routine:(evolve|triage-inbound|daily-report|learn)/.test(source);
}

/** Judge may only auto-decide outside onboarding. */
export const judgeMayDecide = (cfg: Cfg, agent?: string) => level(cfg, agent) !== "onboarding";

/** Batch tasks/proposed into one numbered approval message. */
export async function proposeBatch(cfg: Cfg, host: string) {
  const open = list(P("decisions", "open")).map((p) => readDoc(p).meta).find((m) => m.kind === "proposals");
  if (open) return;
  const items = list(P("tasks", "proposed"), /^T-.*\.md$/).slice(0, 9);
  if (!items.length) return;
  const oldest = Math.min(...items.map((p) => Date.parse(readDoc(p).meta.created)));
  const batchWait = (cfg.autonomy?.batch_minutes ?? 15) * 60_000;
  if (Date.now() - oldest < batchWait && items.length < 5) return; // let a few accumulate
  const id = nextId("P", P("decisions"));
  const lines = items.map((p, i) => {
    const m = readDoc(p).meta;
    return `${i + 1}. [${m.agent}] ${m.title} _(${m.source})_`;
  });
  writeDoc(P("decisions", "open", `${id}.md`), {
    id, kind: "proposals", created: now(), host, items: items.map((p) => readDoc(p).meta.id).join(","),
    question: "Which of these should the fleet do?",
  }, `## Proposed\n${lines.join("\n")}\n`);
  await notify([`🗂 *${id}* · 我们打算做这些（学习期需要你确认）：`, ...lines,
    `回复 \`${id} 1,3\` / \`${id} all\` / \`${id} none\`，也可以 \`${id} 1 但先只做 Linux\``].join("\n"), cfg,
    { kind: "proposals", ref: id, options: ["all", "none", ...lines.map((_, i) => String(i + 1))] });
  journal(host, `🗂 ${id} asked owner to approve ${items.length} proposed tasks`);
}

/** Owner's answer to a proposals batch: approve picked ones, reject the rest (rejections are a learning signal). */
export function resolveProposals(id: string, answer: string, by: string): boolean {
  const f = P("decisions", "open", `${id}.md`);
  if (!existsSync(f)) return false;
  const { meta, body } = readDoc(f);
  const ids = (meta.items ?? "").split(",").filter(Boolean);
  const a = answer.trim().toLowerCase();
  const picked = new Set<number>(a.startsWith("all") ? ids.map((_, i) => i + 1)
    : a.startsWith("none") ? [] : (a.match(/^[\d,\s，]+/)?.[0] ?? "").split(/[,，\s]+/).filter(Boolean).map(Number));
  const note = answer.replace(/^[\d,\s，]+|^(all|none)\s*/i, "").trim();
  ids.forEach((tid, i) => {
    const p = P("tasks", "proposed", `${tid}.md`);
    if (!existsSync(p)) return;
    const { meta: tm, body: tb } = readDoc(p);
    const ok = picked.has(i + 1);
    writeDoc(P("tasks", ok ? "inbox" : "rejected", `${tid}.md`), { ...tm, source: ok ? `approved:${tm.source}` : tm.source, approval: ok ? id : `rejected:${id}` },
      tb + (note && ok ? `\n\n## Owner note (${id})\n${note}\n` : ""));
    unlinkSync(p);
  });
  writeDoc(P("decisions", "closed", `${id}.md`), { ...meta, answer, answered_by: by, answered: now() }, body + `\n## Answer\n${answer}\n`);
  unlinkSync(f);
  return true;
}

/** Shadow-judge accuracy: how often the judge's would-be answer matched the owner's. */
export function judgeAccuracy(agent?: string) {
  const rows = list(P("decisions", "closed")).map((p) => readDoc(p).meta)
    .filter((m) => m.shadow_verdict && /^owner/.test(m.answered_by ?? "") && (!agent || m.agent === agent));
  const comparable = rows.filter((m) => m.shadow_verdict === "decided");
  const agree = comparable.filter((m) => (m.answer ?? "").trim().slice(0, 1).toUpperCase() === (m.shadow_answer ?? "").trim().slice(0, 1).toUpperCase());
  return { samples: rows.length, would_decide: comparable.length, agreed: agree.length,
    accuracy: comparable.length ? +(agree.length / comparable.length).toFixed(2) : null };
}

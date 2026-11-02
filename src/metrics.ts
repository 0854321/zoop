// Fleet metrics → fleet/metrics.json; the architect uses them to evolve prompts, rules and memory.
import { writeFileSync } from "node:fs";
import { P, list, readDoc } from "./core";
import { judgeAccuracy } from "./autonomy";

export function computeMetrics(days = 7) {
  const since = Date.now() - days * 86400e3;
  const per: Record<string, { done: number; failed: number; blocked: number; minutes: number[] }> = {};
  for (const folder of ["done", "failed", "blocked"] as const)
    for (const p of list(P("tasks", folder), /^T-.*\.md$/)) {
      const m = readDoc(p).meta;
      if (Date.parse(m.finished ?? m.created) < since) continue;
      const a = (per[m.agent || "generalist"] ??= { done: 0, failed: 0, blocked: 0, minutes: [] });
      a[folder]++;
      if (m.started && m.finished) a.minutes.push((Date.parse(m.finished) - Date.parse(m.started)) / 60e3);
    }
  const decisions = list(P("decisions", "closed")).map((p) => readDoc(p).meta).filter((m) => Date.parse(m.answered ?? "") > since);
  const byWho = (re: RegExp) => decisions.filter((m) => re.test(m.answered_by ?? "")).length;
  // owner answering the same agent's questions with the recommended option → candidate for auto-approval
  const rubberStamp: Record<string, number> = {};
  for (const m of decisions) if (/^owner/.test(m.answered_by) && m.recommendation && m.answer?.trim().startsWith(m.recommendation.trim()))
    rubberStamp[m.agent] = (rubberStamp[m.agent] ?? 0) + 1;
  const agents = Object.fromEntries(Object.entries(per).map(([k, v]) => {
    const n = v.done + v.failed + v.blocked;
    const med = v.minutes.sort((a, b) => a - b)[Math.floor(v.minutes.length / 2)] ?? 0;
    return [k, { runs: n, success: +(v.done / (n || 1)).toFixed(2), failed: v.failed, blocked: v.blocked, median_minutes: Math.round(med) }];
  }));
  const approvals = list(P("decisions", "closed")).map((p) => readDoc(p).meta).filter((m) => m.kind === "proposals");
  const rejected = list(P("tasks", "rejected"), /^T-.*\.md$/).length;
  const out = {
    shadow_judge: judgeAccuracy(),
    shadow_judge_by_agent: Object.fromEntries(Object.keys(per).map((a) => [a, judgeAccuracy(a)])), proposal_batches: approvals.length, proposals_rejected_total: rejected,
    window_days: days, generated: new Date().toISOString(), agents,
    decisions: { total: decisions.length, by_judge: byWho(/^judge/), by_owner: byWho(/^owner\(/), owner_overrides_of_judge: byWho(/override/),
      owner_accepted_recommendation: rubberStamp },
  };
  writeFileSync(P("fleet", "metrics.json"), JSON.stringify(out, null, 2));
  return out;
}

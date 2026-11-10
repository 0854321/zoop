// Dumb, hard-coded gates for irreversible / outward-facing actions.
// These are enforced mechanically (Claude Code --disallowedTools), not left to model judgment.
// To run a gated action, an agent must go through `needs_decision`; after owner approval the
// follow-up task is created with `gate_override: <decision id>` and the approvable gates (APPROVABLE_GATES) are
// relaxed until the task ends, including runs after it parks on "waiting" (D-0075); a new needs_decision or a
// finished run clears it. A decision card does not record which action it approves, so everything else stays denied.
import type { Cfg } from "./core";
import { GH_REST_GATES } from "./github";

/** "Must ask" actions (policies/autonomy.md): an owner decision may approve these for one task. */
export const APPROVABLE_GATES = [
  "Bash(gh pr merge:*)",
  "Bash(gh pr review --approve:*)",
  "Bash(gh release create:*)",
  "Bash(gh repo edit:*)",
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(git push origin main:*)",
  "Bash(git push origin master:*)",
  "Bash(cargo publish:*)",
  "Bash(npm publish:*)",
  "Bash(bun publish:*)",
];

/** Never a legitimate outcome of a decision card: denied even under gate_override. */
export const ALWAYS_GATES = [
  "Bash(gh repo delete:*)",
  "Bash(gh secret:*)",
  "Bash(rm -rf /:*)",
  "Bash(rm -rf ~:*)",
];

export const DEFAULT_GATES = [...APPROVABLE_GATES, ...ALWAYS_GATES];

export function claudeDisallowed(cfg: Cfg, override = false): string[] {
  // `extra` is the owner's hard-block list and a card cannot say which entry it approved, so it stays denied.
  // REST-loop gates are quota etiquette and relax as before: an approved settings change may need one `gh api repos/...`.
  if (override) return [...ALWAYS_GATES, ...(cfg.gates?.extra ?? [])];
  return [...DEFAULT_GATES, ...(cfg.gates?.github_rest === false ? [] : GH_REST_GATES), ...(cfg.gates?.extra ?? [])];
}

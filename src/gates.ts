// Dumb, hard-coded gates for irreversible / outward-facing actions.
// These are enforced mechanically (Claude Code --disallowedTools), not left to model judgment.
// To run a gated action, an agent must go through `needs_decision`; after owner approval the
// follow-up task is created with `gate_override: <decision id>` and the gate list is relaxed for that run only.
import type { Cfg } from "./core";
import { GH_REST_GATES } from "./github";

export const DEFAULT_GATES = [
  "Bash(gh pr merge:*)",
  "Bash(gh pr review --approve:*)",
  "Bash(gh release create:*)",
  "Bash(gh repo delete:*)",
  "Bash(gh repo edit:*)",
  "Bash(gh secret:*)",
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(git push origin main:*)",
  "Bash(git push origin master:*)",
  "Bash(cargo publish:*)",
  "Bash(npm publish:*)",
  "Bash(bun publish:*)",
  "Bash(rm -rf /:*)",
  "Bash(rm -rf ~:*)",
];

export function claudeDisallowed(cfg: Cfg, override = false): string[] {
  if (override) return [];
  return [...DEFAULT_GATES, ...(cfg.gates?.github_rest === false ? [] : GH_REST_GATES), ...(cfg.gates?.extra ?? [])];
}

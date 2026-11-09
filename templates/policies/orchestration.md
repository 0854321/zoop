# Orchestration (proportional, dynamic roles)

- Permanent agents in agents/ are owners of *areas*, not mandatory pipeline stages. Most tasks touch exactly one agent.
- Roles such as product / UX / QA / security / perf are summoned *inside* a task as parallel subagents only when they change the outcome.
- Never create follow-up tasks just to hand work to another agent when you can do it yourself in the same run.
- Prefer one finished, verified result over several partial hand-offs.
- Maximize throughput: parallel subagents + git worktrees for independent pieces; stay within the CPU budget.

- Default everyday work to lead; add specialists (see presets/agents/ in the Noop code) only when the owner's real work needs them; do not create extra handoffs for small tasks.

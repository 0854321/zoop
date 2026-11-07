// Cloudflare free-plan budget: Noop must run on the Workers Free plan. This is a hard rule (see AGENTS.md).
// FREE is what Cloudflare allows per account per day (resets 00:00 UTC; storage is a total). Noop's own steady state
// must stay under TARGET (a fifth of it), because the account is shared with other projects and a busy day costs more.
// The Worker meters itself and sheds non-essential writes past LEAN / SHED; test/budget.test.ts fails CI when a
// simulated fleet day goes over TARGET.
export const FREE = { requests: 100_000, rowsRead: 5_000_000, rowsWritten: 100_000, storageBytes: 5_000_000_000 } as const;
export const TARGET = { requests: 20_000, rowsRead: 1_000_000, rowsWritten: 20_000, storageBytes: 500_000_000 } as const;
/** Fractions of FREE: past LEAN hot state is persisted rarely; past SHED fleet chatter is refused (429, Retry-After). */
export const LEAN = 0.4, SHED = 0.7;

/** Fleet sync pacing (src/sync.ts). Journals and heartbeats ride along with real changes, or go up every LAZY_PUSH_MS. */
export const LAZY_PUSH_MS = 5 * 60_000;
/** A pull right after another one is served from the mirror; commits still detect races through compare-and-swap. */
export const PULL_MIN_MS = 10_000;
/** Heartbeats go up lazily, so a machine counts as offline only after this long without one. */
export const OFFLINE_AFTER_MINUTES = 8;

/** Paths rewritten constantly whose old versions are worth nothing: append-only logs and machine heartbeats. */
export const latestOnly = (p: string) =>
  p.startsWith("journal/") || p.startsWith("logs/") || p.startsWith("fleet/") || p === "memory/lessons.md" || p === "memory/judge-feedback.md";

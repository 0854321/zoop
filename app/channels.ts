/** Channels: work topics the AI opens (like Slack channels in a company), read-only drill-downs of the main chat. */
export type ChannelItem = { id: string; kind: "task" | "decision" | "report"; title: string; state: string; updated: string; task?: string };
export type Channel = { slug: string; name: string; goal: string; status: "active" | "archived"; created: string; last_activity: string; stale: boolean; count: number; refs?: string[]; items: ChannelItem[] };

/** Sidebar order: active first, the most recently busy on top; archived last. */
export function sortChannels(cs: readonly Channel[]): Channel[] {
  return [...cs].sort((a, b) => (a.status === b.status ? b.last_activity.localeCompare(a.last_activity) : a.status === "active" ? -1 : 1));
}

/** A channel's digest (mirrors cloud/src/tools.ts channelDigest): main-chat messages about its tasks and cards, newest
 *  last; task-thread chatter and the hub's acks stay on the task page. */
export function channelDigest<E extends { ref?: string; from: string; thread?: boolean; kind?: string }>(events: readonly E[], refs: readonly string[], limit = 80): E[] {
  const want = new Set(refs);
  return events.filter((e) => !!e.ref && want.has(e.ref) && !e.thread && !/^hub/.test(e.from) && e.kind !== "system").slice(-limit);
}

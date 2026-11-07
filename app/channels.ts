/** Channels: work topics the AI opens (like Slack channels in a company), read-only drill-downs of the main chat. */
export type ChannelItem = { id: string; kind: "task" | "decision"; title: string; state: string; updated: string; task?: string };
export type Channel = { slug: string; name: string; goal: string; status: "active" | "archived"; created: string; last_activity: string; stale: boolean; count: number; items: ChannelItem[] };

/** When each channel was last opened on this device: newer items are unread. */
export type SeenMap = Record<string, string>;

export function parseSeen(raw: string | null): SeenMap {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === "string")) as SeenMap : {};
  } catch { return {}; }
}

/** A channel never opened here counts from `since` (when this device first saw channels), so old work isn't a flood. */
/** `chat` ties a channel to the main chat's read state: for an item with messages there, it says whether one of them
 * is unread (marked unread by hand, or newer than both the chat cursor and when the channel was opened); `undefined`
 * falls back to the item's own update time. */
export type ChatRead = (ref: string, openedAt: string) => boolean | undefined;

export function unreadIn(c: Channel, seen: SeenMap, since: string, chat?: ChatRead): number {
  const from = seen[c.slug] ?? since;
  if (c.status === "archived") return 0;
  return c.items.filter((i) => chat?.(i.id, from) ?? i.updated > from).length;
}

/** Sidebar order: active first, the most recently busy on top; archived last. */
export function sortChannels(cs: readonly Channel[]): Channel[] {
  return [...cs].sort((a, b) => (a.status === b.status ? b.last_activity.localeCompare(a.last_activity) : a.status === "active" ? -1 : 1));
}

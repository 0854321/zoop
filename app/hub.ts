// noop: the server's shapes and the pure logic of the timeline (no UI, no I/O), shared by App.tsx and the tests.

export type Kind = "notice" | "decision" | "menu" | "proposals" | "login" | "owner" | "system";

export type HubEvent = {
  id: string;
  ts: string;
  from: string;
  kind: Kind;
  text: string;
  ref?: string;
  options?: string[];
  attachments?: string[];
};

export type HostInfo = {
  host: string;
  caps: string[];
  seen?: string;
  busy?: number;
  stats?: { loadRatio?: number; load1?: number; cores?: number; memFreePct?: number; diskFreeGB?: number; diskFreePct?: number; [k: string]: unknown };
  os?: string;
  arch?: string;
  clis?: string[];
  accounts?: { cli: string; name: string; state: "ok" | "cooldown" | "login"; until?: string }[];
  running?: { id: string; title: string; agent: string; started?: string }[];
  recent?: { id: string; title: string; state?: string; finished?: string }[];
};

export type TaskInfo = {
  id: string; title: string; agent: string; host?: string; state?: string;
  started?: string; created?: string; finished?: string; updated?: string; attempt?: string; decision?: string; cli?: string; model?: string;
  request?: string;
  runs?: { ts: string; host: string; cli: string; status: string; summary: string }[];
  steps?: { day?: string; time?: string; host?: string; kind?: string; text: string }[];
};

export type Status = {
  tasks: Record<"proposed" | "inbox" | "active" | "blocked" | "failed" | "done", number>;
  active: TaskInfo[];
  recent?: TaskInfo[];
  decisions: { id: string; kind: string; question?: string; held: boolean }[];
  hosts: HostInfo[];
};

/** An item id the owner answers: decisions, proposals (lists to approve) and logins. */
export const ITEM_ID = /^[DLP]-[A-Z]?\d{4}$/;
const LEADING_ID = /^\s*([DLP]-[A-Z]?\d{4})\b/;

/** Events that ask the owner something, shown as a card with buttons. */
export function isAsk(e: HubEvent): boolean {
  return !!e.ref && ITEM_ID.test(e.ref) && ["decision", "menu", "proposals", "login"].includes(e.kind);
}

/** The one-tap answers of an ask: numbers (and all / none) for menus and proposals, letters for decisions. */
export function choicesOf(e: HubEvent): string[] {
  const o = e.options ?? [];
  if (e.kind === "menu" || e.kind === "proposals") {
    const nums = o.map((x) => (x.match(/^\s*(\d+|all|none)\b/i) ?? [])[1]).filter((x): x is string => !!x);
    const rank = (x: string) => (/^\d+$/.test(x) ? 0 : x.toLowerCase() === "all" ? 1 : 2);
    return [...new Set(nums.map((x) => (/^\d+$/.test(x) ? x : x.toLowerCase())))].sort((a, b) => rank(a) - rank(b));
  }
  return [...new Set(o.map((x) => (x.match(/^\s*([A-Z])\s*[:：.]/) ?? [])[1]).filter((x): x is string => !!x))];
}

/** The option the team recommends ("建议：B" in the text), if any. */
export function recommended(e: HubEvent): string | null {
  const m = (e.text ?? "").match(/建议：\*?([^*\s　]+)/);
  return m ? m[1].split(/[,，]/)[0] : null;
}

export const choiceLabel = (c: string) => (c === "all" ? "全部" : c === "none" ? "都不要" : c);

/** The ids the owner has already answered, from the owner's own messages. */
export function answeredIds(events: HubEvent[]): Set<string> {
  const done = new Set<string>();
  for (const e of events) {
    if (e.kind !== "owner") continue;
    if (e.ref) done.add(e.ref);
    const m = e.text.match(LEADING_ID);
    if (m) done.add(m[1]);
  }
  return done;
}

export const TAGS: Partial<Record<Kind, string>> = { decision: "需要决定", menu: "下一步", proposals: "待批准", login: "登录" };

export const isHub = (from: string) => /^hub/.test(from);
export const displayName = (from: string) => from.replace(/@.*/, "");
export const initials = (from: string) => (from || "?").replace(/@.*/, "").slice(0, 2).toUpperCase();
export const isVideo = (url: string) => /\.(mp4|webm|mov)(\?|$)/i.test(url);

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export function dayLabel(key: string, now = new Date()): string {
  if (key === dayKey(now.toISOString())) return "今天";
  const y = new Date(now.getTime() - 86400000);
  if (key === dayKey(y.toISOString())) return "昨天";
  const [yy, mm, dd] = key.split("-").map(Number);
  return yy === now.getFullYear() ? `${mm} 月 ${dd} 日` : `${yy} 年 ${mm} 月 ${dd} 日`;
}

/** The timeline's rows: the events with a separator before each new day. */
export type Row = { key: string; day: string } | { key: string; event: HubEvent };
export function rows(events: HubEvent[]): Row[] {
  const out: Row[] = [];
  let last = "";
  for (const e of events) {
    const d = dayKey(e.ts);
    if (d !== last) out.push({ key: `day:${d}`, day: d });
    last = d;
    out.push({ key: e.id, event: e });
  }
  return out;
}

/** Merge newly fetched or pushed events into the timeline: no duplicates, ordered by time. */
export function merge(events: HubEvent[], incoming: HubEvent[]): HubEvent[] {
  if (!incoming.length) return events;
  const seen = new Set(events.map((e) => e.id));
  const add = incoming.filter((e) => !seen.has(e.id));
  if (!add.length) return events;
  const all = [...events, ...add];
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all;
}

/** Decisions waiting for the owner (held decisions and proposals). */
export const waiting = (s: Status | null) => (s?.decisions ?? []).filter((d) => d.held || d.kind === "proposals");

export const osOf = (h: HostInfo) => (h.caps.find((c) => c.startsWith("os:")) ?? "").slice(3);
export const loadOf = (h: HostInfo) => Math.max(0, Math.min(100, Math.round((h.stats?.loadRatio ?? 0) * 100)));

export function greeting(hour = new Date().getHours()): string {
  return hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
}

/** "http://x:8787/" → "http://x:8787"; adds http:// when no scheme is given. */
export function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

export const wsUrl = (base: string, token: string) =>
  `${base.replace(/^http/i, "ws")}/api/stream?token=${encodeURIComponent(token)}`;

export const mediaUrl = (base: string, token: string, path: string) =>
  /^(blob|data):/i.test(path)
    ? path // a local preview of an image not sent yet
    : `${/^https?:/i.test(path) ? path : base + path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

// ---------------------------------------------------------------- attachments (images the owner sends with a message)

/** An image waiting in the composer (or in a held message): its bytes and a local URL that shows it. */
export type Attachment = { id: string; name: string; type: string; size: number; file: Blob; preview: string };

export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_COUNT = 10;
const IMAGE_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
};

/** The image type of a file, from its media type or else its name's extension; null when it is not an image (SVG is not taken). */
export function imageType(type: string | undefined, name: string): string | null {
  if (type && /^image\/[\w.+-]+$/i.test(type) && !/svg/i.test(type)) return type.toLowerCase();
  return IMAGE_EXT[(name.match(/\.(\w+)$/)?.[1] ?? "").toLowerCase()] ?? null;
}

/** Why a file cannot be attached ("" when it can). */
export function attachProblem(type: string | null, size: number, count: number): string {
  if (!type) return "只能发送图片";
  if (size > ATTACH_MAX_BYTES) return "图片不能超过 10 MB";
  if (count >= ATTACH_MAX_COUNT) return `一次最多发送 ${ATTACH_MAX_COUNT} 张图片`;
  return "";
}

/** A `file:` URL as a local path ("file:///Users/a/My%20Shot.png" → "/Users/a/My Shot.png"; Windows drive paths too). */
export function filePath(uri: string): string {
  const p = decodeURIComponent(uri.replace(/^file:\/\/[^/]*/i, ""));
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
}

// ---------------------------------------------------------------- team settings (GET / PUT /api/settings)

export type Autonomy = "onboarding" | "assisted" | "autonomous" | (string & {});
export type SettingsView = {
  current: Record<string, unknown>;
  effective: {
    agents: { id: string; clis: string[]; autonomy: Autonomy }[];
    autonomy: Autonomy;
    routines: { name: string; every: string; agent: string; enabled: boolean }[];
    max_parallel: number | null;
  };
  options: { clis: string[][]; autonomy: string[] };
};

const CLI_LABELS: Record<string, string> = {
  claude: "仅 Claude",
  "codex,claude": "Codex → Claude",
  "claude,codex": "Claude → Codex",
  codex: "仅 Codex",
};
export const cliKey = (clis: string[]) => clis.join(",");
export const cliLabel = (clis: string[]) => CLI_LABELS[cliKey(clis)] ?? clis.join(" → ");
const AUTONOMY_LABELS: Record<string, string> = { onboarding: "学习期", assisted: "协助", autonomous: "自主" };
export const autonomyLabel = (a: string) => AUTONOMY_LABELS[a] ?? a;
export const INTERVALS = ["15m", "30m", "1h", "2h", "6h", "1d"];
export const intervalsWith = (every: string) => (INTERVALS.includes(every) ? INTERVALS : [...INTERVALS, every]);

/** The PUT bodies the settings screen sends (whitelisted keys of the hub). */
export const patches = {
  clis: (agent: string, clis: string[]) => ({ clis: { agents: { [agent]: clis } } }),
  autonomy: (agent: string, level: string) => ({ autonomy: { agents: { [agent]: level } } }),
  routine: (name: string, change: { enabled?: boolean; every?: string }) => ({ routines: { [name]: change } }),
  maxParallel: (n: number) => ({ host: { max_parallel: n } }),
};

// ---------------------------------------------------------------- notifications (Web Push; PUT /api/settings notify_prefs)

export const NOTIFY_KINDS = [
  ["decision", "决策"],
  ["menu", "菜单"],
  ["proposals", "待批任务"],
  ["login", "登录"],
  ["result", "结果通知"],
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number][0];
export type QuietHours = { start: string; end: string } | null;
export type NotifyPrefs = { kinds: Record<NotifyKind, boolean>; quiet_hours: QuietHours; tz: string };

export const QUIET_PRESETS: { label: string; value: QuietHours }[] = [
  { label: "不设", value: null },
  { label: "22:00–08:00", value: { start: "22:00", end: "08:00" } },
  { label: "23:00–07:00", value: { start: "23:00", end: "07:00" } },
  { label: "00:00–09:00", value: { start: "00:00", end: "09:00" } },
];
export const quietKey = (q: QuietHours) => (q ? `${q.start}-${q.end}` : "off");

/** The saved preferences (every kind on and no quiet hours until the owner changes them). */
export function notifyPrefsOf(view: SettingsView | null, tz: string): NotifyPrefs {
  const saved = (view?.current?.notify_prefs ?? {}) as Partial<NotifyPrefs>;
  const kinds = Object.fromEntries(NOTIFY_KINDS.map(([k]) => [k, saved.kinds?.[k] ?? true])) as Record<NotifyKind, boolean>;
  return { kinds, quiet_hours: saved.quiet_hours ?? null, tz: saved.tz ?? tz };
}
export const notifyPatch = (prefs: NotifyPrefs) => ({ notify_prefs: prefs });

/** The event to draw "以下为新消息" above: the first one from others after what was last seen. */
export function firstUnread(events: HubEvent[], seenTs: string | null): string | null {
  if (!seenTs) return null;
  const e = events.find((x) => x.ts > seenTs && x.kind !== "owner");
  return e ? e.id : null;
}

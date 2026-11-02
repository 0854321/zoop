// noop chat client: one TSX app for the web (served by the hub), macOS, Linux and phones.
// Design: the NSH gallery's (~/work/nsh/examples/gallery): its theme tokens (theme.json is the
// gallery's), its shared UI layer (nsh-gallery-ui: palette, icons, tooltips, scroll bars), its
// sidebar + toolbar layout; sized up for reading a chat all day (16 pt text, 40 pt controls).
import {
  cleanup,
  colorScheme,
  computed,
  effect,
  host,
  Image,
  keymap,
  locale,
  mount,
  platform,
  safeArea,
  Scroll,
  type ScrollRef,
  type ViewRef,
  setColorScheme,
  signal,
  Storage,
  Text,
  untracked,
  Video,
  View,
  windowSize, token, openUrl, keyboardFrame, Picker } from "nsh";
import fs from "fs/promises";
import type { InputRef, JSX, ViewStyle } from "nsh";
import { AlertDialog, ContextMenu, Dialog, Menu, MenuItem, Input, NavPage, NavStack, NumberInput, Radio, RadioGroup, Scrollbar, Sheet, TextView, createNavStack, type MarkdownExtension, type TextViewBlock, type TextViewCustomNode, type TextViewInline } from "nsh/base";
import { isAvailable as hasWindow, titleBar, Window } from "nsh/desktop";
import {
  alpha,
  colors,
  Toggle,
  focusRing,
  hovered,
  Icon,
  type IconName,
  isDark,
  radius,
  scrollbarTheme,
  Spinner,
  tints,
  Tip,
} from "./ui";
import {
  answeredIds,
  choiceLabel,
  choicesOf,
  dayLabel,
  displayName,
  greeting,
  type HubEvent,
  initials,
  isAsk,
  isHub,
  isVideo,
  loadOf,
  mediaUrl,
  merge,
  normalizeUrl,
  osOf,
  recommended,
  type Attachment,
  attachProblem,
  filePath,
  imageType,
  rows,
  type Status,
  TAGS,
  timeOf,
  waiting,
  wsUrl,
  autonomyLabel,
  cliKey,
  cliLabel,
  intervalsWith,
  activityLine,
  everyLabel,
  patches,
  type SettingsView,
  NOTIFY_KINDS,
  type NotifyKind,
  type NotifyPrefs,
  notifyPrefsOf,
  notifyPatch,
  QUIET_PRESETS,
  quietKey,
  firstUnread,
  type Row,
  type DataFile,
  type RuleGroup,
  RULE_PREFIXES,
  groupRules,
  stripFrontMatter,
  type HostInfo,
  type Command,
  type CommandItem,
  commandItems,
  savedCommands,
  BUILTIN_COMMANDS,
  slashQuery,
  needsLabel,
  updateLine,
  updateSummary,
  type UpdateLine,
  isQueued,
} from "./hub";

type Config = { url: string; token: string };
/** `token` holds the login session (sent as `Bearer`, and `?token=` on the WebSocket and media URLs). */
const KEYS = { url: "hub.url", token: "hub.token", email: "hub.email", theme: "hub.theme", seen: "hub.lastSeen", notifyAsked: "hub.notifyAsked" };
const touch = !(platform.idiom === "desktop" || platform.idiom === "mac");
/** iOS and Android draw the pages' headers (title, back, swipe back); the desktops and the web show the app's. */
const systemHeader = platform.os === "ios" || platform.os === "android";
const MONO = "monospace";

/** Sizes: the gallery's proportions, a step larger (the owner reads this all day). */
const size = {
  text: 17,
  line: 26,
  small: 15,
  tiny: 13,
  control: touch ? 44 : 38,
  row: touch ? 44 : 34,
  bar: touch ? 56 : 52,
  sidebar: 288,
  column: 880,
};

// ---------------------------------------------------------------- settings & connection

type Page = { origin?: string; theme?: string | null; ref?: string | null };

/** A function of the page's host (host.js on the web: push, badge, ...); null where there is none or it failed. */
async function hostCall<T>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    if (!host.available()) return null;
    return ((await host.call(name, args ?? {})) ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Where the app was served from on the web (nsh.json `web.host`); nothing elsewhere. */
async function pageInfo(): Promise<Page> {
  try {
    if (!host.available()) return {};
    return ((await host.call("page")) ?? {}) as Page;
  } catch {
    return {};
  }
}

type Boot = { config: Config | null; suggested: string; served: boolean; email: string; ref: string | null };

async function loadConfig(): Promise<Boot> {
  const page = await pageInfo();
  if (page.theme === "light" || page.theme === "dark") setColorScheme(page.theme);
  else {
    const saved = await Storage.getItem(KEYS.theme);
    if (saved === "light" || saved === "dark") setColorScheme(saved);
  }
  let url = (await Storage.getItem(KEYS.url)) ?? "";
  const token = (await Storage.getItem(KEYS.token)) ?? "";
  if (!url && page.origin) url = page.origin;
  const suggested = url || page.origin || "";
  const email = (await Storage.getItem(KEYS.email)) ?? "";
  return { config: url && token ? { url: normalizeUrl(url), token } : null, suggested, served: !!page.origin, email, ref: page.ref ?? null };
}

type Conn = "connecting" | "live" | "offline" | "unauthorized";

function createHub(cfg: Config) {
  const events = signal<HubEvent[]>([]);
  const status = signal<Status | null>(null);
  const conn = signal<Conn>("connecting");
  const loaded = signal(false);
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  let disposed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const last = () => {
    const evs = untracked(events);
    return evs.length ? evs[evs.length - 1].ts : "";
  };

  async function loadFeed() {
    const since = last();
    try {
      const r = await fetch(`${cfg.url}/api/feed${since ? `?since=${encodeURIComponent(since)}` : ""}`, { headers });
      if (r.status === 401) return conn.set("unauthorized");
      const body = (await r.json()) as { events: HubEvent[] };
      events.update((evs) => merge(evs, body.events));
    } catch {
      conn.set("offline");
    } finally {
      loaded.set(true);
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch(`${cfg.url}/api/status`, { headers });
      if (r.ok) status.set((await r.json()) as Status);
    } catch {
      /* the feed reports the connection */
    }
  }

  function stream() {
    if (disposed || untracked(conn) === "unauthorized") return;
    const ws = new WebSocket(wsUrl(cfg.url, cfg.token));
    socket = ws;
    ws.onopen = () => conn.set("live");
    ws.onmessage = (m: { data: unknown }) => {
      try {
        events.update((evs) => merge(evs, [JSON.parse(String(m.data)) as HubEvent]));
      } catch {
        return;
      }
      loadStatus();
    };
    ws.onclose = () => {
      if (disposed) return;
      if (untracked(conn) !== "unauthorized") conn.set("offline");
      retry = setTimeout(async () => {
        await loadFeed();
        stream();
      }, 3000);
    };
  }

  /** Uploads one image the owner attaches; resolves with its media path ("/media/…"). */
  async function upload(a: Attachment): Promise<string> {
    const fd = new FormData();
    fd.append("file", a.file, a.name);
    const r = await fetch(`${cfg.url}/api/uploads`, { method: "POST", headers: { Authorization: headers.Authorization }, body: fd });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(`图片上传失败（${r.status}）`);
    return ((await r.json()) as { url: string }).url;
  }

  async function send(text: string, replyTo: string | null, files: Attachment[] = []) {
    const attachments: string[] = [];
    for (const f of files) attachments.push(await upload(f));
    const r = await fetch(`${cfg.url}/api/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, ...(replyTo ? { reply_to: replyTo } : {}), ...(attachments.length ? { attachments } : {}) }),
    });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(`发送失败（${r.status}）`);
    const ev = (await r.json()) as HubEvent;
    if (ev?.id) events.update((evs) => merge(evs, [ev]));
    loadStatus();
  }

  async function settings(patch?: Record<string, unknown>): Promise<SettingsView> {
    const r = await fetch(`${cfg.url}/api/settings`, patch ? { method: "PUT", headers, body: JSON.stringify(patch) } : { headers });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(`设置${patch ? "保存" : "读取"}失败（${r.status}）`);
    return (await r.json()) as SettingsView;
  }

  /** A JSON call of the hub's API: never throws (status 0 when unreachable); a 401 ends the session. */
  async function api(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    try {
      const r = await fetch(`${cfg.url}${path}`, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) });
      if (r.status === 401) conn.set("unauthorized");
      let data: Record<string, unknown> = {};
      try {
        data = ((await r.json()) ?? {}) as Record<string, unknown>;
      } catch {
        /* no body */
      }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: {} };
    }
  }

  async function logout() {
    try {
      await fetch(`${cfg.url}/api/auth/logout`, { method: "POST", headers });
    } catch {
      /* forgotten locally either way */
    }
  }

  loadFeed().then(stream);
  loadStatus();
  const timer = setInterval(loadStatus, 15000);
  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    clearTimeout(retry);
    socket?.close();
  };
  return { events, status, conn, loaded, send, settings, api, logout, dispose, cfg };
}
type Hub = ReturnType<typeof createHub>;

function toggleTheme() {
  const next = colorScheme() === "dark" ? "light" : "dark";
  setColorScheme(next);
  Storage.setItem(KEYS.theme, next);
}

// ---------------------------------------------------------------- small pieces (the gallery's idioms)

/** A key as a small badge: `1`, `Enter`, `⌘K`. */
function Kbd(props: { k: string; on?: string }) {
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: 6,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 5,
        borderWidth: 1,
        borderColor: props.on ? alpha(props.on, 0.35) : colors.border,
        backgroundColor: props.on ? "transparent" : colors.raised,
      }}
    >
      <Text style={{ fontSize: 12.5, fontWeight: "500", color: props.on ?? colors.muted, fontVariant: ["tabular-nums"] }}>{props.k}</Text>
    </View>
  );
}

/** A quiet icon button of the toolbars and the sidebar (the gallery's ToolButton, at 36 pt). */
function ToolButton(props: { icon: IconName; label: string; shortcut?: string; on?: boolean; onPress: () => void; testID?: string }) {
  return (
    <View
      onPress={props.onPress}
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={props.on === undefined ? undefined : { selected: props.on }}
      tooltip={<Tip label={props.label} shortcut={props.shortcut} />}
      hoverStyle={hovered()}
      activeStyle={{ backgroundColor: alpha(colors.text, 0.09) }}
      focusStyle={focusRing()}
      style={{ width: touch ? 44 : 36, height: touch ? 44 : 36, alignItems: "center", justifyContent: "center", borderRadius: radius.control, borderWidth: 1, borderColor: "transparent" }}
    >
      <Icon name={props.icon} size={18} tint={props.on ? colors.accent : colors.muted} />
    </View>
  );
}

type BtnKind = "primary" | "secondary" | "ghost" | "dashed" | "danger";

/** A labelled button: the gallery's raised / accent-filled look, 38 pt (44 on touch). */
function Btn(props: {
  label: string;
  kind?: BtnKind;
  icon?: IconName;
  kbd?: string;
  note?: string;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
  grow?: boolean;
}) {
  const kind = () => props.kind ?? "secondary";
  const fg = () => (kind() === "primary" ? colors.onAccent : kind() === "danger" ? colors.danger : kind() === "dashed" || kind() === "ghost" ? colors.muted : colors.text);
  const look = (): ViewStyle =>
    kind() === "primary"
      ? { backgroundColor: colors.accentFill, borderColor: "transparent" }
      : kind() === "danger"
        ? { backgroundColor: tints.danger, borderColor: alpha(colors.danger, 0.3) }
        : kind() === "ghost"
          ? { backgroundColor: "transparent", borderColor: "transparent" }
          : kind() === "dashed"
            ? { backgroundColor: "transparent", borderColor: colors.fieldBorder, borderStyle: "dashed" }
            : { backgroundColor: colors.surface, borderColor: colors.border };
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: !!props.disabled }}
      onPress={() => !props.disabled && !props.busy && props.onPress()}
      hoverStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.92 } : hovered()}
      activeStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.85 } : { backgroundColor: alpha(colors.text, 0.09) }}
      focusStyle={focusRing()}
      style={{
        minHeight: size.control,
        maxWidth: "100%",
        flexShrink: 1,
        flexGrow: props.grow ? 1 : 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: radius.control,
        borderWidth: 1,
        opacity: props.disabled ? 0.45 : 1,
        transitionProperty: "background-color, border-color, opacity",
        transitionDuration: 120,
        ...look(),
      }}
    >
      <If when={props.kbd}>
        <Kbd k={props.kbd!} on={kind() === "primary" ? colors.onAccent : undefined} />
      </If>
      <If when={props.busy}>
        <Spinner size={14} tint={fg()} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={16} tint={fg()} />
      </If>
      <Text style={{ flexShrink: 1, fontSize: 15, lineHeight: 21, fontWeight: kind() === "primary" ? "600" : "500", color: fg() }}>{props.label}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: size.tiny, color: kind() === "primary" ? alpha(colors.onAccent, 0.7) : colors.faint }}>{props.note}</Text>
      </If>
    </View>
  );
}

function Dot(props: { tone: "on" | "run" | "queue" | "wait" | "off" | "bad" }) {
  const color = () => ({ on: colors.up, run: colors.up, queue: colors.info, wait: colors.warn, off: colors.faint, bad: colors.danger })[props.tone];
  return <View style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: color() }} />;
}

/** A tag in the gallery's Badge style: a tone's tint behind its color. */
function Badge(props: { label: string; tone?: "accent" | "warn" | "info" | "neutral" | "danger" }) {
  const tone = props.tone ?? "neutral";
  const fg = () => (tone === "neutral" ? colors.muted : tone === "accent" ? colors.accent : colors[tone]);
  const bg = () => (tone === "neutral" ? colors.raised : tints[tone]);
  return (
    <View style={{ height: 22, paddingHorizontal: 8, justifyContent: "center", borderRadius: 6, backgroundColor: bg() }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: fg() }}>{props.label}</Text>
    </View>
  );
}

/** The app's mark: a dark square with a live dot (the hub). */
function Mark(props: { size?: number }) {
  const s = props.size ?? 24;
  return (
    <View style={{ width: s, height: s, borderRadius: s * 0.28, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: s * 0.38, height: s * 0.38, borderRadius: s, backgroundColor: colors.surface }} />
    </View>
  );
}

/** Opens a task's page from a T-0000 in any text (set by the channel). */
let taskLink: (id: string) => void = () => {};

/** A task's state from the hub's status (set by the channel), for the chips' dots. */
let taskState: (id: string) => string | undefined = () => undefined;

/** The app's syntax in messages (`extensions`, `pattern`): task ids and decision / proposal ids, shown by `renderCustom`. */
const EXTENSIONS: MarkdownExtension[] = [
  // ids minted on a non-primary host carry its letter (T-M0001, D-H0002)
  { name: "task", pattern: "\\bT-[A-Z]?\\d{4}\\b" },
  { name: "item", pattern: "\\b[DP]-[A-Z]?\\d{4}\\b" },
];
const GH = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)\/?$/;

/** Links to a GitHub PR or issue become `github` custom nodes: patterns never match inside links, and GFM autolinks bare URLs. */
function ghInlines(inlines: TextViewInline[]): TextViewInline[] {
  return inlines.map((i): TextViewInline => {
    if (i.type === "link") {
      const m = i.url.match(GH);
      return m ? { type: "custom", name: "github", text: i.url, attributes: { repo: m[2], n: m[4], kind: m[3] === "pull" ? "PR" : "Issue" } } : i;
    }
    return "content" in i && Array.isArray(i.content) ? ({ ...i, content: ghInlines(i.content) } as TextViewInline) : i;
  });
}
function ghBlocks(blocks: TextViewBlock[]): TextViewBlock[] {
  return blocks.map((b): TextViewBlock => {
    const x = { ...b } as Record<string, unknown>;
    if (Array.isArray(x.content)) x.content = ghInlines(x.content as TextViewInline[]);
    if (Array.isArray(x.children)) x.children = ghBlocks(x.children as TextViewBlock[]);
    if (Array.isArray(x.items)) x.items = (x.items as { children: TextViewBlock[] }[]).map((it) => ({ ...it, children: ghBlocks(it.children) }));
    return x as TextViewBlock;
  });
}

/**
 * "nsh #747" → a link to that PR when the message (or `context`, a decision's options) links a PR of a repository
 * named "nsh"; a bare "#747" only on a decision card whose links name one repository. Code spans are left alone.
 */
function linkRepoRefs(text: string, context = ""): string {
  const seen = new Map<string, string>();
  for (const m of `${text}\n${context}`.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/\d+/g)) seen.set(m[2].toLowerCase(), `${m[1]}/${m[2]}`);
  if (!seen.size) return text;
  const only = context && seen.size === 1 ? [...seen.values()][0] : null;
  return text.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(
    /(^|[^\w\/\[#])(?:([\w.-]+)( ?))?#(\d+)\b/g,
    (all, pre: string, name: string | undefined, sp: string, n: string) => {
      const slug = name && seen.get(name.toLowerCase());
      if (slug) return `${pre}[${name}#${n}](https://github.com/${slug}/pull/${n})`;
      if (!only || (name && !sp && !/^(pr|issue)s?$/i.test(name))) return all;
      return `${pre}${name ? name + sp : ""}[#${n}](https://github.com/${only}/pull/${n})`;
    },
  ))).join("");
}

/** Hub text keeps its line breaks: single newlines become hard breaks, outside code fences. */
function hubMarkdown(text: string): string {
  return text
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) => (i % 2 ? part : part
      // single newlines are hard breaks, except around list items (a "\\" there shows up literally)
      .replace(/([^\n])\n(?!\n|\s*(?:[-*+]|\d+[.)])\s)/g, (m0, c, off, all) => /^\s*(?:[-*+]|\d+[.)])\s/.test(all.slice(all.lastIndexOf("\n", off) + 1, off + 1)) ? `${c}\n` : `${c}\\\n`)
      // Bare URLs stop at CJK / full-width punctuation and spaces ("pull/1：让" links pull/1 only).
      .replace(/(?<![(<\[`])\bhttps?:\/\/[^\s<>()\[\]`\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]+[^\s<>()\[\]`.,;:!?'"\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]/g, "<$&>")))
    .join("");
}

/** Texts inside a pressable chip: a pointer, not the I-beam selectable texts force (per view on Linux). */
const chipText = { cursor: "pointer", userSelect: "none" } as const;
const chipFrame: ViewStyle = {
  cursor: "pointer", verticalAlign: "middle", flexDirection: "row", alignItems: "center", gap: 5, marginHorizontal: 2, height: 20,
  borderWidth: 1, borderColor: colors.border, backgroundColor: alpha(colors.text, 0.05),
};
const chipHover: ViewStyle = { borderColor: colors.fieldBorder, backgroundColor: alpha(colors.text, 0.09) };

function Custom(props: { node: TextViewCustomNode; small: boolean }) {
  const n = props.node;
  const fs = props.small ? 12 : 13;
  if (n.name === "task") {
    const st = () => STATE_OF()[taskState(n.text!) ?? ""];
    return (
      <View role="link" testID={`task-chip-${n.text}`} accessibilityLabel={`任务 ${n.text}`} onPress={() => taskLink(n.text!)}
        hoverStyle={chipHover} style={{ ...chipFrame, paddingHorizontal: 7, borderRadius: 999 }}>
        <If when={st()}>
          <View style={{ cursor: "pointer", width: 6, height: 6, borderRadius: 3, backgroundColor: st()?.[1] ?? colors.muted }} />
        </If>
        <Text style={{ ...chipText, fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.text }}>{n.text}</Text>
      </View>
    );
  }
  if (n.name === "github") {
    const a = n.attributes ?? {};
    return (
      <View role="link" testID={`gh-chip-${a.repo}-${a.n}`} accessibilityLabel={`GitHub ${a.kind} ${a.repo}#${a.n}`} onPress={() => void openUrl(n.text!).catch(() => {})}
        hoverStyle={chipHover} style={{ ...chipFrame, paddingHorizontal: 6, borderRadius: 6 }}>
        <Icon name="github" size={14} tint={colors.text} />
        <Text style={{ ...chipText, fontSize: fs, lineHeight: 16, color: colors.muted }}>{a.kind}</Text>
        <Text style={{ ...chipText, fontSize: fs, lineHeight: 16, fontWeight: "600", color: colors.text }}>{`${a.repo}#${a.n}`}</Text>
      </View>
    );
  }
  return (
    <View style={{ verticalAlign: "middle", height: 20, justifyContent: "center", marginHorizontal: 2, paddingHorizontal: 6, borderRadius: 5, backgroundColor: alpha(colors.text, 0.06) }}>
      <Text style={{ fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.muted }}>{n.text}</Text>
    </View>
  );
}

/** Message text: the hub's Markdown through `TextView` (selectable across paragraphs), links opened by the system, the app's chips inline. */
function Rich(props: { text: string; muted?: boolean; quiet?: boolean; context?: string }) {
  const small = !!(props.muted || props.quiet);
  const fontSize = props.quiet ? 14 : props.muted ? size.small : size.text;
  const lineHeight = small ? 21 : size.line;
  const doc = () => {
    const d = TextView.parse(hubMarkdown(linkRepoRefs(props.text, props.context)), { math: false, html: false }, EXTENSIONS);
    return { ...d, blocks: ghBlocks(d.blocks) };
  };
  return (
    <TextView
      document={doc()}
      selectable
      onLinkPress={({ url }) => { if (/^(https?|mailto):/i.test(url)) void openUrl(url).catch(() => {}); }}
      renderCustom={(node) => <Custom node={node} small={small} />}
      styles={{
        root: { gap: 8, fontSize, lineHeight, color: small ? colors.muted : colors.text },
        code: { fontFamily: MONO, fontSize: small ? 13 : 14.5, color: colors.text, backgroundColor: alpha(colors.text, 0.07) },
        emphasis: { fontStyle: "normal", fontWeight: "600" },
        link: { color: colors.info },
      }}
    />
  );
}

function Media(props: { hub: Hub; path: string }) {
  const src = mediaUrl(props.hub.cfg.url, props.hub.cfg.token, props.path);
  const ratio = signal(16 / 10);
  const zoomed = signal(false);
  const frame: ViewStyle = { borderRadius: radius.inset, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inset };
  if (isVideo(props.path)) return <Video src={src} controls paused style={{ ...frame, width: "100%", maxWidth: 480, aspectRatio: 16 / 9 }} />;
  // a thumbnail that keeps the timeline readable; press it to see the full image
  const THUMB = 240;
  const size = () => (ratio() >= 1 ? { width: THUMB, height: THUMB / ratio() } : { width: THUMB * ratio(), height: THUMB });
  return (
    <>
      <View accessibilityLabel="查看大图" onPress={() => zoomed.set(true)} style={{ cursor: "pointer" }}>
        <Image
          src={src}
          onLoad={({ size }) => size.width && size.height && ratio.set(size.width / size.height)}
          style={{ ...frame, ...size(), objectFit: "cover" }}
        />
      </View>
      <Dialog
        open={zoomed()}
        animation="fade"
        onOpenChange={({ open }) => !open && zoomed.set(false)}
        backdropClass="bg-scrim"
        style={{ flex: 1, padding: 24, pointerEvents: "box-none" }}
      >
        <View accessibilityLabel="关闭大图" onPress={() => zoomed.set(false)} style={{ flex: 1, alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
          <Image src={src} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </View>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- timeline

/** A message the owner sent that the hub has not confirmed yet (optimistic send). */
type Outgoing = { id: string; ts: string; text: string; ref: string | null; files: Attachment[]; state: "held" | "sending" | "failed" };

/** Each agent's own color and mark, the same everywhere it appears (stable by its id). */
const MARKS = ["★", "◆", "▲", "●", "✦", "☾", "✿", "♪"];
function persona(from: string): { tint: string; mark: string } {
  const id = from.split("@")[0].toLowerCase();
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { tint: token(`agent-${(h % 8) + 1}` as "agent-1"), mark: MARKS[(h >>> 3) % MARKS.length] };
}

function Avatar(props: { from: string }) {
  const hubbed = isHub(props.from);
  const p = persona(props.from);
  return (
    <View
      accessibilityLabel={displayName(props.from)}
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hubbed ? colors.raised : alpha(p.tint, 0.16),
      }}
    >
      <If when={hubbed} else={
        <>
          <Text style={{ fontSize: 16, fontWeight: "700", color: p.tint }}>{displayName(props.from).slice(0, 1).toUpperCase()}</Text>
          <View style={{ position: "absolute", right: -3, bottom: -3, width: 17, height: 17, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
            <Text style={{ fontSize: 10, lineHeight: 12, color: p.tint }}>{p.mark}</Text>
          </View>
        </>
      }>
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.muted }} />
      </If>
    </View>
  );
}

/** The label of an option button: the option's own text when the hub gives one ("B: 升级"). */
function optionText(e: HubEvent, c: string): string {
  if (c === "all" || c === "none") return choiceLabel(c);
  const full = (e.options ?? []).find((o) => new RegExp(`^\\s*${c}\\s*([:：.、)]|\\s)`).test(o));
  // a button can't hold a link: a GitHub PR / issue URL reads as "nsh#747"
  return full ? full.trim().replace(/https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/(?:pull|issues)\/(\d+)\/?/g, "$1#$2") : choiceLabel(c);
}

type Proposal = { n: string; title: string; agent: string; note: string };
/** The items of an approval batch, from either message format ("1. [agent] title (source)" or "1. 标题（agent）"). */
function proposalsOf(text: string): Proposal[] {
  const out: Proposal[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\\\s*$/, "").replace(/\*\*/g, "").trim();
    const m = line.match(/^(\d+)[.、]\s*(.+)$/);
    if (!m) continue;
    let rest = m[2], agent = "", note = "";
    const a = rest.match(/^\[([\w-]+)\]\s*/);
    if (a) { agent = a[1]; rest = rest.slice(a[0].length); }
    const src = rest.match(/\s*[(（]((?:routine|followup|approved)[^)）]*)[)）]\s*$/);
    if (src) {
      rest = rest.slice(0, src.index);
      const [kind, ref] = src[1].split(":");
      note = kind === "routine" ? "例行任务" : kind === "followup" && ref ? `接着 ${ref}` : "";
    }
    const who = rest.match(/\s*[(（]([\w-]+)[)）]\s*$/);
    if (!agent && who) { agent = who[1]; rest = rest.slice(0, who.index); }
    rest = rest.replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*$/, "").trim();
    out.push({ n: m[1], title: rest, agent, note });
  }
  return out;
}

/** An approval batch as a checklist: tick what may start, then approve. */
function ProposalList(props: { event: HubEvent; done: boolean; onAnswer: (ref: string, choice: string) => void; onReply: (ref: string) => void }) {
  const e = props.event;
  const items = proposalsOf(e.text);
  const picked = signal<Set<string>>(new Set());
  const toggle = (n: string) => picked.update((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const answer = (c: string) => props.onAnswer(e.ref!, c);
  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
        <Text style={{ fontSize: size.small, color: colors.muted }}>{`团队想做这 ${items.length} 件事，勾选同意开始的：`}</Text>
      </View>
      <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
        <Each of={items}>
          {(it) => {
            const on = () => picked().has(it().n);
            return (
              <View
                role="checkbox"
                accessibilityState={{ checked: on() }}
                accessibilityLabel={it().title}
                testID={`proposal-${e.ref}-${it().n}`}
                onPress={props.done ? undefined : () => toggle(it().n)}
                hoverStyle={props.done ? undefined : { backgroundColor: alpha(colors.text, 0.04) }}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8, cursor: props.done ? "default" : "pointer" }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: on() ? 0 : 1.5, borderColor: colors.fieldBorder, backgroundColor: on() ? colors.accentFill : "transparent", alignItems: "center", justifyContent: "center" }}>
                  <If when={on()}><Icon name="check" size={14} tint={colors.onAccent} /></If>
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={{ numberOfLines: 2, fontSize: size.text, lineHeight: 22, color: colors.text, cursor: "pointer" }}>{it().title}</Text>
                  <Text style={{ fontSize: size.tiny, color: colors.faint, cursor: "pointer" }}>{[it().agent && displayName(it().agent), it().note].filter(Boolean).join(" · ")}</Text>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={!props.done}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 16 }}>
          <Btn testID={`approve-${e.ref}`} label={picked().size ? `批准所选（${picked().size}）` : "批准所选"} kind="primary" disabled={!picked().size}
            onPress={() => answer([...picked()].sort((a, b) => +a - +b).join(","))} />
          <Btn testID={`opt-${e.ref}-all`} label="全部批准" kind="secondary" onPress={() => answer("all")} />
          <Btn testID={`opt-${e.ref}-none`} label="都不要" kind="ghost" onPress={() => answer("none")} />
          <View style={{ flex: 1 }} />
          <Btn label="其他指示…" kind="dashed" onPress={() => props.onReply(e.ref!)} />
        </View>
      </If>
    </>
  );
}

/** An answer to a card, as plain words: "P-0002 6,7,8" → "批准 6、7、8". */
/** The answer that sets a question aside (the hub's decisions.IGNORE). */
const IGNORE = "忽略";

function answerText(t: string): string {
  const [, ref, rest] = t.match(/^([DLP]-[A-Z]?\d{4}) (.+)$/) ?? [, "", t];
  const a = rest.trim();
  if (ref.startsWith("P-")) {
    if (/^(all|全部)$/i.test(a)) return "全部批准";
    if (/^(none|都不要)$/i.test(a)) return "都不要";
    if (/^\d+(\s*[,，]\s*\d+)*$/.test(a)) return `批准 ${a.split(/\s*[,，]\s*/).join("、")}`;
  }
  return a === IGNORE ? IGNORE : `选 ${a}`;
}

/** The first line of a card's text, as plain words: what an answer replies to. */
function askLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`_]/g, "").replace(/\\$/, "").trim();
}

function OwnerBubble(props: { hub: Hub; event: HubEvent; out?: Outgoing; onRetry?: () => void; onUndo?: () => void; onRef?: (ref: string) => void }) {
  const e = props.event;
  // an answer sent from the sidebar or a card ("D-0015 忽略") names its card in the text, not in `ref`
  const ref = e.ref ?? e.text.match(/^([DLP]-[A-Z]?\d{4}) \S/)?.[1];
  const asked = () => (ref ? askLine(props.hub.events().find((x) => x.ref === ref && isAsk(x))?.text ?? "") || (props.hub.status()?.decisions.find((d) => d.id === ref)?.question ?? "") : "");
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingVertical: 8 }}>
      <View style={{ maxWidth: "82%", alignItems: "flex-end", gap: 4 }}>
        {/* what this answers, quoted above the bubble (press: back to the card) */}
        <If when={ref}>
          <View
            role="link"
            testID={`reply-to-${ref}`}
            onPress={() => props.onRef?.(ref!)}
            hoverStyle={{ opacity: 1 }}
            style={{ cursor: "pointer", opacity: 0.85, flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", paddingLeft: 8, paddingRight: 4, borderLeftWidth: 2, borderLeftColor: colors.fieldBorder }}
          >
            <Text style={{ ...chipText, fontFamily: MONO, fontSize: 12, color: colors.muted }}>{ref}</Text>
            <If when={asked()}>
              <Text style={{ ...chipText, flexShrink: 1, numberOfLines: 1, fontSize: 13, color: colors.faint }}>{asked()}</Text>
            </If>
          </View>
        </If>
        <If when={e.attachments?.length}>
          <View testID="owner-images" style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, opacity: props.out ? 0.65 : 1 }}>
            <Each of={e.attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} />}</Each>
          </View>
        </If>
        <If when={e.text.trim() || e.ref}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 11,
            borderRadius: 18,
            borderBottomRightRadius: 6,
            backgroundColor: tints.accent,
            opacity: props.out ? 0.65 : 1,
            gap: 4,
          }}
        >
          {/^[DLP]-[A-Z]?\d{4} \S/.test(e.text) && !e.text.includes("\n")
            ? <Text style={{ fontSize: size.text, lineHeight: size.line, color: colors.text, userSelect: "text" }}>{answerText(e.text)}</Text>
            : <Rich text={e.text} />}
        </View>
        </If>
        <If
          when={props.out}
          else={<Text style={{ fontSize: size.tiny, color: colors.faint }}>{timeOf(e.ts)}</Text>}
        >
          <If when={props.out?.state === "held"}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ fontSize: size.tiny, color: colors.faint }}>即将发送</Text>
              <Btn label="撤销" kind="ghost" kbd={touch ? undefined : keymap.label("mod+z")} onPress={() => props.onUndo?.()} testID="undo-send" />
            </View>
          </If>
          <If when={props.out?.state !== "held"}>
          <If when={props.out?.state === "failed"} else={<Text style={{ fontSize: size.tiny, color: colors.faint }}>发送中…</Text>}>
            <View role="button" onPress={props.onRetry} accessibilityLabel="重试发送" style={{ flexDirection: "row", gap: 6 }}>
              <Text style={{ fontSize: size.tiny, color: colors.danger }}>发送失败</Text>
              <Text style={{ fontSize: size.tiny, fontWeight: "600", color: colors.danger }}>重试</Text>
            </View>
          </If>
          </If>
        </If>
      </View>
    </View>
  );
}

function Message(props: {
  hub: Hub;
  event: HubEvent;
  answered: () => Set<string>;
  /** The pending ask the keyboard acts on. */
  target: () => string | null;
  onAnswer: (ref: string, choice: string) => void;
  onReply: (ref: string) => void;
  cardRef?: (r: ViewRef) => void;
}) {
  const e = props.event;
  const ask = isAsk(e);
  const tag = TAGS[e.kind];
  const body = (
    <View selectable style={{ gap: 10 }}>
      <Rich text={ask ? e.text.replace(/\n*^建议：.*$/m, "").trimEnd() : e.text} muted={e.kind === "system"} context={(e.options ?? []).join("\n")} />
      <If when={e.attachments?.length}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Each of={e.attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} />}</Each>
        </View>
      </If>
    </View>
  );
  const done = () => !!e.ref && props.answered().has(e.ref);
  const targeted = () => ask && !done() && props.target() === e.ref;
  const rec = recommended(e);
  if (isHub(e.from) && !ask && e.kind === "system" && !e.attachments?.length)
    return (
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 4, paddingLeft: 50 }} ref={(r) => props.cardRef?.(r)}>
        <Text style={{ fontSize: size.tiny, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
        <View selectable style={{ flex: 1, minWidth: 0 }}><Rich text={e.text} quiet /></View>
      </View>
    );
  return (
    <View style={{ flexDirection: "row", gap: 14, paddingVertical: 10 }} ref={(r) => props.cardRef?.(r)}>
      <Avatar from={e.from} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 }}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{displayName(e.from)}</Text>
          <Text style={{ fontSize: size.tiny, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
          {tag && !ask ? <Badge label={tag} /> : null}
        </View>
        {ask ? (
          <View
            style={{
              marginTop: 6,
              borderRadius: radius.card,
              backgroundColor: colors.surface,
              opacity: done() ? 0.62 : 1,
              overflow: "hidden",
              transitionProperty: "opacity",
              transitionDuration: 160,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 12 }}>
              <Badge label={tag ?? "需要你"} tone={done() ? "neutral" : "warn"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{e.ref}</Text>
              <View style={{ flex: 1 }} />
              <If when={done()}>
                <Text style={{ fontSize: 13, color: colors.up }}>✓ 已回复</Text>
              </If>
            </View>
            {e.kind === "proposals" && proposalsOf(e.text).length ? (
              <ProposalList event={e} done={done()} onAnswer={props.onAnswer} onReply={props.onReply} />
            ) : (
            <>
            <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 }}>{body}</View>
            {/* one option per line: options are sentences, side by side they read as a jumble */}
            <View style={{ alignItems: "flex-start", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 16 }}>
              <Each of={choicesOf(e).slice(0, 12)}>
                {(c, i) => (
                  <Btn
                    testID={`opt-${e.ref}-${c()}`}
                    label={optionText(e, c())}
                    kind="secondary"
                    note={rec === c() ? "推荐" : undefined}
                    onPress={() => props.onAnswer(e.ref!, c())}
                  />
                )}
              </Each>
              <Btn label="其他指示…" kind="dashed" onPress={() => props.onReply(e.ref!)} />
              <If when={e.ref!.startsWith("D-") && !done()}>
                <Btn testID={`ignore-${e.ref}`} label="忽略" kind="dashed" onPress={() => props.onAnswer(e.ref!, IGNORE)} />
              </If>
            </View>
            </>
            )}
          </View>
        ) : (
          body
        )}
      </View>
    </View>
  );
}

/** A task's state as the sidebar's dot: only what needs attention gets a color. */
const TONE: Record<string, "on" | "run" | "queue" | "wait" | "off" | "bad"> = { active: "run", blocked: "wait", failed: "bad", done: "off", inbox: "queue", waiting: "wait", nohost: "wait", parked: "wait" };

/** A task's state: its label, color and mark. */
const STATE_OF = (): Record<string, [string, string, string]> => ({
  active: ["进行中", colors.up, "●"], inbox: ["排队中", colors.info, "○"], waiting: ["等子任务", colors.warn, "○"], nohost: ["等机器", colors.warn, "○"], parked: ["等外部结果", colors.warn, "○"],
  blocked: ["等你决定", colors.warn, "!"], failed: ["失败", colors.danger, "✕"], done: ["完成", colors.faint, "✓"],
});

/** A progress step's icon and color. */
const STEP_OF = (): Record<string, [IconName, string]> => ({
  chat: ["chat", colors.muted], start: ["play", colors.info], done: ["check", colors.up], fail: ["close", colors.danger],
  decision: ["pause", colors.warn], retry: ["replace", colors.muted], followup: ["plus", colors.muted],
  delegated: ["layers", colors.info], judge: ["sliders", colors.muted], edit: ["document", colors.muted],
});

/** "11-02 16:34", or "16:34" today. */
function clock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${p(d.getMonth() + 1)}-${p(d.getDate())} `}${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "3 分钟" since an ISO time (to now, or to `end`). */
function since(iso?: string, end?: string): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(iso)) / 60000));
  return m < 1 ? "刚刚" : m < 60 ? `${m} 分钟` : m < 1440 ? `${Math.floor(m / 60)} 小时` : `${Math.floor(m / 1440)} 天`;
}

function TaskDetail(props: { hub: Hub; id: string; wide: boolean }) {
  const t = () => {
    const s = props.hub.status();
    return [...(s?.active ?? []), ...(s?.recent ?? [])].find((x) => x.id === props.id);
  };
  const section = (title: string) => (
    <Text role="header" style={{ fontSize: 13, fontWeight: "600", color: colors.muted, marginTop: 24, marginBottom: 8 }}>{title}</Text>
  );
  const cancellable = () => ["active", "inbox", "nohost", "waiting", "blocked", "proposed"].includes(t()?.state ?? "");
  const cancelling = signal(false);
  async function cancel() {
    const running = t()?.state === "active";
    const r = await AlertDialog.show({
      title: `取消 ${props.id}？`,
      description: running ? "正在运行的 agent 会被停下，已经做了的改动保留在仓库里。" : "这个任务不会再执行。",
      actions: [
        { id: "keep", label: "不取消", role: "cancel" },
        { id: "cancel", label: "取消任务", role: "destructive" },
      ],
    });
    if (r.action !== "cancel") return;
    cancelling.set(true);
    try { await props.hub.api("POST", "/api/tasks/cancel", { id: props.id }); }
    catch { cancelling.set(false); }
  }
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 24 }}>
        <If when={t()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{`${props.id} 已经不在最近的任务里了。`}</Text>}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Badge label={t()!.state === "nohost" ? `等 ${needsLabel(t()!.needs)}` : STATE_OF()[t()!.state ?? ""]?.[0] ?? t()!.state ?? ""} tone={t()!.state === "failed" ? "danger" : t()!.state === "blocked" ? "warn" : "neutral"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{t()!.id}</Text>
              <View style={{ flex: 1 }} />
              <If when={cancellable() && !cancelling()}>
                <Btn testID="cancel-task" label="取消任务" kind="ghost" icon="close" onPress={() => void cancel()} />
              </If>
              <If when={cancelling()}>
                <Text style={{ fontSize: 13, color: colors.muted }}>正在取消…</Text>
              </If>
            </View>
            <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{t()!.title}</Text>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {[displayName(t()!.agent), t()!.host, t()!.model ?? t()!.cli,
                t()!.started ? `${clock(t()!.started!)} 开始` : "",
                t()!.state === "active" ? `已运行 ${since(t()!.started)}` : t()!.finished ? `用时 ${since(t()!.started, t()!.finished)}` : "",
                Number(t()!.attempt ?? 1) > 1 ? `第 ${t()!.attempt} 次` : ""].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <If when={t()!.state === "active" ? activityLine(t()!.activity) : null}>
            {(a) => (
              <Text testID="task-activity" style={{ marginTop: 10, fontSize: 13.5, lineHeight: 19, color: a().quiet ? colors.warn : colors.muted }}>{a().text}</Text>
            )}
          </If>
          <If when={t()!.state === "nohost"}>
            <View testID="task-nohost" style={{ marginTop: 16, paddingHorizontal: 14, paddingVertical: 11, borderRadius: radius.inset, backgroundColor: tints.warn }}>
              <Text style={{ fontSize: 14, lineHeight: 21, color: colors.text }}>
                {`现在没有在线的 ${needsLabel(t()!.needs)}，其他机器闲着也接不了它。有 ${needsLabel(t()!.needs)} 上线后会自动开始；用不上的话可以取消。`}
              </Text>
            </View>
          </If>
          <If when={t()!.request}>
            {section("请求")}
            <View selectable><Rich text={t()!.request ?? ""} /></View>
          </If>
          <If when={t()!.runs?.length}>
            {section("结果")}
            <View style={{ gap: 12 }}>
              <Each of={[...(t()!.runs ?? [])].reverse()}>
                {(r) => (
                  <View style={{ gap: 4 }}>
                    <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${r().ts.slice(5, 16).replace("T", " ")} · ${r().host} · ${r().status}`}</Text>
                    <Rich text={r().summary} />
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={t()!.steps?.length}>
            {section("进度")}
            <View selectable style={{ gap: 6 }}>
              <Each of={t()!.steps ?? []}>
                {(st) => (
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                    <Text style={{ width: 44, fontSize: 13.5, lineHeight: 21, color: colors.faint, fontVariant: ["tabular-nums"] }}>{st().time ?? ""}</Text>
                    <View style={{ width: 12, height: 21, alignItems: "center", justifyContent: "center" }}>
                      <Dot tone={st().kind === "done" ? "off" : st().kind === "fail" ? "bad" : st().kind === "decision" ? "wait" : "off"} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}><Rich text={st().text.replace(new RegExp(`^${t()!.id}\\b\\s*(→\\s*)?[:：]?\\s*`), "")} muted /></View>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}

/** A short horizontal meter: how full something is, 0..100. */
function Meter(props: { pct: number; tone?: "up" | "warn" | "danger" }) {
  const fill = () => ({ up: colors.up, warn: colors.warn, danger: colors.danger })[props.tone ?? "up"];
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.raised, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(100, props.pct))}%`, height: 6, borderRadius: 3, backgroundColor: fill() }} />
    </View>
  );
}

const ACCOUNT_STATE: Record<string, [string, "neutral" | "warn" | "danger"]> = { ok: ["可用", "neutral"], cooldown: ["冷却中", "warn"], login: ["需要登录", "danger"] };

const ago = (iso?: string) => { const s = since(iso); return s === "刚刚" || !s ? s : `${s}前`; };

function MachineDetail(props: { hub: Hub; host: string; wide: boolean; onTask: (id: string) => void }) {
  const h = () => props.hub.status()?.hosts.find((x) => x.host === props.host);
  const section = (title: string) => (
    <Text role="header" style={{ fontSize: 13, fontWeight: "600", color: colors.muted, marginTop: 24, marginBottom: 8 }}>{title}</Text>
  );
  const stat = (label: string, value: string, pct: number, tone: "up" | "warn" | "danger") => (
    <View style={{ flex: 1, minWidth: 140, gap: 6, padding: 12, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line }}>
      <Text style={{ fontSize: 13, color: colors.muted }}>{label}</Text>
      <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Meter pct={pct} tone={tone} />
    </View>
  );
  const load = () => loadOf(h()!);
  const memUsed = () => 100 - (h()!.stats?.memFreePct ?? 100);
  const diskUsed = () => 100 - (h()!.stats?.diskFreePct ?? 100);
  const toneOf = (pct: number): "up" | "warn" | "danger" => (pct >= 90 ? "danger" : pct >= 70 ? "warn" : "up");
  const row = (id: string, title: string, right: string, mark?: JSX.Element) => (
    <View
      role="button"
      accessibilityLabel={`${id} ${title}`}
      onPress={() => props.onTask(id)}
      hoverStyle={hovered()}
      style={{ minHeight: size.row, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 7 }}
    >
      {mark}
      <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{id}</Text>
      <Text style={{ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{title}</Text>
      <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{right}</Text>
    </View>
  );
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 24 }}>
        <If when={h()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{`${props.host} 现在不在线。`}</Text>}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Dot tone="on" />
              <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{h()!.host}</Text>
            </View>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {["在线", [h()!.os ?? osOf(h()!), h()!.arch].filter(Boolean).join(" "), h()!.seen ? `心跳 ${ago(h()!.seen)}` : "", `${h()!.busy ?? 0} 个运行中`].filter(Boolean).join(" · ")}
            </Text>
            <If when={h()!.rev}>
              <RevLink host={h()!} />
            </If>
          </View>
          {section("资源")}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {stat("负载", `${load()}%${h()!.stats?.cores ? ` · ${h()!.stats!.cores} 核` : ""}`, load(), toneOf(load()))}
            {stat("内存", h()!.stats?.memFreePct != null ? `已用 ${memUsed()}%` : "未知", memUsed(), toneOf(memUsed()))}
            {stat("磁盘", `剩余 ${h()!.stats?.diskFreeGB ?? "?"} GB`, diskUsed(), toneOf(diskUsed()))}
          </View>
          <If when={h()!.clis?.length || h()!.accounts?.length}>
            {section("工具与账号")}
            <View style={{ gap: 8 }}>
              <If when={h()!.clis?.length}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <Each of={h()!.clis ?? []}>{(c) => <Badge label={c()} />}</Each>
                </View>
              </If>
              <Each of={h()!.accounts ?? []}>
                {(a) => (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <Text style={{ flex: 1, fontSize: 14.5, color: colors.text }}>{`${a().cli} · ${a().name}`}</Text>
                    <Badge label={`${ACCOUNT_STATE[a().state]?.[0] ?? a().state}${a().until ? ` 至 ${a().until!.slice(11, 16)}` : ""}`} tone={ACCOUNT_STATE[a().state]?.[1] ?? "neutral"} />
                  </View>
                )}
              </Each>
            </View>
          </If>
          {section("运行中")}
          <If when={h()!.running?.length} else={<Text style={{ fontSize: 14, color: colors.faint }}>空闲</Text>}>
            <View>
              <Each of={h()!.running ?? []} key={(t) => t.id}>
                {(t) => row(t().id, t().title, [displayName(t().agent), since(t().started), activityLine(t().activity)?.text].filter(Boolean).join(" · "), <Dot tone="run" />)}
              </Each>
            </View>
          </If>
          {section("最近")}
          <If when={h()!.recent?.length} else={<Text style={{ fontSize: 14, color: colors.faint }}>还没有完成的任务</Text>}>
            <View>
              <Each of={h()!.recent ?? []} key={(t) => t.id}>
                {(t) => row(t().id, t().title, t().finished ? ago(t().finished) : "",
                  <Text style={{ width: 14, fontSize: 13, color: STATE_OF()[t().state ?? ""]?.[1] ?? colors.faint }}>{STATE_OF()[t().state ?? ""]?.[2] ?? "·"}</Text>)}
              </Each>
            </View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- sidebar

function SideHeading(props: { title: string; count?: number | string; accent?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
      <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: colors.muted, letterSpacing: 0.4 }}>{props.title}</Text>
      <If when={props.count}>
        <If when={props.accent} else={<Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{String(props.count)}</Text>}>
          <View style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onAccent }}>{String(props.count)}</Text>
          </View>
        </If>
      </If>
    </View>
  );
}

function SideEmpty(props: { text: string }) {
  return <Text style={{ fontSize: 13.5, color: colors.faint, paddingHorizontal: 20, paddingVertical: 6 }}>{props.text}</Text>;
}

/** A sidebar row: the gallery's SidebarRow, at 34 pt (44 on touch). */
function SideRow(props: { onPress?: () => void; selected?: boolean; title?: string; children: JSX.Element }) {
  return (
    <View
      onPress={props.onPress}
      role={props.onPress ? "button" : undefined}
      accessibilityLabel={props.title}
      tooltip={props.title && !props.onPress ? <Tip label={props.title} placement="right" /> : undefined}
      hoverStyle={props.onPress && !props.selected ? hovered() : undefined}
      style={{
        minHeight: size.row,
        marginHorizontal: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 10,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: props.selected ? colors.border : "transparent",
        backgroundColor: props.selected ? colors.sidebarSelected : "transparent",
      }}
    >
      {props.children}
    </View>
  );
}

function Sidebar(props: {
  hub: Hub;
  target: () => string | null;
  onPick: (ref: string) => void;
  /** Set a question aside: it leaves 待你决定 and is not asked again. */
  onIgnore: (ref: string) => void;
  task: () => string | null;
  onTask: (id: string) => void;
  machine: () => string | null;
  onMachine: (host: string) => void;
  onSettings: () => void;
  rules: () => boolean;
  onRules: () => void;
  onHelp: () => void;
  onClose?: () => void;
  chrome?: boolean;
  onCollapse?: () => void;
  home: () => boolean;
  onHome: () => void;
}) {
  const s = () => props.hub.status();
  // the hub closes a decision on its next tick: one the channel already shows answered leaves the list now
  const waits = computed(() => { const done = answeredIds(props.hub.events()); return waiting(s()).filter((d) => !done.has(d.id)); });
  const queue = () => {
    const q = s()?.tasks;
    return [
      ["待批准", q?.proposed],
      ["排队", q?.inbox],
      ["阻塞", q?.blocked],
      ["失败", q?.failed],
      ["完成", q?.done],
    ] as const;
  };
  const rowText = () => ({ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }) as const;
  return (
    <View style={{ flex: 1, backgroundColor: colors.sidebar }}>
      <View
        desktop={{ windowDrag: true }}
        style={{ height: size.bar, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: (props.chrome && hasWindow ? titleBar().left : 0) + 18, paddingRight: 10 }}
      >
        <Mark size={24} />
        <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>noop</Text>
        <If when={props.onClose}>
          <ToolButton icon="close" label="收起菜单" onPress={() => props.onClose?.()} />
        </If>
        <If when={props.onCollapse}>
          <ToolButton icon="sidebar" label="隐藏侧栏" shortcut={keymap.label("mod+b")} onPress={() => props.onCollapse?.()} />
        </If>
      </View>
      <Scroll style={{ flex: 1 }}>
        <View style={{ paddingBottom: 16, gap: 1 }}>
          <View style={{ paddingTop: 8 }}>
            <SideRow onPress={props.onHome} selected={props.home()} title="团队频道">
              <Icon name="chat" size={17} tint={props.home() ? colors.text : colors.muted} />
              <Text style={{ ...rowText(), fontWeight: "600" }}>团队频道</Text>
              <If when={waits().length}>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${waits().length} 待决定`}</Text>
              </If>
            </SideRow>
            <SideRow onPress={props.onRules} selected={props.rules()} title="团队规则与记忆">
              <Icon name="scroll" size={17} tint={props.rules() ? colors.text : colors.muted} />
              <Text style={rowText()}>团队规则与记忆</Text>
            </SideRow>
          </View>
          <SideHeading title="待你决定" count={waits().length || undefined} accent />
          <Each of={waits()} key={(d) => d.id}>
            {(d) => (
              <ContextMenu
                margin={8}
                popupStyle={{ minWidth: 160, padding: 4, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}
                trigger={
                  <SideRow onPress={() => props.onPick(d().id)} title={d().id}>
                    <Dot tone="wait" />
                    <Text style={rowText()}>{d().question || d().id}</Text>
                    <Text style={{ fontFamily: MONO, fontSize: 12, color: colors.faint }}>{d().id}</Text>
                  </SideRow>
                }
              >
                <MenuItem
                  testID={`side-ignore-${d().id}`}
                  onSelect={() => props.onIgnore(d().id)}
                  hoverStyle={hovered()}
                  style={{ height: 32, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6 }}
                >
                  <Text style={{ fontSize: 14, color: colors.text }}>忽略，不用处理</Text>
                </MenuItem>
              </ContextMenu>
            )}
          </Each>
          <If when={!waits().length}>
            <SideEmpty text="没有待办，团队在自己推进" />
          </If>

          <SideHeading title="进行中" count={s()?.active.length || undefined} />
          <Each of={s()?.active ?? []} key={(a) => a.id}>
            {(a) => (
              <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${a().agent}${a().host ? ` @ ${a().host}` : ""}`}>
                <Dot tone="run" />
                <Text style={rowText()}>{a().title}</Text>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().started)}</Text>
              </SideRow>
            )}
          </Each>
          <If when={!s()?.active.length}>
            <SideEmpty text="空闲" />
          </If>

          <If when={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)).length}>
            <SideHeading title="排队" count={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)).length} />
            <Each of={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state))} key={(a) => a.id}>
              {(a) => (
                <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${STATE_OF()[a().state ?? ""]?.[0] ?? ""}`}>
                  <Dot tone={TONE[a().state ?? ""] ?? "off"} />
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{a().state === "waiting" ? "等子任务" : a().state === "nohost" ? `等 ${needsLabel((a() as { needs?: string }).needs)}` : "排队中"}</Text>
                </SideRow>
              )}
            </Each>
          </If>
          <If when={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && !isQueued(t.state)).slice(0, 6).length}>
            <SideHeading title="最近" />
            <Each of={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && !isQueued(t.state)).slice(0, 6)} key={(a) => a.id}>
              {(a) => (
                <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${STATE_OF()[a().state ?? ""]?.[0] ?? ""}`}>
                  <Dot tone={TONE[a().state ?? ""] ?? "off"} />
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().updated)}</Text>
                </SideRow>
              )}
            </Each>
          </If>

          <SideHeading title="机器" count={s()?.hosts.length || undefined} />
          <Each of={s()?.hosts ?? []} key={(h) => h.host}>
            {(h) => (
              <SideRow onPress={() => props.onMachine(h().host)} selected={props.machine() === h().host} title={`负载 ${loadOf(h())}% · 磁盘 ${h().stats?.diskFreeGB ?? "?"}GB · ${h().busy ?? 0} 个运行中`}>
                <Dot tone="on" />
                <Text style={rowText()}>{h().host}</Text>
                <If when={(h().busy ?? 0) > 0}>
                  <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${h().busy} 运行中`}</Text>
                </If>
              </SideRow>
            )}
          </Each>
          <If when={!s()?.hosts.length}>
            <SideEmpty text="没有在线机器" />
          </If>

          <If when={queue().some((q) => q[1] && q[0] !== "完成" && q[0] !== "待批准")}>
            <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingTop: 18, fontVariant: ["tabular-nums"] }}>
              {queue().filter((q) => q[1] && q[0] !== "完成" && q[0] !== "待批准").map((q) => `${q[0]} ${q[1]}`).join(" · ")}
            </Text>
          </If>
        </View>
      </Scroll>
      <View
        style={{
          minHeight: 56,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingLeft: 18,
          paddingRight: 10,
          paddingBottom: touch ? safeArea().bottom : 0,
          borderTopWidth: 1,
          borderTopColor: colors.sidebarBorder,
        }}
      >
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>团队频道</Text>
          <Text style={{ fontSize: 12, color: colors.muted, numberOfLines: 1 }}>{props.hub.cfg.url.replace(/^https?:\/\//, "")}</Text>
        </View>
        <If when={!touch}>
          <ToolButton icon="tooltip" label="快捷键" shortcut="?" onPress={props.onHelp} />
        </If>
        <ToolButton icon={isDark() ? "sun" : "moon"} label={isDark() ? "浅色外观" : "深色外观"} onPress={toggleTheme} testID="theme" />
        <ToolButton icon="sliders" label="设置" shortcut={keymap.label("mod+,")} onPress={props.onSettings} testID="settings" />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- team settings

function Chip(props: { label: string; on: boolean; onPress: () => void; testID?: string; accessibilityLabel?: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      hoverStyle={props.on ? undefined : hovered()}
      focusStyle={focusRing()}
      style={{
        minHeight: touch ? 40 : 34,
        minWidth: 34,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: 12,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: props.on ? alpha(colors.accent, 0.5) : colors.border,
        backgroundColor: props.on ? tints.accent : colors.surface,
        transitionProperty: "background-color, border-color",
        transitionDuration: 120,
      }}
    >
      <Text style={{ fontSize: 14, fontWeight: props.on ? "600" : "400", color: props.on ? colors.accent : colors.text }}>{props.label}</Text>
    </View>
  );
}

/** A settings section: the gallery's Card (a title above one flat surface). */
const AUTONOMY_DETAIL: Record<string, string> = {
  onboarding: "大多数事先问你，从你的回答里学习",
  assisted: "常规的事自己做，重要的先问你",
  autonomous: "自己拿主意，只有高风险的事才问你",
};
const cliDetail = (c: string[]) =>
  c.length === 1 ? `只用 ${cliLabel([c[0]!]).replace(/^仅\s*/, "")}` : `先用 ${cliLabel([c[0]!]).replace(/^仅\s*/, "")}，失败或额度用尽时换 ${cliLabel([c[1]!]).replace(/^仅\s*/, "")}`;

type DropdownOption = { id: string; label: string; detail?: string; testID?: string };

/** A labelled value that opens a menu of its choices (each with a line saying what it means). */
function Dropdown(props: { label: string; value: string; options: DropdownOption[]; selected: string; onPick: (id: string) => void; testID?: string }) {
  return (
    <Menu
      align="end"
      offset={6}
      margin={8}
      popupStyle={{ minWidth: 260, maxWidth: 340, padding: 4, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}
      trigger={
        <View
          role="button"
          testID={props.testID}
          accessibilityLabel={`${props.label}：${props.value}`}
          hoverStyle={hovered()}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingLeft: 11, paddingRight: 9, borderRadius: radius.control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}
        >
          <Text style={{ fontSize: 13, color: colors.faint }}>{props.label}</Text>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{props.value}</Text>
          <Icon name="chevron-down" size={12} tint={colors.muted} />
        </View>
      }
    >
      <Each of={props.options}>
        {(o) => (
          <MenuItem
            testID={o().testID}
            role="menuitemradio"
            checked={o().id === props.selected}
            onSelect={() => o().id !== props.selected && props.onPick(o().id)}
            hoverStyle={hovered()}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 6 }}
          >
            <View style={{ width: 14, paddingTop: 3 }}>
              <If when={o().id === props.selected}>
                <Icon name="check" size={13} tint={colors.text} />
              </If>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{o().label}</Text>
              <If when={o().detail}>
                <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.muted }}>{o().detail}</Text>
              </If>
            </View>
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}

function Group(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.hint ? <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>{props.hint}</Text> : null}
      </View>
      <View style={{ borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>{props.children}</View>
    </View>
  );
}

// ---------------------------------------------------------------- notifications (Web Push through host.js)

type PushInfo = { supported: boolean; ios: boolean; standalone: boolean; permission: string; subscribed: boolean; endpoint: string | null; device: string };
type Note = { text: string; tone: "ok" | "bad" } | null;

/** This device's push state and the steps that change it (the permission prompt needs the press that calls `enable`). */
function createPush(hub: Hub) {
  const info = signal<PushInfo | null>(null);
  const busy = signal(false);
  const note = signal<Note>(null);
  const refresh = async () => info.set(await hostCall<PushInfo>("pushState"));
  refresh();

  async function run(work: () => Promise<string>) {
    busy.set(true);
    note.set(null);
    try {
      note.set({ text: await work(), tone: "ok" });
    } catch (e) {
      note.set({ text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      busy.set(false);
      await refresh();
    }
  }
  const enable = () =>
    run(async () => {
      // Ask the browser first, while the press still counts as the user's gesture.
      const v = hub.api("GET", "/api/push/vapid");
      const key = (await v).data.publicKey;
      if (typeof key !== "string" || !key) throw new Error("服务器还没有配置推送，暂时无法开启");
      const r = await hostCall<{ permission: string; subscription: unknown; device?: string }>("pushEnable", { publicKey: key });
      if (!r) throw new Error("这个环境不支持网页推送");
      if (r.permission === "denied") throw new Error("通知被拦截了：请在浏览器或系统设置里允许 noop 发通知，再回来开启");
      if (r.permission !== "granted" || !r.subscription) throw new Error("没有开启通知");
      const s = await hub.api("POST", "/api/push/subscribe", { subscription: r.subscription, device_label: r.device ?? untracked(info)?.device ?? "设备" });
      if (!s.ok) throw new Error(`订阅失败（${s.status || "连不上服务器"}）`);
      return "已开启：需要你决定的事会推送到这台设备";
    });
  const disable = () =>
    run(async () => {
      const r = await hostCall<{ endpoint: string | null }>("pushDisable");
      if (r?.endpoint) await hub.api("POST", "/api/push/unsubscribe", { endpoint: r.endpoint });
      return "已关闭这台设备的通知";
    });
  const test = () =>
    run(async () => {
      const r = await hub.api("POST", "/api/push/test");
      if (!r.ok) throw new Error(`测试通知发送失败（${r.status || "连不上服务器"}）`);
      return "测试通知已发出，几秒内会到";
    });
  /** iOS shows web push only to an app added to the home screen. */
  const needsHomeScreen = () => !!info()?.ios && !info()?.standalone;
  const canAsk = () => !!info()?.supported && !needsHomeScreen();
  return { info, busy, note, refresh, enable, disable, test, needsHomeScreen, canAsk };
}
type Push = ReturnType<typeof createPush>;

function Steps(props: { steps: string[] }) {
  return (
    <View style={{ gap: 8 }}>
      <Each of={props.steps}>
        {(s, i) => (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: tints.accent }}>
              <Text style={{ fontSize: 12.5, fontWeight: "700", color: colors.accent }}>{String(i() + 1)}</Text>
            </View>
            <Text style={{ flex: 1, fontSize: 15, lineHeight: 22, color: colors.text }}>{s()}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

function NotifySettings(props: { push: Push; view: SettingsView | null; save: (patch: Record<string, unknown>) => void; wide: boolean }) {
  const push = props.push;
  const { prefs, setPrefs, state } = notifyModel(push, () => props.view, props.save);
  const row: ViewStyle = { gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.line };
  return (
    <Group title="通知" hint="需要你拍板的事推送到手机；通知上可以直接选择选项。">
      <View style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Dot tone={push.info()?.subscribed ? "on" : push.info()?.permission === "denied" ? "bad" : "off"} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text }}>{push.info()?.device ?? "本设备"}</Text>
            <Text testID="push-state" style={{ fontSize: 13.5, color: colors.muted }}>{state()}</Text>
          </View>
        </View>
        <If when={push.needsHomeScreen()}>
          <View style={{ gap: 10, padding: 14, borderRadius: radius.inset, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>在 iPhone 上开启通知</Text>
            <Steps steps={["在 Safari 里点底部的「分享」按钮", "选「添加到主屏幕」，再点「添加」", "从主屏幕打开 noop，登录后回到这里点「开启通知」"]} />
          </View>
        </If>
        <If when={push.info()?.permission === "denied" && !push.needsHomeScreen()}>
          <Text style={{ fontSize: 14, lineHeight: 21, color: colors.muted }}>在浏览器的网站设置（或系统设置 → 通知）里允许 noop，然后刷新页面再开启。</Text>
        </If>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <If
            when={push.info()?.subscribed}
            else={<Btn testID="push-enable" label="开启通知" icon="bell" kind="primary" busy={push.busy()} disabled={!push.canAsk()} onPress={push.enable} />}
          >
            <Btn testID="push-test" label="发送测试通知" icon="bell" busy={push.busy()} onPress={push.test} />
            <Btn testID="push-disable" label="关闭本设备通知" kind="ghost" onPress={push.disable} />
          </If>
        </View>
        <If when={push.note()}>
          <Text testID="push-note" style={{ fontSize: 14, lineHeight: 20, color: push.note()!.tone === "ok" ? colors.up : colors.danger }}>{push.note()!.text}</Text>
        </If>
      </View>
      <If when={props.view}>
        <View style={row}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>推送哪些</Text>
          <Each of={NOTIFY_KINDS as unknown as [NotifyKind, string][]}>
            {(k) => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36 }}>
                <Text style={{ flex: 1, fontSize: 15.5, color: colors.text }}>{k()[1]}</Text>
                <Toggle
                  testID={`notify-${k()[0]}`}
                  label={k()[1]}
                  value={prefs().kinds[k()[0]]}
                  onChange={(on) => setPrefs({ kinds: { ...prefs().kinds, [k()[0]]: on } })}
                />
              </View>
            )}
          </Each>
        </View>
        <View style={row}>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>免打扰时段</Text>
            <Text style={{ fontSize: 13, color: colors.faint }}>这段时间只记下，不推送（时区 {prefs().tz}）</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Each of={QUIET_PRESETS}>
              {(q) => (
                <Chip
                  testID={`quiet-${quietKey(q().value)}`}
                  label={q().label}
                  on={quietKey(q().value) === quietKey(prefs().quiet_hours)}
                  onPress={() => setPrefs({ quiet_hours: q().value })}
                />
              )}
            </Each>
          </View>
        </View>
      </If>
    </Group>
  );
}

/** The team's settings, shared by the settings page and the pages it pushes on phones. */
function createSettings(hub: Hub) {
  const view = signal<SettingsView | null>(null);
  const error = signal("");
  const saved = signal("");
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(savedTimer));
  const load = () => {
    error.set("");
    hub.settings().then((v) => view.set(v), (e) => error.set(String(e?.message ?? e)));
  };
  async function save(patch: Record<string, unknown>) {
    error.set("");
    try {
      view.set(await hub.settings(patch));
      saved.set("已保存");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => saved.set(""), 1600);
    } catch (e) {
      error.set(e instanceof Error ? e.message : String(e));
    }
  }
  // the command being added in 常用指令 (kept here: the settings page may be laid out again while typing)
  /** The command editor: `editing` is undefined when closed, "" for a new command, else the name being edited. */
  const commandDraft = { name: signal(""), text: signal(""), editing: signal<string | undefined>(undefined), note: signal("") };
  /** The section the wide settings page shows (its sidebar picks it). */
  const tab = signal<SettingsTab>("notify");
  return { view, error, saved, load, save, commandDraft, tab };
}
type Settings = ReturnType<typeof createSettings>;

/** The sections of the wide settings page, in its sidebar's order. */
const SETTINGS_TABS = [
  ["notify", "通知", "bell"],
  ["members", "成员", "chat"],
  ["routines", "例行任务", "play"],
  ["parallel", "并行", "layers"],
  ["commands", "常用指令", "terminal"],
  ["version", "版本", "github"],
  ["rules", "规则与记忆", "scroll"],
  ["account", "账号与连接", "lock"],
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number][0];

/** The wide (desktop, tablet, wide browser) settings page. */
function TeamSettings(props: { hub: Hub; push: Push; settings: Settings; wide: boolean; onRules: () => void; onConnection: () => void; onDisconnect: () => void }) {
  const { view, error, saved, save } = props.settings;
  props.settings.load();
  const eff = () => view()?.effective;
  const row: ViewStyle = { gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.line };
  const chips: ViewStyle = { flexDirection: "row", flexWrap: "wrap", gap: 6 };

  const tab = props.settings.tab;
  const on = (k: SettingsTab) => tab() === k;
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View testID="settings-nav" role="tablist" style={{ width: 208, gap: 2, paddingHorizontal: 10, paddingVertical: 20, borderRightWidth: 1, borderRightColor: colors.line }}>
        <Each of={[...SETTINGS_TABS]}>
          {(x) => (
            <View
              role="tab"
              testID={`settings-tab-${x()[0]}`}
              accessibilityLabel={x()[1]}
              accessibilityState={{ selected: on(x()[0]) }}
              onPress={() => tab.set(x()[0])}
              hoverStyle={on(x()[0]) ? undefined : hovered()}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 36, paddingHorizontal: 10, borderRadius: 8, backgroundColor: on(x()[0]) ? colors.raised : undefined }}
            >
              <Icon name={x()[2]} size={16} tint={on(x()[0]) ? colors.text : colors.muted} />
              <Text style={{ fontSize: 14.5, fontWeight: on(x()[0]) ? "600" : "400", color: on(x()[0]) ? colors.text : colors.muted }}>{x()[1]}</Text>
            </View>
          )}
        </Each>
      </View>
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 28, paddingHorizontal: props.wide ? 32 : 16, paddingTop: props.wide ? 28 : 18, paddingBottom: 48 }}>
        <If when={error() || saved()}>
          <Text testID="settings-note" style={{ alignSelf: "flex-end", fontSize: 13.5, color: error() ? colors.danger : colors.up }}>{error() || saved()}</Text>
        </If>
        <If when={on("notify")}>
          <NotifySettings push={props.push} view={view()} save={save} wide={props.wide} />
        </If>
        <If when={on("members") || on("routines") || on("parallel")}>
        <If when={eff()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{error() ? "" : "读取中…"}</Text>}>
          {(e) => (
            <View style={{ gap: 28 }}>
              <If when={on("members")}>
              <Group title="成员" hint="团队里的每个角色。模型决定由谁来干活，自主程度决定多大的事要先问你。">
                <Each of={e().agents} key={(a) => a.id}>
                  {(a, i) => (
                    <View testID={`member-${a().id}`} style={{ flexDirection: props.wide ? "row" : "column", alignItems: props.wide ? "center" : "stretch", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i() === 0 ? 0 : 1, borderTopColor: colors.line }}>
                      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 }}>
                        <Avatar from={a().id} />
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                            <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{a().title ?? a().id}</Text>
                            <If when={a().title && a().title !== a().id}>
                              <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint, numberOfLines: 1 }}>{a().id}</Text>
                            </If>
                          </View>
                          <If when={a().about}>
                            <Text testID={`member-about-${a().id}`} style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 2 }}>{a().about}</Text>
                          </If>
                        </View>
                      </View>
                      <View style={{ flexDirection: "row", gap: 8, paddingLeft: props.wide ? 0 : 52 }}>
                        <Dropdown
                          testID={`cli-${a().id}`}
                          label="模型"
                          value={cliLabel(a().clis)}
                          options={view()!.options.clis.map((c) => ({ id: cliKey(c), label: cliLabel(c), detail: cliDetail(c), testID: `cli-${a().id}-${cliKey(c)}` }))}
                          selected={cliKey(a().clis)}
                          onPick={(k) => { const c = view()!.options.clis.find((x) => cliKey(x) === k); if (c) save(patches.clis(a().id, c)); }}
                        />
                        <Dropdown
                          testID={`autonomy-${a().id}`}
                          label="自主程度"
                          value={autonomyLabel(a().autonomy)}
                          options={view()!.options.autonomy.map((l) => ({ id: l, label: autonomyLabel(l), detail: AUTONOMY_DETAIL[l], testID: `autonomy-${a().id}-${l}` }))}
                          selected={a().autonomy}
                          onPick={(l) => save(patches.autonomy(a().id, l))}
                        />
                      </View>
                    </View>
                  )}
                </Each>
              </Group>
              </If>

              <If when={on("routines")}>
              <Group title="例行任务" hint="定时生成任务的规则：开关和运行时间">
                <Each of={e().routines} key={(r) => r.name}>
                  {(r, i) => (
                    <View style={{ ...row, flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: i() === 0 ? 0 : 1 }}>
                      <Toggle
                        testID={`routine-${r().name}`}
                        label={r().name}
                        value={r().enabled}
                        onChange={(on) => save(patches.routine(r().name, { enabled: on }))}
                      />
                      <View style={{ flex: 1, gap: 3 }}>
                        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                          <Text style={{ fontSize: 15.5, fontWeight: "500", color: r().enabled ? colors.text : colors.faint }}>{r().name}</Text>
                          <If when={r().agent}>
                            <Text style={{ fontSize: 12.5, color: colors.faint }}>{e().agents.find((a) => a.id === r().agent)?.title ?? r().agent}</Text>
                          </If>
                        </View>
                        <If when={r().desc}>
                          <Text testID={`routine-desc-${r().name}`} style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{r().desc}</Text>
                        </If>
                      </View>
                      <Dropdown
                        testID={`every-${r().name}`}
                        label="运行"
                        value={everyLabel(r().every)}
                        options={intervalsWith(r().every).map((iv) => ({ id: iv, label: everyLabel(iv), testID: `every-${r().name}-${iv}` }))}
                        selected={r().every}
                        onPick={(iv) => save(patches.routine(r().name, { every: iv }))}
                      />
                    </View>
                  )}
                </Each>
              </Group>
              </If>

              <If when={on("parallel")}>
              <Group title="并行">
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 14 }}>
                  <Text style={{ flex: 1, fontSize: 15.5, color: colors.text }}>每台机器同时运行的任务数</Text>
                  <Chip label="−" on={false} testID="parallel-dec" accessibilityLabel="减少" onPress={() => save(patches.maxParallel(Math.max(1, (e().max_parallel ?? 2) - 1)))} />
                  <Text style={{ width: 36, textAlign: "center", fontSize: 17, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }} testID="parallel">
                    {String(e().max_parallel ?? "—")}
                  </Text>
                  <Chip label="+" on={false} testID="parallel-inc" accessibilityLabel="增加" onPress={() => save(patches.maxParallel(Math.min(32, (e().max_parallel ?? 2) + 1)))} />
                </View>
              </Group>
              </If>
            </View>
          )}
        </If>
        </If>
        <If when={on("commands")}>
        <Group title="常用指令" hint="在输入框里输入 / 选用。内置指令执行操作，你添加的指令把一段话发给团队。">
          <CommandRows settings={props.settings} />
        </Group>
        </If>
        <If when={on("version")}>
        <Group title="版本" hint="每台机器运行的代码。更新会让所有机器拉取最新代码，主控机同时重新发布线上。">
          <VersionRows hub={props.hub} />
        </Group>
        </If>
        <If when={on("rules")}>
        <Group title="团队规则与记忆" hint="团队做事依据的规则、你的偏好、成员档案和决策先例。只读。">
          <SetRow first label="查看规则与记忆" chevron onPress={props.onRules} testID="settings-rules" />
        </Group>
        </If>
        <If when={on("account")}>
        <Group title="账号与连接" hint="登录状态保存在这台设备上，下次打开自动连接。">
          <View style={{ flexDirection: props.wide ? "row" : "column", alignItems: props.wide ? "center" : "stretch", gap: 10, paddingHorizontal: 16, paddingVertical: 14 }}>
            <View style={{ flex: props.wide ? 1 : undefined, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Dot tone={props.hub.conn() === "live" ? "on" : props.hub.conn() === "unauthorized" ? "bad" : "wait"} />
              <Text style={{ flex: 1, fontSize: 15, color: colors.text, numberOfLines: 1 }}>{props.hub.cfg.url}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn label="退出登录" kind="danger" onPress={props.onDisconnect} testID="logout" />
            </View>
          </View>
        </Group>
        </If>
      </View>
    </Scroll>
    </View>
  );
}

// ---------------------------------------------------------------- settings on phones (iOS / Android Settings)

/** What the notification settings show and change, for both layouts. */
function notifyModel(push: Push, view: () => SettingsView | null, save: (patch: Record<string, unknown>) => void) {
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
    } catch {
      return "Asia/Shanghai";
    }
  })();
  const prefs = () => notifyPrefsOf(view(), tz);
  const setPrefs = (change: Partial<NotifyPrefs>) => save(notifyPatch({ ...prefs(), ...change, tz }));
  const state = () => {
    const i = push.info();
    if (!i) return "这个环境不支持网页推送（请用手机浏览器打开 hub 的网页）";
    if (push.needsHomeScreen()) return "iPhone 需要先把 noop 添加到主屏幕";
    if (!i.supported) return "这个浏览器不支持网页推送";
    if (i.permission === "denied") return "通知被浏览器拦截了";
    return i.subscribed ? "已开启" : "未开启";
  };
  /** The short form for a row's value. */
  const short = () => {
    const i = push.info();
    if (!i || !i.supported || push.needsHomeScreen()) return "不可用";
    if (i.permission === "denied") return "已拦截";
    return i.subscribed ? "已开启" : "未开启";
  };
  return { prefs, setPrefs, state, short };
}

/** A grouped, inset section: a muted title above, rows on one rounded surface, a hint below. */
function Section(props: { title?: string; hint?: string; testID?: string; children: JSX.Element }) {
  return (
    <View testID={props.testID} style={{ gap: 7 }}>
      <If when={props.title}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, color: colors.muted }}>{props.title}</Text>
      </If>
      <View style={{ marginHorizontal: 16, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.surface, overflow: "hidden" }}>{props.children}</View>
      <If when={props.hint}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.faint }}>{props.hint}</Text>
      </If>
    </View>
  );
}

/** The hairline above every row of a section but its first, inset to the text. */
function Hairline(props: { inset?: number }) {
  return <View style={{ position: "absolute", top: 0, left: props.inset ?? 16, right: 0, height: 0.5, backgroundColor: colors.border }} />;
}

/** A row of a section, at least 48 pt tall: a label (and a line under it), then a value, a control or a chevron. */
/** The code a machine runs: the short commit, a link to it on GitHub. */
function RevLink(props: { host: HostInfo }) {
  const short = () => (props.host.rev ?? "").slice(0, 7);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ fontSize: 14, color: colors.muted }}>版本</Text>
      <Text
        role={props.host.rev_url ? "link" : undefined}
        testID={`rev-${props.host.host}`}
        accessibilityLabel={`版本 ${short()}`}
        onPress={props.host.rev_url ? () => void openUrl(props.host.rev_url!).catch(() => {}) : undefined}
        style={{ fontFamily: MONO, fontSize: 13, color: props.host.rev_url ? colors.accent : colors.muted }}
      >
        {short()}
      </Text>
    </View>
  );
}

/** Ask every machine to update to the latest code; the primary also redeploys the web app and the Worker. */
async function updateAllMachines(hub: Hub) {
  const r = await AlertDialog.show({
    title: "更新所有机器？",
    description: "每台机器拉取最新代码后重启：空闲的马上更新，有任务在跑的等跑完再重启。主控机同时重新发布线上。",
    actions: [
      { id: "cancel", label: "取消", role: "cancel" },
      { id: "update", label: "更新" },
    ],
  });
  if (r.action === "update") await hub.api("POST", "/api/fleet/update").catch(() => {});
}

/** One row per online machine with the commit it runs, then the button that updates them all. */
/** The commands typed after "/" in the composer: the built-ins, the saved ones (deletable), and a form to add one. */
function CommandRows(props: { settings: Settings }) {
  const { view, save } = props.settings;
  const saved = () => savedCommands(view());
  const { name, text, editing, note } = props.settings.commandDraft;
  const open = (c?: Command) => {
    name.set(c?.name ?? ""); text.set(c?.text ?? ""); note.set("");
    editing.set(c?.name ?? "");
  };
  return (
    <>
      <SetRow
        first
        label="/更新所有机器"
        detail="让所有机器拉取最新代码并重启"
        testID="command-row-builtin"
        trailing={<Text style={{ fontSize: 12, color: colors.faint, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.raised }}>内置</Text>}
      />
      <Each of={saved()} key={(c) => c.name}>
        {(c) => (
          <View
            role="button"
            testID={`command-row-${c().name}`}
            accessibilityLabel={`编辑指令 ${c().name}`}
            onPress={() => open(c())}
            hoverStyle={hovered()}
            class="active:bg-raised"
          >
            <Hairline />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 14, paddingVertical: 11 }}>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={{ fontSize: 15.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>/{c().name}</Text>
                <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 2 }}>{c().text}</Text>
              </View>
              <Icon name="chevron" size={14} tint={colors.faint} />
            </View>
          </View>
        )}
      </Each>
      <SetRow label="新建指令" tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => open()} testID="command-new" />
      <CommandEditor settings={props.settings} />
    </>
  );
}

/** New / edit / delete one saved command, in a dialog: a name and the words it sends (several lines welcome). */
function CommandEditor(props: { settings: Settings }) {
  const { view, save } = props.settings;
  const { name, text, editing, note } = props.settings.commandDraft;
  const isNew = () => editing() === "";
  const close = () => editing.set(undefined);
  const others = () => savedCommands(view()).filter((c) => c.name !== editing());
  const clean = () => name().trim().replace(/^\//, "").replace(/\s+/g, "-");
  const ok = () => !!clean() && !!text().trim();
  const submit = async () => {
    const n = clean(), t = text().trim();
    if (!n) return note.set("给指令起个名字");
    if (!t) return note.set("写下这条指令要发给团队的话");
    if (BUILTIN_COMMANDS.some((b) => b.name === n)) return note.set(`「${n}」是内置指令的名字`);
    if (others().some((c) => c.name === n)) return note.set(`已经有一条「/${n}」`);
    const list = savedCommands(view());
    const i = list.findIndex((c) => c.name === editing());
    const next = i < 0 ? [...list, { name: n, text: t }] : list.map((c, j) => (j === i ? { name: n, text: t } : c));
    close();
    await save({ commands: next });
  };
  const remove = async () => {
    const n = editing();
    close();
    await save({ commands: savedCommands(view()).filter((c) => c.name !== n) });
  };
  const focused = signal(false);
  return (
    <Dialog
      testID="command-editor"
      open={editing() !== undefined}
      animation="fade"
      onOpenChange={({ open }) => !open && close()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: 560, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 1, borderBottomColor: colors.line }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{isNew() ? "新建指令" : "编辑指令"}</Text>
          <ToolButton icon="close" label="关闭" shortcut="Esc" onPress={close} />
        </View>
        <View style={{ gap: 16, padding: 20 }}>
          <Field label="名称" value={name()} onChange={(v) => { name.set(v); note.set(""); }} placeholder="例如：日报" testID="command-name" autoFocus={isNew()} hint={clean() ? `在输入框里输入 /${clean()} 选用` : "在输入框里输入 / 加名称选用"} />
          <View style={{ gap: 7 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>发给团队的话</Text>
            <Input
              testID="command-text"
              multiline
              value={text()}
              onChange={({ value }) => { text.set(value); note.set(""); }}
              onFocus={() => focused.set(true)}
              onBlur={() => focused.set(false)}
              placeholder={"例如：把今天各项目的进展整理成日报发给我，\n按项目分段，每段先说结论。"}
              class="placeholder:text-faint"
              style={{
                height: 140,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: focused() ? colors.accent : colors.fieldBorder,
                backgroundColor: colors.field,
                fontSize: 15.5,
                lineHeight: 23,
                color: colors.text,
                ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
              }}
            />
          </View>
          <If when={note()}>
            <Text testID="command-note" style={{ fontSize: 13.5, color: colors.danger }}>{note()}</Text>
          </If>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingBottom: 20 }}>
          <If when={!isNew()}>
            <Btn label="删除" kind="danger" icon="trash" onPress={() => void remove()} testID="command-delete" />
          </If>
          <View style={{ flex: 1 }} />
          <Btn label="取消" kind="ghost" onPress={close} testID="command-cancel" />
          <Btn label={isNew() ? "添加" : "保存"} kind="primary" disabled={!ok()} onPress={() => void submit()} testID="command-save" />
        </View>
      </View>
    </Dialog>
  );
}

function VersionRows(props: { hub: Hub }) {
  const hosts = () => props.hub.status()?.hosts ?? [];
  // the lines age (waiting → not responding, finished → hidden): re-read the clock every few seconds
  const clock = signal(Date.now());
  const timer = setInterval(() => clock.set(Date.now()), 5000);
  cleanup(() => clearInterval(timer));
  const request = () => props.hub.status()?.update?.at;
  const summary = () => updateSummary(props.hub.status(), clock());
  const toneColor = (t: UpdateLine["tone"]) => (t === "ok" ? colors.up : t === "bad" ? colors.danger : colors.muted);
  return (
    <>
      <Each of={hosts()} key={(h) => h.host}>
        {(h, i) => {
          const line = () => updateLine(h(), request(), clock());
          return (
            <SetRow
              first={i() === 0}
              label={h().host}
              value={h().rev?.slice(0, 7) ?? "未知"}
              chevron={!!h().rev_url}
              onPress={h().rev_url ? () => void openUrl(h().rev_url!).catch(() => {}) : undefined}
              testID={`version-${h().host}`}
              below={
                <If when={line()}>
                  <View testID={`update-${h().host}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <If when={line()!.busy}>
                      <Spinner size={12} tint={colors.muted} />
                    </If>
                    <Text style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: toneColor(line()!.tone) }}>{line()!.text}</Text>
                  </View>
                </If>
              }
            />
          );
        }}
      </Each>
      <SetRow
        first={!hosts().length}
        label={summary()?.busy ? "正在更新…" : "更新所有机器"}
        detail={summary()?.text}
        tone="accent"
        disabled={!!summary()?.busy}
        onPress={() => void updateAllMachines(props.hub)}
        testID="update-fleet"
      />
    </>
  );
}

function SetRow(props: {
  label: string;
  detail?: string;
  value?: string;
  first?: boolean;
  chevron?: boolean;
  tone?: "danger" | "accent";
  leading?: JSX.Element;
  trailing?: JSX.Element;
  /** Under the label and detail (a progress line). */
  below?: JSX.Element;
  inset?: number;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const press = () => (props.disabled ? undefined : props.onPress);
  return (
    <View
      role={props.onPress ? "button" : undefined}
      testID={props.testID}
      accessibilityLabel={props.onPress ? [props.label, props.value].filter(Boolean).join("，") : undefined}
      accessibilityState={props.onPress ? { disabled: !!props.disabled } : undefined}
      onPress={press()}
      class={props.onPress && !props.disabled ? "active:bg-raised" : undefined}
      style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 14, paddingVertical: 10 }}
    >
      <If when={!props.first}>
        <Hairline inset={props.inset} />
      </If>
      {props.leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{
            fontSize: 16,
            textAlign: props.tone === "danger" && !props.trailing && !props.chevron ? "center" : "left",
            color: props.disabled ? colors.faint : props.tone === "danger" ? colors.danger : props.tone === "accent" ? colors.info : colors.text,
            numberOfLines: 1,
          }}
        >
          {props.label}
        </Text>
        <If when={props.detail}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{props.detail}</Text>
        </If>
        {props.below}
      </View>
      <If when={props.value}>
        <Text style={{ flexShrink: 1, fontSize: 16, color: colors.muted, numberOfLines: 1 }}>{props.value}</Text>
      </If>
      {props.trailing}
      <If when={props.chevron}>
        <Icon name="chevron" size={14} tint={colors.faint} />
      </If>
    </View>
  );
}

type Choice = { id: string; label: string; detail?: string; testID: string };

/** Pick one of a few: a radio set of rows, the chosen one checked. */
function Choices(props: { label: string; choices: Choice[]; selected: string | null; onPick: (id: string) => void }) {
  return (
    <RadioGroup>
      <Each of={props.choices} key={(c) => c.id}>
        {(c, i) => (
          <Radio
            testID={c().testID}
            checked={c().id === props.selected}
            onChange={() => props.onPick(c().id)}
            accessibilityLabel={c().label}
            class="active:bg-raised"
            style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 16, paddingVertical: 10 }}
          >
            <If when={i() > 0}>
              <Hairline />
            </If>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 16, color: colors.text }}>{c().label}</Text>
              <If when={c().detail}>
                <Text style={{ fontSize: 13, color: colors.muted }}>{c().detail}</Text>
              </If>
            </View>
            <View style={{ width: 20, alignItems: "center" }}>
              <If when={c().id === props.selected}>
                <Icon name="check" size={17} tint={colors.info} />
              </If>
            </View>
          </Radio>
        )}
      </Each>
    </RadioGroup>
  );
}

/** A page of sections on the grouped background. */
function Grouped(props: { testID?: string; children: JSX.Element }) {
  return (
    <Scroll testID={props.testID} style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ width: "100%", maxWidth: 640, alignSelf: "center", gap: 28, paddingTop: 20, paddingBottom: Math.max(32, safeArea().bottom + 16) }}>{props.children}</View>
    </Scroll>
  );
}

function SaveNote(props: { settings: Settings }) {
  return (
    <If when={props.settings.error() || props.settings.saved()}>
      <Text testID="settings-note" style={{ paddingHorizontal: 32, fontSize: 13, color: props.settings.error() ? colors.danger : colors.up }}>
        {props.settings.error() || props.settings.saved()}
      </Text>
    </If>
  );
}

const routineValue = (r: { enabled: boolean; every: string }) => (r.enabled ? everyLabel(r.every) : "已关闭");

/** 设置 on a phone: a list of sections; 通知, each member and each routine push pages of their own. */
function PhoneSettings(props: { hub: Hub; push: Push; settings: Settings; onOpen: (r: Route) => void; onDisconnect: () => void }) {
  const { view, error, save } = props.settings;
  props.settings.load();
  const notify = notifyModel(props.push, view, save);
  const eff = () => view()?.effective;
  async function logout() {
    const r = await AlertDialog.show({
      title: "退出登录？",
      description: "这台设备会关闭通知，下次打开需要重新登录。",
      actions: [
        { id: "cancel", label: "取消", role: "cancel" },
        { id: "logout", label: "退出登录", role: "destructive" },
      ],
    });
    if (r.action === "logout") props.onDisconnect();
  }
  return (
    <Grouped testID="phone-settings">
      <Section title="通知" hint="需要你拍板的事推送到这台设备；通知上可以直接选择选项。">
        <SetRow first label="通知" value={notify.short()} chevron onPress={() => props.onOpen({ name: "notify" })} testID="settings-notify" />
      </Section>
      <Section title="团队规则与记忆" hint="团队做事依据的规则、你的偏好、成员档案和决策先例。只读。">
        <SetRow first label="规则与记忆" chevron onPress={() => props.onOpen({ name: "rules" })} testID="settings-rules" />
      </Section>
      <SaveNote settings={props.settings} />
      <If when={eff()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>{error() ? "设置读取失败" : "读取中…"}</Text>}>
        {(e) => (
          <View style={{ gap: 28 }}>
            <Section title="成员" hint="模型：先用哪个、失败或额度用尽时换哪个；自主程度：多大的事需要先问你。">
              <Each of={e().agents} key={(a) => a.id}>
                {(a, i) => (
                  <SetRow
                    first={i() === 0}
                    inset={58}
                    leading={<Avatar from={a().id} />}
                    label={a().id}
                    detail={`${cliLabel(a().clis)} · ${autonomyLabel(a().autonomy)}`}
                    chevron
                    onPress={() => props.onOpen({ name: "member", id: a().id })}
                    testID={`member-${a().id}`}
                  />
                )}
              </Each>
            </Section>
            <Section title="例行任务" hint="团队定时自己做的事。">
              <Each of={e().routines} key={(r) => r.name}>
                {(r, i) => (
                  <SetRow
                    first={i() === 0}
                    label={r().name}
                    detail={r().agent}
                    value={routineValue(r())}
                    chevron
                    onPress={() => props.onOpen({ name: "routine", routine: r().name })}
                    testID={`routine-row-${r().name}`}
                  />
                )}
              </Each>
            </Section>
            <Section title="并行" hint="每台机器同时运行的任务数，1 到 32。">
              <SetRow
                first
                label="同时运行"
                trailing={
                  <NumberInput
                    testID="parallel"
                    accessibilityLabel="每台机器同时运行的任务数"
                    value={e().max_parallel ?? 2}
                    min={1}
                    max={32}
                    onChange={({ value }) => {
                      if (value != null && value >= 1 && value <= 32 && value !== untracked(eff)?.max_parallel) save(patches.maxParallel(value));
                    }}
                    style={{ flexDirection: "row", alignItems: "center", height: 36, borderRadius: radius.control, backgroundColor: colors.raised }}
                    inputStyle={{ width: 40, textAlign: "center", fontSize: 17, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}
                    decrementButtonClass="active:opacity-50 disabled:opacity-30"
                    incrementButtonClass="active:opacity-50 disabled:opacity-30"
                    decrementButtonStyle={{ width: 44, height: 36, alignItems: "center", justifyContent: "center" }}
                    incrementButtonStyle={{ width: 44, height: 36, alignItems: "center", justifyContent: "center" }}
                    decrementButton={<Icon name="minus" size={16} tint={colors.text} />}
                    incrementButton={<Icon name="plus" size={16} tint={colors.text} />}
                  />
                }
              />
            </Section>
          </View>
        )}
      </If>
      <Section title="常用指令" hint="在输入框里输入 / 选用。内置指令执行操作，你添加的指令把一段话发给团队。">
        <CommandRows settings={props.settings} />
      </Section>
      <Section title="版本" hint="每台机器运行的代码。更新会让所有机器拉取最新代码，主控机同时重新发布线上。">
        <VersionRows hub={props.hub} />
      </Section>
      <Section title="账号与连接" hint="登录状态保存在这台设备上，下次打开自动连接。">
        <SetRow
          first
          leading={<Dot tone={props.hub.conn() === "live" ? "on" : props.hub.conn() === "unauthorized" ? "bad" : "wait"} />}
          label={props.hub.cfg.url.replace(/^https?:\/\//, "")}
        />
        <SetRow label="退出登录" tone="danger" onPress={() => void logout()} testID="logout" inset={0} />
      </Section>
    </Grouped>
  );
}

/** 通知 on a phone: this device, what is pushed, and the quiet hours. */
function PhoneNotify(props: { push: Push; settings: Settings }) {
  const push = props.push;
  const { view, save } = props.settings;
  const notify = notifyModel(push, view, save);
  return (
    <Grouped testID="phone-notify">
      <Section title="本设备">
        <SetRow first label={push.info()?.device ?? "本设备"} trailing={<Text testID="push-state" style={{ fontSize: 16, color: colors.muted }}>{notify.short()}</Text>} />
        <If
          when={push.info()?.subscribed}
          else={<SetRow label="开启通知" tone="accent" disabled={!push.canAsk() || push.busy()} onPress={push.enable} testID="push-enable" />}
        >
          <SetRow label="发送测试通知" tone="accent" disabled={push.busy()} onPress={push.test} testID="push-test" />
          <SetRow label="关闭本设备通知" tone="danger" onPress={push.disable} testID="push-disable" />
        </If>
      </Section>
      <If when={push.note()}>
        <Text testID="push-note" style={{ marginTop: -20, paddingHorizontal: 32, fontSize: 13, color: push.note()!.tone === "ok" ? colors.up : colors.danger }}>{push.note()!.text}</Text>
      </If>
      <If when={push.needsHomeScreen()}>
        <Section title="在 iPhone 上开启通知">
          <View style={{ padding: 16 }}>
            <Steps steps={["在 Safari 里点底部的「分享」按钮", "选「添加到主屏幕」，再点「添加」", "从主屏幕打开 noop，登录后回到这里点「开启通知」"]} />
          </View>
        </Section>
      </If>
      <If when={push.info()?.permission === "denied" && !push.needsHomeScreen()}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.muted }}>{`${notify.state()}：在浏览器的网站设置（或系统设置 → 通知）里允许 noop，然后刷新页面再开启。`}</Text>
      </If>
      <If when={view()}>
        <Section title="推送哪些">
          <Each of={NOTIFY_KINDS as unknown as [NotifyKind, string][]}>
            {(k, i) => (
              <SetRow
                first={i() === 0}
                label={k()[1]}
                trailing={
                  <Toggle
                    testID={`notify-${k()[0]}`}
                    label={k()[1]}
                    value={notify.prefs().kinds[k()[0]]}
                    onChange={(on) => notify.setPrefs({ kinds: { ...notify.prefs().kinds, [k()[0]]: on } })}
                  />
                }
              />
            )}
          </Each>
        </Section>
        <Section title="免打扰时段" hint={`这段时间只记下，不推送（时区 ${notify.prefs().tz}）。`}>
          <Choices
            label="免打扰时段"
            choices={QUIET_PRESETS.map((q) => ({ id: quietKey(q.value), label: q.label, testID: `quiet-${quietKey(q.value)}` }))}
            selected={quietKey(notify.prefs().quiet_hours)}
            onPick={(id) => notify.setPrefs({ quiet_hours: QUIET_PRESETS.find((q) => quietKey(q.value) === id)!.value })}
          />
        </Section>
      </If>
    </Grouped>
  );
}

/** A member on a phone: its models and its autonomy. */
function PhoneMember(props: { id: string; settings: Settings }) {
  const { view, save } = props.settings;
  const agent = () => view()?.effective.agents.find((a) => a.id === props.id);
  return (
    <Grouped testID="phone-member">
      <If when={agent()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>没有这个成员</Text>}>
        {(a) => (
          <>
            <Section title="模型" hint="先用哪个；失败或额度用尽时换下一个。">
              <Choices
                label="模型"
                choices={view()!.options.clis.map((c) => ({ id: cliKey(c), label: cliLabel(c), testID: `cli-${props.id}-${cliKey(c)}` }))}
                selected={cliKey(a().clis)}
                onPick={(id) => save(patches.clis(props.id, view()!.options.clis.find((c) => cliKey(c) === id)!))}
              />
            </Section>
            <Section title="自主程度" hint="多大的事需要先问你。">
              <Choices
                label="自主程度"
                choices={view()!.options.autonomy.map((l) => ({ id: l, label: autonomyLabel(l), testID: `autonomy-${props.id}-${l}` }))}
                selected={a().autonomy}
                onPick={(l) => save(patches.autonomy(props.id, l))}
              />
            </Section>
            <SaveNote settings={props.settings} />
          </>
        )}
      </If>
    </Grouped>
  );
}

/** A routine on a phone: on or off, and how often. */
function PhoneRoutine(props: { name: string; settings: Settings }) {
  const { view, save } = props.settings;
  const routine = () => view()?.effective.routines.find((r) => r.name === props.name);
  return (
    <Grouped testID="phone-routine">
      <If when={routine()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>没有这个例行任务</Text>}>
        {(r) => (
          <>
            <Section hint={[r().desc, r().agent && `由 ${r().agent} 执行。`].filter(Boolean).join("\n")}>
              <SetRow
                first
                label="启用"
                trailing={<Toggle testID={`routine-${props.name}`} label="启用" value={r().enabled} onChange={(on) => save(patches.routine(props.name, { enabled: on }))} />}
              />
            </Section>
            <Section title="运行间隔">
              <Choices
                label="运行间隔"
                choices={intervalsWith(r().every).map((iv) => ({ id: iv, label: everyLabel(iv), testID: `every-${props.name}-${iv}` }))}
                selected={r().every}
                onPick={(iv) => save(patches.routine(props.name, { every: iv }))}
              />
            </Section>
            <SaveNote settings={props.settings} />
          </>
        )}
      </If>
    </Grouped>
  );
}

// ---------------------------------------------------------------- the team's rules and memory (read-only)

/** 团队规则与记忆: policies, the owner's memory, each agent's profile and memory, closed decisions. */
function RulesList(props: { hub: Hub; onOpen: (path: string) => void }) {
  const groups = signal<RuleGroup[] | null>(null);
  const error = signal("");
  void (async () => {
    const lists: Record<string, DataFile[]> = {};
    for (const pre of RULE_PREFIXES) {
      const r = await props.hub.api("GET", `/api/files/list?prefix=${encodeURIComponent(pre)}`);
      if (!r.ok) { error.set(r.status ? `读取失败（${r.status}）` : "连不上服务器"); return; }
      lists[pre] = (r.data.files as DataFile[] | undefined) ?? [];
    }
    groups.set(groupRules(lists));
  })();
  return (
    <Grouped testID="rules">
      <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.muted }}>团队做事依据的规则和记忆。这里只读，内容由团队在工作中维护。</Text>
      <If when={groups()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: error() ? colors.danger : colors.faint }}>{error() || "读取中…"}</Text>}>
        {(gs) => (
          <Each of={gs()} key={(g) => g.key}>
            {(g) => (
              <Section title={g().title} hint={g().hint} testID={`rules-${g().key}`}>
                <If when={g().items.length} else={<SetRow first label="暂无内容" disabled />}>
                  <Each of={g().items} key={(it) => it.path}>
                    {(it, i) => (
                      <SetRow first={i() === 0} label={it().title} value={it().detail} chevron onPress={() => props.onOpen(it().path)} testID={`rule-${it().path}`} />
                    )}
                  </Each>
                </If>
              </Section>
            )}
          </Each>
        )}
      </If>
    </Grouped>
  );
}

/** One rules or memory file, rendered as markdown. Read-only. */
function RuleDoc(props: { hub: Hub; path: string; wide: boolean }) {
  const text = signal<string | null>(null);
  const error = signal("");
  void props.hub.api("GET", `/api/files/read?path=${encodeURIComponent(props.path)}`).then((r) => {
    if (r.ok && typeof r.data.content === "string") text.set(stripFrontMatter(r.data.content));
    else error.set(r.status === 404 ? "这个文件已经不在了。" : r.status ? `读取失败（${r.status}）` : "连不上服务器");
  });
  return (
    <Scroll testID="rule-doc" style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 12, paddingHorizontal: props.wide ? 32 : 16, paddingTop: 20, paddingBottom: Math.max(32, safeArea().bottom + 16) }}>
        <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{props.path}</Text>
        <If when={text() !== null} else={<Text style={{ fontSize: 14, color: error() ? colors.danger : colors.faint }}>{error() || "读取中…"}</Text>}>
          <If when={(text() ?? "").trim()} else={<Text style={{ fontSize: 14, color: colors.faint }}>（空文件）</Text>}>
            <View selectable><Rich text={text() ?? ""} /></View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- commands ("/" in the composer)

/** The commands a "/" draft matches, above the composer. While it shows, Up / Down (and Ctrl+P / Ctrl+N) move the
 * pick, Tab or Return runs it, Escape closes the list (clearing the "/"). */
function CommandList(props: {
  items: CommandItem[];
  selected: number;
  touch: boolean;
  onHover: (i: number) => void;
  onMove: (delta: number) => void;
  onRun: (c: CommandItem) => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const run = () => { const c = props.items[props.selected]; if (c) props.onRun(c); };
  keymap.bind(
    { up: () => props.onMove(-1), down: () => props.onMove(1), "ctrl+p": () => props.onMove(-1), "ctrl+n": () => props.onMove(1), tab: run, escape: props.onClose },
    { when: "always", repeat: true },
  );
  return (
    <View
      testID="commands"
      role="menu"
      accessibilityLabel="指令"
      style={{ width: "100%", maxWidth: 480, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 4, overflow: "hidden" }}
    >
      <Each of={props.items} key={(c) => c.id}>
        {(c, i) => (
          <View
            testID={`command-${c().id}`}
            role="menuitem"
            accessibilityLabel={c().name}
            accessibilityState={{ selected: i() === props.selected }}
            onPress={() => props.onRun(c())}
            onMouseEnter={() => props.onHover(i())}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 34, paddingHorizontal: 10, borderRadius: 8, backgroundColor: i() === props.selected ? colors.raised : undefined }}
          >
            <Text style={{ flexShrink: 0, maxWidth: 180, fontSize: 14.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>{`/${c().name}`}</Text>
            <Text style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.faint, numberOfLines: 1 }}>{c().detail}</Text>
            <If when={i() === props.selected && !props.touch}>
              <Text style={{ fontSize: 12, color: colors.faint }}>↵</Text>
            </If>
          </View>
        )}
      </Each>
      <If when={!props.items.length}>
        <Text style={{ paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.muted }}>没有匹配的指令</Text>
      </If>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 30, paddingHorizontal: 10, marginTop: 2, borderTopWidth: 1, borderTopColor: colors.line }}>
        <If when={!props.touch}>
          <Text style={{ flex: 1, fontSize: 12, color: colors.faint }}>↑↓ 选择 · ↵ 执行 · Esc 关闭</Text>
        </If>
        <View testID="manage-commands" role="button" onPress={props.onManage} style={{ marginLeft: props.touch ? 0 : undefined }}>
          <Text style={{ fontSize: 12.5, color: colors.accent }}>管理…</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- keyboard help

const SHORTCUTS: [string, string][] = [
  ["Enter", "发送"],
  ["Shift+Enter", "换行"],
  [`${keymap.label("mod+enter")}`, "发送（任何时候）"],
  [`/  ·  ${keymap.label("mod+k")}`, "聚焦输入框"],
  [`1 – 9  ·  ${keymap.label("alt+1")}…`, "选择当前决策的选项"],
  [`J / K  ·  ${keymap.label("alt+j")} / ${keymap.label("alt+k")}`, "下一个 / 上一个待决策"],
  [`R  ·  ${keymap.label("alt+r")}`, "回复当前决策（其他指示）"],
  [`G  ·  ${keymap.label("alt+g")}`, "跳到最新消息"],
  ["Esc", "取消回复 / 离开输入框 / 关闭"],
  [keymap.label("mod+,"), "团队设置"],
  [keymap.label("mod+b"), "显示 / 隐藏侧栏"],
  [keymap.label("mod+shift+l"), "切换浅色 / 深色"],
  ["?", "快捷键一览"],
];

/** The keyboard shortcuts, in a `Dialog`: Escape, the backdrop and the close button close it. */
function HelpSheet(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      testID="help"
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      backdropTestID="help-backdrop"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View
        accessibilityLabel="键盘快捷键"
        style={{
          width: "100%",
          maxWidth: 520,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          overflow: "hidden",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 1, borderBottomColor: colors.line }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>键盘快捷键</Text>
          <ToolButton icon="close" label="关闭" shortcut="Esc" onPress={props.onClose} />
        </View>
        <View style={{ paddingVertical: 8 }}>
          <Each of={SHORTCUTS}>
            {(s) => (
              <View style={{ flexDirection: "row", alignItems: "center", minHeight: 38, paddingHorizontal: 20, gap: 12 }}>
                <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>{s()[1]}</Text>
                <View style={{ flexDirection: "row", gap: 4 }}>
                  <Each of={s()[0].split("  ·  ")}>{(k) => <Kbd k={k()} />}</Each>
                </View>
              </View>
            )}
          </Each>
        </View>
        <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingBottom: 16 }}>单键快捷键在输入框外生效；打字时用带 Alt（⌥）的组合键。</Text>
      </View>
    </Dialog>
  );
}

// ---------------------------------------------------------------- chat

/** The pages of the stack: the channel, what the sidebar opens, and settings with the pages it pushes on phones. */
type Route =
  | { name: "channel" }
  | { name: "team" }
  | { name: "task"; id: string }
  | { name: "host"; host: string }
  | { name: "notify" }
  | { name: "member"; id: string }
  | { name: "routine"; routine: string }
  | { name: "rules" }
  | { name: "doc"; path: string };
const CHANNEL: Route = { name: "channel" };

function Chat(props: { hub: Hub; openRef?: string | null; onConnection: () => void; onDisconnect: () => void }) {
  const hub = props.hub;
  const push = createPush(hub);
  const wide = () => windowSize().width >= 860;
  const drawer = signal(false);
  const sidebarOpen = signal(true);
  const help = signal(false);
  const settings = createSettings(hub);
  // The pages: the channel at the bottom, what the sidebar, a link or settings opened above it.
  const nav = createNavStack<Route>([CHANNEL]);
  const top = () => { const r = nav.routes(); return r[r.length - 1]; };
  const onChannel = () => nav.routes().length === 1;
  /** Shows a page over the channel, in place of the one shown (the sidebar's pages are siblings). */
  const show = (...routes: Route[]) => { drawer.set(false); nav.setRoutes([CHANNEL, ...routes]); };
  const openHost = (h: string) => show({ name: "host", host: h });
  /** A task: from a machine's page it goes on top (back returns to the machine), else in place. */
  const openTask = (id: string) => {
    const t = untracked(top);
    if (t.name === "host") { drawer.set(false); nav.push({ name: "task", id }); }
    else show({ name: "task", id });
  };
  taskLink = openTask;
  taskState = (id) => { const s = props.hub.status(); return [...(s?.active ?? []), ...(s?.recent ?? [])].find((t) => t.id === id)?.state ?? (s?.active.some((t) => t.id === id) ? "active" : undefined); };
  /** A card being scrolled to (picked from the sidebar, a notification): entering the channel leaves the scroll to it. */
  let jumping: string | null = null;
  // Entering the channel (first load, back from a task or settings) shows the latest messages.
  effect(() => { if (onChannel() && !jumping) { atEnd.set(true); unseen.set(0); toEnd(); } });
  const draft = signal("");
  const replyTo = signal<string | null>(null);
  const focused = signal(false);
  const inputHeight = signal(28);
  const outbox = signal<Outgoing[]>([]);
  const atEnd = signal(true);
  const unseen = signal(0);
  const chosen = signal<string | null>(null);
  let seq = 0;

  /** The timeline: the hub's events and the messages on their way. */
  const shown = computed(() =>
    merge(
      hub.events().filter((e) => !(e.kind === "system" && e.text.startsWith("⚙️ 设置已更新"))),
      outbox().map((o) => ({
        id: o.id, ts: o.ts, from: "owner", kind: "owner" as const, text: o.text, ref: o.ref ?? undefined,
        attachments: o.files.length ? o.files.map((f) => f.preview) : undefined,
      })),
    ),
  );
  const answered = computed(() => answeredIds(shown()));
  // "以下为新消息": above the first event from others after what this device last saw.
  const seen = signal<string | null | undefined>(undefined);
  Storage.getItem(KEYS.seen).then((v) => seen.set(v ?? null));
  const divider = signal<string | null | undefined>(undefined);
  effect(() => {
    if (untracked(divider) !== undefined || !hub.loaded() || seen() === undefined) return;
    divider.set(firstUnread(hub.events(), seen() ?? null));
  });
  const timeline = computed((): (Row | { key: string; unread: true })[] => {
    const r = rows(shown());
    const d = divider();
    const at = d ? r.findIndex((x) => "event" in x && x.event.id === d) : -1;
    return at < 0 ? r : [...r.slice(0, at), { key: "unread", unread: true }, ...r.slice(at)];
  });
  const pending = computed(() => hub.events().filter((e) => isAsk(e) && !answered().has(e.ref!)));
  /** The pending ask the keys act on: the one picked (J / K, the sidebar), else the newest. */
  const target = computed(() => {
    const p = pending();
    const c = chosen();
    return p.find((e) => e.ref === c)?.ref ?? p[p.length - 1]?.ref ?? null;
  });
  const cards = new Map<string, ViewRef>();
  let scroller: ScrollRef | undefined;
  let scrollY = 0;
  let composer: InputRef | undefined;

  const toEnd = (animated = false) => setTimeout(() => scroller?.scrollTo({ y: 1e7, animated }), 40);
  let count = 0;
  effect(() => {
    const n = shown().length;
    const grew = n > count;
    count = n;
    if (untracked(atEnd)) toEnd();
    else if (grew) unseen.update((u) => u + 1);
  });
  const jumpToEnd = () => {
    unseen.set(0);
    atEnd.set(true);
    toEnd(true);
  };

  const reply = (ref: string) => {
    replyTo.set(ref);
    if (!untracked(onChannel)) nav.popToRoot();
    composer?.focus();
  };

  // A message waits a few seconds before it leaves, so a wrong tap or a typo can be taken back.
  const UNDO_MS = 5000;
  const holds = new Map<string, ReturnType<typeof setTimeout>>();
  function send(text: string, ref: string | null, id = `local:${++seq}`, files: Attachment[] = []) {
    const ts = new Date().toISOString();
    outbox.update((o) => [...o.filter((x) => x.id !== id), { id, ts, text, ref, files, state: "held" }]);
    jumpToEnd();
    holds.set(id, setTimeout(() => { holds.delete(id); void deliver(id); }, UNDO_MS));
  }
  function undo(id?: string) {
    const o = id ? outbox().find((x) => x.id === id) : [...outbox()].reverse().find((x) => x.state === "held");
    if (!o || !holds.has(o.id)) return false;
    clearTimeout(holds.get(o.id));
    holds.delete(o.id);
    outbox.update((list) => list.filter((x) => x.id !== o.id));
    if (!/^[DLP]-[A-Z]?\d{4} \S+$/.test(o.text) || o.ref || o.files.length) {
      draft.set(o.text);
      replyTo.set(o.ref);
      attachments.update((a) => [...o.files, ...a]);
      composer?.focus();
    }
    return true;
  }
  async function deliver(id: string) {
    const o = outbox().find((x) => x.id === id);
    if (!o) return;
    const { text, ref, files } = o;
    outbox.update((l) => l.map((x) => (x.id === id ? { ...x, state: "sending" } : x)));
    try {
      await hub.send(text, ref, files);
      outbox.update((o) => o.filter((x) => x.id !== id));
    } catch {
      outbox.update((o) => o.map((x) => (x.id === id ? { ...x, state: "failed" } : x)));
    }
  }
  // Commands: a draft of "/<query>" lists the built-in and saved commands; Return runs the first one.
  const slash = () => slashQuery(draft());
  const commands = () => { const q = slash(); return q == null ? [] : commandItems(settings.view(), q).slice(0, 8); };
  /** The command Return runs: Up and Down move it, a new query starts it over at the first. */
  const cmdSel = signal(0);
  effect(() => { slash(); cmdSel.set(0); });
  const pickedCommand = () => commands()[Math.min(cmdSel(), commands().length - 1)];
  effect(() => { if (slash() != null && !untracked(settings.view)) settings.load(); });
  function runCommand(c: CommandItem) {
    draft.set("");
    inputHeight.set(28);
    if (c.action === "update-fleet") void updateAllMachines(hub);
    else if (c.text) void send(c.text, null);
  }

  function submit() {
    if (speech() !== "off") stopDictation(true);
    if (slash() != null && commands().length && !attachments().length) return runCommand(pickedCommand()!);
    const v = draft().trim();
    const files = attachments();
    if (!v && !files.length) return;
    // A bare choice ("1", "B", "1,3", "全部") answers the decision the keyboard is on, never becomes a new task.
    const r = replyTo() ?? (!files.length && /^([1-9](\s*[,，]\s*[1-9])*|[A-Za-z]|全部|都不要)$/.test(v) ? target() : null);
    draft.set("");
    replyTo.set(null);
    attachments.set([]);
    attachNote.set(null);
    inputHeight.set(28);
    send(v, r, undefined, files);
  }

  // Images the owner attaches: pasted, dropped on the window, or picked.
  const attachments = signal<Attachment[]>([]);
  const attachNote = signal<string | null>(null);
  const dropping = signal(false);
  let attachSeq = 0;
  function attach(file: Blob, name: string, fromPicker = false) {
    // the photo picker only returns images, but phones often give them no type or extension; the server reads the bytes
    const type = imageType(file.type, name) ?? (fromPicker ? "image/jpeg" : null);
    const problem = attachProblem(type, file.size, attachments().length);
    if (problem) return attachNote.set(problem);
    attachNote.set(null);
    const typed = file.type === type ? file : new Blob([file], { type: type! });
    const preview = URL.createObjectURL(typed);
    attachments.update((a) => [...a, { id: `a${++attachSeq}`, name: name || `image-${attachSeq}.png`, type: type!, size: file.size, file: typed, preview }]);
  }
  function unattach(id: string) {
    const a = attachments().find((x) => x.id === id);
    if (a) URL.revokeObjectURL(a.preview);
    attachments.update((list) => list.filter((x) => x.id !== id));
    attachNote.set(null);
  }
  /** Local files (`file:` URLs from a drop or a file manager's copy): read the images among them. */
  async function attachUris(uris: string[]) {
    for (const u of uris) {
      const path = filePath(u);
      const name = path.split(/[\\/]/).pop() ?? "image";
      if (!imageType(undefined, name)) { attachNote.set("只能发送图片"); continue; }
      try {
        const bytes = await fs.readFile(path);
        attach(new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
      } catch {
        attachNote.set(`读不到 ${name}`);
      }
    }
  }
  async function pickImages() {
    try {
      const picked = await Picker.pickImages({ multiple: true, limit: 10 });
      for (const p of picked) attach(p.file, p.file.name, true);
    } catch {
      attachNote.set("这台设备上不能选择图片");
    }
    composer?.focus();
  }
  // Dictation (语音输入): the browser's speech recognition through host.js. Its words land in the
  // composer where the caret was (or at the end), live as they are heard; nothing is sent. Where the
  // page has none (other browsers, the native apps) there is no button.
  const canDictate = signal(false);
  const speech = signal<"off" | "on" | "stopping">("off");
  void hostCall<{ supported: boolean }>("speechState").then((s) => canDictate.set(!!s?.supported));
  let caret: { start: number; end: number } | null = null;
  let before = "";
  let after = "";
  let dictated = ""; // the draft as dictation last left it: anything else is the owner typing
  /** The recognizer's language: the device's Chinese, else Mandarin (the team is written to in Chinese). */
  const speechLang = () => {
    const l = String(locale() ?? "");
    return /^zh\b/i.test(l) ? l : "zh-CN";
  };
  const speechError = (e: string) =>
    e === "not-allowed" || e === "service-not-allowed" ? "没有麦克风权限，请在浏览器设置里允许使用麦克风"
      : e === "no-speech" ? "没有听到声音"
      : e === "audio-capture" ? "找不到麦克风"
      : e === "network" ? "语音识别需要联网"
      : "语音输入出错了";
  async function startDictation() {
    const v = draft();
    const start = Math.min(caret?.start ?? v.length, v.length);
    const end = Math.min(Math.max(caret?.end ?? v.length, start), v.length);
    before = v.slice(0, start);
    after = v.slice(end);
    dictated = v;
    attachNote.set(null);
    speech.set("on");
    if (!(await hostCall("speechStart", { lang: speechLang() })) && untracked(speech) === "on") {
      speech.set("off");
      attachNote.set("无法开始语音输入");
    }
  }
  /** Stop listening: the words still being heard arrive first, unless `drop` (the draft was sent or edited). */
  function stopDictation(drop = false) {
    if (drop) {
      speech.set("off");
      void hostCall("speechAbort");
    } else {
      speech.set("stopping");
      void hostCall("speechStop");
    }
  }
  const toggleDictation = () => (speech() === "off" ? void startDictation() : speech() === "on" ? stopDictation() : undefined);
  if (host.available()) {
    host.on("speech", (p) => {
      if (untracked(speech) === "off") return;
      const heard = String((p as { text?: string })?.text ?? "").trim();
      // a space between Latin words, none in Chinese
      const gap = /[A-Za-z0-9.,!?;:]$/.test(before) && /^[A-Za-z0-9]/.test(heard) ? " " : "";
      const head = before + gap + heard;
      dictated = head + after;
      draft.set(dictated);
      composer?.setSelection(head.length, head.length);
    });
    host.on("speechEnd", (p) => {
      if (untracked(speech) === "off") return;
      speech.set("off");
      const error = (p as { error?: string })?.error;
      if (error) attachNote.set(speechError(error));
    });
  }
  cleanup(() => {
    if (untracked(speech) !== "off") void hostCall("speechAbort");
  });

  const canSend = () => !!draft().trim() || attachments().length > 0;
  const answer = (ref: string, c: string) => {
    hostCall("clearNotifications", { ref });
    return send(`${ref} ${c}`, null);
  };

  function pick(ref: string) {
    drawer.set(false);
    // set before the channel comes back: entering it would otherwise scroll to the latest messages, over this card
    jumping = ref;
    atEnd.set(false);
    const back = !untracked(onChannel);
    nav.popToRoot();
    chosen.set(ref);
    hostCall("clearNotifications", { ref });
    // back from another page the channel lays out first
    setTimeout(() => toCard(ref, 4), back ? 120 : 0);
  }
  /** Scrolls to a card, measured now (what loaded above it since moved it), retrying while it is still being laid out. */
  function toCard(ref: string, tries: number) {
    const card = cards.get(ref), sc = scroller;
    const done = () => { if (jumping === ref) jumping = null; };
    if (!card || !sc) {
      done();
      if (pending().some((e) => e.ref === ref)) reply(ref);
      return;
    }
    void Promise.all([card.measure(), sc.measure()]).then(([c, v]) => {
      if (!c || !v) return tries > 0 ? void setTimeout(() => toCard(ref, tries - 1), 80) : done();
      sc.scrollTo({ y: Math.max(0, scrollY + c.pagePosition.y - v.pagePosition.y - 24), animated: true });
      done();
    });
  }

  // Opened from a notification (`?ref=`), or one clicked while the app is open: show that event.
  let openRef = props.openRef ?? null;
  effect(() => {
    if (!openRef || !hub.loaded()) return;
    const ref = openRef;
    openRef = null;
    setTimeout(() => pick(ref), 300);
  });
  if (host.available()) {
    host.on("open", (p) => {
      const ref = (p as { ref?: string | null } | null)?.ref;
      if (ref) setTimeout(() => pick(ref), 50);
    });
  }
  // The app's badge and the page's title count the decisions waiting.
  effect(() => {
    const n = pending().length;
    if (hub.loaded()) hostCall("setBadge", { count: n });
  });
  // This device has seen what reached the bottom.
  effect(() => {
    const evs = shown();
    if (!atEnd() || !evs.length || divider() === undefined) return;
    Storage.setItem(KEYS.seen, evs[evs.length - 1].ts);
  });
  // A new decision while the app is open: a quiet toast and a short vibration.
  const toast = signal<{ ref: string; text: string } | null>(null);
  let known: Set<string> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(toastTimer));
  effect(() => {
    const asks = pending();
    if (!hub.loaded()) return;
    if (!known) {
      known = new Set(asks.map((e) => e.ref!));
      return;
    }
    const fresh = asks.filter((e) => !known!.has(e.ref!));
    for (const e of asks) known.add(e.ref!);
    if (!fresh.length) return;
    const e = fresh[fresh.length - 1];
    toast.set({ ref: e.ref!, text: e.text.split("\n")[0].replace(/[*`]/g, "").slice(0, 80) });
    hostCall("vibrate");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.set(null), 6000);
  });
  // After the first login on a phone: once, a gentle suggestion to turn notifications on.
  const asked = signal(true);
  Storage.getItem(KEYS.notifyAsked).then((v) => asked.set(!!v));
  const suggest = () => {
    const i = push.info();
    return touch && !asked() && !!i && !i.subscribed && ((i.supported && i.permission === "default") || push.needsHomeScreen());
  };
  const dismissSuggest = () => {
    asked.set(true);
    Storage.setItem(KEYS.notifyAsked, "1");
  };
  /** J / K: the next or the previous pending ask, scrolled into view. */
  function step(by: number) {
    const p = pending();
    if (!p.length) return;
    const at = p.findIndex((e) => e.ref === target());
    const next = p[Math.max(0, Math.min(p.length - 1, (at < 0 ? p.length - 1 : at) + by))];
    pick(next.ref!);
  }
  function choose(n: number) {
    const ref = target();
    const e = pending().find((x) => x.ref === ref);
    if (!e || !onChannel()) return;
    const c = choicesOf(e)[n];
    if (c) answer(e.ref!, c);
  }
  /** 团队规则与记忆: from the sidebar in place; from settings on top (back returns to settings). */
  const openRules = (fromSettings = false) => {
    if (fromSettings) { drawer.set(false); nav.push({ name: "rules" }); }
    else show({ name: "rules" });
  };
  const openTeam = () => {
    if (untracked(top).name === "team") { drawer.set(false); nav.popToRoot(); }
    else show({ name: "team" });
  };

  // Shortcuts. Single keys never fire while typing (`notEditing`).
  keymap.bind("mod+enter", submit, { when: "always" });
  keymap.bind("mod+k", () => composer?.focus(), { when: "always" });
  keymap.bind("mod+z", () => { if (!draft()) undo(); }, { when: "always" });
  keymap.bind("mod+,", openTeam, { when: "always" });
  keymap.bind("mod+b", () => sidebarOpen.set(!untracked(sidebarOpen)), { when: "always" });
  keymap.bind("mod+shift+l", toggleTheme, { when: "always" });
  keymap.bind(
    {
      "/": () => composer?.focus(),
      "shift+/": () => help.set(!untracked(help)),
      j: () => step(1),
      k: () => step(-1),
      r: () => target() && reply(target()!),
      g: jumpToEnd,
      "shift+g": jumpToEnd,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), () => choose(i)])),
    },
    { when: "notEditing" },
  );
  // The same moves with Alt work while typing, so the cursor never has to leave the composer.
  keymap.bind(
    {
      "alt+j": () => step(1),
      "alt+k": () => step(-1),
      "alt+r": () => target() && reply(target()!),
      "alt+g": jumpToEnd,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`alt+${i + 1}`, () => choose(i)])),
    },
    { when: "always" },
  );
  keymap.bind("escape", () => {
    if (help()) help.set(false);
    else if (drawer()) drawer.set(false);
    else if (replyTo()) replyTo.set(null);
    else if (focused()) composer?.blur();
    else if (nav.routes().length > 1) nav.pop();
  }, { when: "always" });

  const connLabel = () => ({ connecting: "连接中…", live: "实时", offline: "已断开，重连中…", unauthorized: "登录已过期" })[hub.conn()];
  const connTone = () => (hub.conn() === "live" ? "on" : hub.conn() === "unauthorized" ? "bad" : hub.conn() === "offline" ? "wait" : "off");
  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      hub={hub}
      target={target}
      onPick={pick}
      onIgnore={(ref) => void answer(ref, IGNORE)}
      task={() => { const t = top(); return t.name === "task" ? t.id : null; }}
      onTask={openTask}
      machine={() => { const t = top(); return t.name === "host" ? t.host : null; }}
      onMachine={openHost}
      onSettings={openTeam}
      rules={() => { const n = top().name; return n === "rules" || n === "doc"; }}
      onRules={() => openRules()}
      onHelp={() => help.set(true)}
      onClose={inDrawer ? () => drawer.set(false) : undefined}
      chrome={!inDrawer}
      onCollapse={inDrawer ? undefined : () => sidebarOpen.set(false)}
      home={onChannel}
      onHome={() => { drawer.set(false); nav.popToRoot(); }}
    />
  );
  /** The channel: the timeline and the composer. */
  const channelPage = () => (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={{ flex: 1 }}>
            <Scroll
              ref={(r) => { scroller = r; scrollY = 0; }}
              style={{ flex: 1 }}
              scrollEventThrottle={100}
              keyboardShouldPersistTaps="handled"
              onScroll={(ev) => {
                const end = ev.contentSize.height - ev.offset.y - ev.size.height < 80;
                scrollY = ev.offset.y;
                if (end !== untracked(atEnd)) atEnd.set(end);
                if (end) unseen.set(0);
              }}
            >
              <View style={{ width: "100%", maxWidth: size.column + gutter() * 2, alignSelf: "center", paddingHorizontal: gutter(), paddingTop: wide() ? 24 : 12, paddingBottom: 24 }}>
                <If when={suggest()}>
                  <View
                    testID="notify-banner"
                    style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, marginBottom: 8, borderRadius: radius.card, borderWidth: 1, borderColor: alpha(colors.accent, 0.3), backgroundColor: tints.accent }}
                  >
                    <Icon name="bell" size={20} tint={colors.accent} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>开启通知？</Text>
                      <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted }}>需要你拍板时第一时间推送到这台手机，通知上就能直接选。</Text>
                    </View>
                    <View style={{ gap: 6 }}>
                      <Btn
                        label="开启"
                        kind="primary"
                        testID="notify-banner-enable"
                        onPress={() => {
                          dismissSuggest();
                          if (push.canAsk()) push.enable();
                          else if (wide()) show({ name: "team" });
                          else show({ name: "team" }, { name: "notify" });
                        }}
                      />
                      <Btn label="以后再说" kind="ghost" testID="notify-banner-later" onPress={dismissSuggest} />
                    </View>
                  </View>
                </If>
                <If when={!hub.loaded()}>
                  <View style={{ alignItems: "center", paddingTop: 120, gap: 14 }}>
                    <Spinner size={22} tint={colors.muted} />
                    <Text style={{ fontSize: 15, color: colors.muted }}>正在载入频道…</Text>
                  </View>
                </If>
                <If when={hub.loaded() && shown().length === 0}>
                  <View style={{ alignItems: "center", paddingTop: wide() ? 120 : 64, paddingBottom: 32, gap: 12 }}>
                    <Mark size={44} />
                    <Text style={{ fontSize: 30, fontWeight: "600", color: colors.text, letterSpacing: -0.4 }}>{greeting()}</Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: colors.muted, textAlign: "center" }}>团队在后台运转。需要你拍板的事会出现在这里。</Text>
                    <If when={!touch}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
                        <Kbd k="/" />
                        <Text style={{ fontSize: 14, color: colors.faint }}>开始输入</Text>
                        <View style={{ width: 12 }} />
                        <Kbd k="?" />
                        <Text style={{ fontSize: 14, color: colors.faint }}>全部快捷键</Text>
                      </View>
                    </If>
                  </View>
                </If>
                <Each of={timeline()} key={(r) => r.key}>
                  {(r) => {
                    const row = r();
                    if ("unread" in row) {
                      return (
                        <View testID="unread" style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 4 }}>
                          <View style={{ flex: 1, height: 1, backgroundColor: alpha(colors.danger, 0.4) }} />
                          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.danger }}>以下为新消息</Text>
                          <View style={{ flex: 1, height: 1, backgroundColor: alpha(colors.danger, 0.4) }} />
                        </View>
                      );
                    }
                    if ("day" in row) {
                      return (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 24, marginBottom: 8 }}>
                          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
                          <Text style={{ fontSize: 13, fontWeight: "500", color: colors.faint }}>{dayLabel(row.day)}</Text>
                          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
                        </View>
                      );
                    }
                    if (row.event.kind === "owner") {
                      const out = () => outbox().find((o) => o.id === row.event.id);
                      return <OwnerBubble hub={hub} event={row.event} out={out()} onRetry={() => { const o = out(); if (o) send(o.text, o.ref, o.id, o.files); }} onUndo={() => undo(row.event.id)} onRef={pick} />;
                    }
                    return (
                      <Message
                        hub={hub}
                        event={row.event}
                        answered={answered}
                        target={target}
                        onAnswer={answer}
                        onReply={reply}
                        cardRef={isAsk(row.event) ? (r) => cards.set(row.event.ref!, r) : undefined}
                      />
                    );
                  }}
                </Each>
              </View>
            </Scroll>

            <If when={!atEnd() && shown().length > 0}>
              <View style={{ position: "absolute", left: 0, right: 0, bottom: 12, alignItems: "center", pointerEvents: "box-none" }}>
                <View
                  role="button"
                  accessibilityLabel="跳到最新"
                  onPress={jumpToEnd}
                  hoverStyle={{ opacity: 0.92 }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    height: 38,
                    paddingHorizontal: 16,
                    borderRadius: 19,
                    backgroundColor: unseen() ? colors.accentFill : colors.surface,
                    borderWidth: 1,
                    borderColor: unseen() ? "transparent" : colors.border,
                    boxShadow: "0 6px 20px rgba(0,0,0,0.14)",
                  }}
                >
                  <Icon name="arrow-down" size={15} tint={unseen() ? colors.onAccent : colors.text} />
                  <Text style={{ fontSize: 14, fontWeight: "600", color: unseen() ? colors.onAccent : colors.text }}>
                    {unseen() ? `${unseen()} 条新消息` : "跳到最新"}
                  </Text>
                  <If when={!touch}>
                    <Kbd k="G" on={unseen() ? colors.onAccent : undefined} />
                  </If>
                </View>
              </View>
            </If>
          </View>

          {/* The composer: files dropped on it (or on the timeline above) attach their images. */}
          <View
            testID="composer-area"
            onFileDragEnter={() => dropping.set(true)}
            onFileDragLeave={() => dropping.set(false)}
            onFileDrop={({ uris }) => { dropping.set(false); void attachUris(uris); }}
            style={{ paddingHorizontal: wide() ? 32 : 10, paddingTop: 4, paddingBottom: keyboardFrame().height > 0 ? keyboardFrame().height + 8 : Math.max(12, safeArea().bottom + 8), transitionProperty: "padding-bottom", transitionDuration: keyboardFrame().duration }}
          >
            <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 8 }}>
              <If when={hub.conn() === "offline" || hub.conn() === "unauthorized"}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: radius.inset,
                    backgroundColor: hub.conn() === "unauthorized" ? tints.danger : tints.warn,
                  }}
                >
                  <Text style={{ flex: 1, fontSize: 14, color: hub.conn() === "unauthorized" ? colors.danger : colors.warn }}>
                    {hub.conn() === "unauthorized" ? "登录已过期，请重新登录。" : "与 noop 的连接断开了，正在自动重连…"}
                  </Text>
                  <If when={hub.conn() === "unauthorized"}>
                    <Btn label="重新登录" kind="danger" onPress={props.onConnection} />
                  </If>
                </View>
              </If>
              <If when={slash() != null}>
                <CommandList
                  items={commands()}
                  selected={commands().indexOf(pickedCommand()!)}
                  touch={touch}
                  onHover={(i) => cmdSel.set(i)}
                  onMove={(d) => { const n = untracked(commands).length; if (n) cmdSel.set((untracked(cmdSel) + d + n) % n); }}
                  onRun={(c) => runCommand(c)}
                  onClose={() => draft.set("")}
                  onManage={() => { draft.set(""); openTeam(); }}
                />
              </If>
              <View
                style={{
                  gap: 6,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: focused() || dropping() ? colors.accent : colors.fieldBorder,
                  ...(dropping() ? { borderStyle: "dashed" as const } : {}),
                  backgroundColor: colors.field,
                  paddingTop: 10,
                  paddingBottom: 8,
                  paddingLeft: 16,
                  paddingRight: 8,
                  boxShadow: "0 2px 10px rgba(0,0,0,0.05)",
                  transitionProperty: "border-color",
                  transitionDuration: 120,
                  ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
                }}
              >
                <If when={replyTo()}>
                  {(ref) => (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", height: 30, paddingLeft: 10, paddingRight: 4, borderRadius: 8, backgroundColor: tints.accent }}>
                      <Text style={{ fontSize: 14, fontWeight: "500", color: colors.accent }}>回复 {ref()}</Text>
                      <View
                        onPress={() => replyTo.set(null)}
                        role="button"
                        accessibilityLabel="取消回复"
                        tooltip={<Tip label="取消回复" shortcut="Esc" />}
                        hoverStyle={hovered()}
                        style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
                      >
                        <Icon name="close" size={13} tint={colors.accent} />
                      </View>
                    </View>
                  )}
                </If>
                <If when={attachments().length}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 2 }}>
                    <Each of={attachments()} key={(a) => a.id}>
                      {(a) => (
                        <View testID="attachment" accessibilityLabel={a().name} style={{ width: 64, height: 64 }}>
                          <Image
                            src={a().preview}
                            style={{ width: 64, height: 64, borderRadius: radius.inset, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inset, objectFit: "cover" }}
                          />
                          <View
                            testID="remove-attachment"
                            role="button"
                            accessibilityLabel={`移除 ${a().name}`}
                            tooltip={touch ? undefined : <Tip label="移除" />}
                            onPress={() => unattach(a().id)}
                            hoverStyle={{ opacity: 0.85 }}
                            style={{
                              position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 11,
                              alignItems: "center", justifyContent: "center",
                              backgroundColor: colors.text, borderWidth: 2, borderColor: colors.field,
                            }}
                          >
                            <Icon name="close" size={10} tint={colors.background} />
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
                <If when={attachNote()}>
                  {(note) => <Text testID="attach-note" style={{ fontSize: 13, color: colors.danger }}>{note()}</Text>}
                </If>
                <Input
                  testID="composer"
                  ref={(r) => (composer = r)}
                  multiline
                  submitBehavior={touch ? "newline" : "submit"}
                  onSubmit={submit}
                  value={draft()}
                  onChange={({ value }) => {
                    draft.set(value);
                    if (untracked(speech) !== "off" && value !== dictated) stopDictation(true);
                  }}
                  onSelectionChange={({ start, end }) => (caret = { start, end })}
                  onPaste={({ files, uris }) => {
                    for (const f of files) attach(f, f.name);
                    if (uris.length) void attachUris(uris);
                  }}
                  onFocus={() => focused.set(true)}
                  onBlur={() => focused.set(false)}
                  onContentSizeChange={({ size: s }) => inputHeight.set(Math.min(220, Math.max(28, s.height)))}
                  placeholder={replyTo() ? `回复 ${replyTo()}…` : wide() ? "给团队下指令，例如：把 nsh 的 gallery 在 Linux 上截图检查一遍" : "给团队下指令…"}
                  class="placeholder:text-faint"
                  style={{ height: inputHeight(), fontSize: size.text, lineHeight: 24, color: colors.text, paddingVertical: 2 }}
                />
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <View
                      testID="attach"
                      role="button"
                      accessibilityLabel="添加图片"
                      tooltip={touch ? undefined : <Tip label="添加图片（也可粘贴或拖入）" />}
                      onPress={() => void pickImages()}
                      hoverStyle={hovered()}
                      style={{ width: touch ? 40 : 32, height: touch ? 40 : 32, marginLeft: -8, borderRadius: radius.control, alignItems: "center", justifyContent: "center" }}
                    >
                      <Icon name="image" size={18} tint={colors.muted} />
                    </View>
                    <If when={canDictate()}>
                      <View
                        testID="dictate"
                        role="button"
                        accessibilityLabel={speech() === "off" ? "语音输入" : "停止语音输入"}
                        accessibilityState={{ selected: speech() !== "off" }}
                        tooltip={touch ? undefined : <Tip label={speech() === "off" ? "语音输入" : "停止语音输入"} />}
                        onPress={toggleDictation}
                        hoverStyle={speech() === "off" ? hovered() : { opacity: 0.85 }}
                        style={{
                          width: touch ? 40 : 32,
                          height: touch ? 40 : 32,
                          borderRadius: radius.control,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: speech() === "off" ? undefined : tints.danger,
                          transitionProperty: "background-color",
                          transitionDuration: 120,
                        }}
                      >
                        <Icon name="mic" size={18} tint={speech() === "off" ? colors.muted : colors.danger} />
                      </View>
                    </If>
                    <If when={speech() !== "off"}>
                      <Text testID="dictating" style={{ fontSize: 13, color: colors.danger, numberOfLines: 1 }}>
                        {speech() === "on" ? "正在听…" : "正在识别…"}
                      </Text>
                    </If>
                  </View>
                  <View
                    testID="send"
                    role="button"
                    accessibilityLabel="发送"
                    accessibilityState={{ disabled: !canSend() }}
                    onPress={submit}
                    tooltip={touch ? undefined : <Tip label="发送" shortcut="Enter" />}
                    hoverStyle={canSend() ? { opacity: 0.9 } : undefined}
                    style={{
                      height: touch ? 40 : 36,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 14,
                      borderRadius: radius.control,
                      backgroundColor: canSend() ? colors.accentFill : colors.raised,
                      transitionProperty: "background-color",
                      transitionDuration: 120,
                    }}
                  >
                    <Text style={{ fontSize: 15, fontWeight: "600", color: canSend() ? colors.onAccent : colors.faint }}>发送</Text>
                    <Icon name="arrow-up" size={15} tint={canSend() ? colors.onAccent : colors.faint} />
                  </View>
                </View>
              </View>
            </View>
          </View>
      </View>
  );

  const gutter = () => (wide() ? 32 : 16);
  const titleOf = (r: Route): string => {
    switch (r.name) {
      case "channel": return "团队频道";
      case "team": return wide() ? "团队设置" : "设置";
      case "task": return `任务 ${r.id}`;
      case "host": return `机器 ${r.host}`;
      case "notify": return "通知";
      case "member": return r.id;
      case "routine": return r.routine;
      case "rules": return "团队规则与记忆";
      case "doc": return r.path.split("/").pop()!.replace(/\.md$/i, "");
    }
  };
  /** The back button's label, the page below's short name. */
  const backTitle = (r: Route | undefined) => (!r ? "" : r.name === "channel" ? "频道" : r.name === "team" ? "设置" : r.name === "host" ? "机器" : r.name === "rules" ? "规则与记忆" : titleOf(r));
  const below = (r: Route) => { const rs = nav.routes(); const i = rs.indexOf(r); return i > 0 ? rs[i - 1] : undefined; };
  const connPill = () => (
    <View
      tooltip={<Tip label={hub.cfg.url} />}
      accessibilityLabel={connLabel()}
      testID="conn"
      style={{ flexDirection: "row", alignItems: "center", gap: 7, height: 30, paddingHorizontal: wide() ? 10 : 11, borderRadius: 15, backgroundColor: hub.conn() === "unauthorized" ? tints.danger : colors.raised }}
    >
      <Dot tone={connTone()} />
      <If when={wide()}>
        <Text style={{ fontSize: 13.5, color: hub.conn() === "unauthorized" ? colors.danger : colors.muted }}>{connLabel()}</Text>
      </If>
    </View>
  );
  /** The page header on desktops and the web; phones use the system header. */
  const Bar = (p: { route: Route }) => (
    <View
      desktop={{ windowDrag: true }}
      style={{
        height: size.bar,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingLeft: (wide() && sidebarOpen() ? 0 : hasWindow ? titleBar().left : 0) + (wide() ? 24 : 8),
        paddingRight: (hasWindow ? titleBar().right : 0) + (wide() ? 16 : 8),
        borderBottomWidth: 1,
        borderBottomColor: colors.line,
        backgroundColor: colors.background,
      }}
    >
      <If when={!wide() && p.route === CHANNEL}>
        <ToolButton icon="menu" label="菜单" onPress={() => drawer.set(true)} />
      </If>
      <If when={wide() && !sidebarOpen()}>
        <ToolButton icon="sidebar" label="显示侧栏" shortcut={keymap.label("mod+b")} onPress={() => sidebarOpen.set(true)} />
      </If>
      <If when={below(p.route)}>
        {(b) => (
          <View
            role="button"
            accessibilityLabel={`返回${backTitle(b())}`}
            onPress={() => nav.pop()}
            hoverStyle={hovered()}
            style={{ height: touch ? 44 : 36, flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 10, borderRadius: radius.control }}
          >
            <Icon name="back" size={18} tint={colors.accent} />
            <Text style={{ fontSize: 15, fontWeight: "500", color: colors.accent }}>{backTitle(b())}</Text>
          </View>
        )}
      </If>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{titleOf(p.route)}</Text>
      </View>
      {connPill()}
      <If when={!wide() && p.route === CHANNEL}>
        <ToolButton icon="sliders" label="设置" onPress={openTeam} testID="settings-top" />
      </If>
    </View>
  );
  const content = (r: Route) => {
    switch (r.name) {
      case "channel": return channelPage();
      case "task": return <TaskDetail hub={hub} id={r.id} wide={wide()} />;
      case "host": return <MachineDetail hub={hub} host={r.host} wide={wide()} onTask={openTask} />;
      case "team":
        return (
          <If
            when={wide()}
            else={<PhoneSettings hub={hub} push={push} settings={settings} onOpen={(x) => nav.push(x)} onDisconnect={props.onDisconnect} />}
          >
            <TeamSettings hub={hub} push={push} settings={settings} wide={wide()} onRules={() => openRules(true)} onConnection={props.onConnection} onDisconnect={props.onDisconnect} />
          </If>
        );
      case "notify": return <PhoneNotify push={push} settings={settings} />;
      case "member": return <PhoneMember id={r.id} settings={settings} />;
      case "routine": return <PhoneRoutine name={r.routine} settings={settings} />;
      case "rules": return <RulesList hub={hub} onOpen={(path) => nav.push({ name: "doc", path })} />;
      case "doc": return <RuleDoc hub={hub} path={r.path} wide={wide()} />;
    }
  };

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}>
      <If when={wide() && sidebarOpen()}>
        <View style={{ width: size.sidebar, borderRightWidth: 1, borderRightColor: colors.sidebarBorder }}>{sidebar(false)}</View>
      </If>
      <NavStack state={nav} testID="pages" style={{ flex: 1, minWidth: 0 }}>
        {(route, index) => (
          <NavPage
            testID={`page-${route.name}`}
            // with the sidebar beside it, a page picked there replaces the view at once; only a page opened from a page slides in
            animation={wide() && index() <= 1 ? "none" : "default"}
            title={titleOf(route)}
            header={systemHeader ? undefined : <Bar route={route} />}
            headerBackTitle={backTitle(route)}
            headerLeft={systemHeader && route === CHANNEL && !wide() ? <ToolButton icon="menu" label="菜单" onPress={() => drawer.set(true)} /> : undefined}
            ios={{ headerLeftSymbol: "sidebar.left", headerRightSymbol: "gearshape" }}
            headerTitle={
              // iOS: the bar's buttons are UIKit's own, so the connection sits by the title.
              platform.os === "ios" && route === CHANNEL ? (
                <View testID="conn" accessibilityLabel={connLabel()} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                  <Dot tone={connTone()} />
                  <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{titleOf(route)}</Text>
                </View>
              ) : undefined
            }
            headerRight={
              platform.os === "ios" ? (
                route === CHANNEL ? <ToolButton icon="sliders" label="设置" onPress={openTeam} testID="settings-top" /> : undefined
              ) : systemHeader ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  {connPill()}
                  <If when={route === CHANNEL}>
                    <ToolButton icon="sliders" label="设置" onPress={openTeam} testID="settings-top" />
                  </If>
                </View>
              ) : undefined
            }
            style={{ backgroundColor: colors.background }}
          >
            {content(route)}
          </NavPage>
        )}
      </NavStack>

      {/* Phones: the sidebar slides in from the left edge. */}
      <Sheet
        testID="drawer"
        side="left"
        open={drawer() && !wide()}
        onOpenChange={({ open }) => { if (!open) drawer.set(false); }}
        backdropClass="bg-scrim"
        popupStyle={{ width: Math.min(size.sidebar + 16, windowSize().width * 0.86), paddingTop: touch ? safeArea().top : 0, backgroundColor: colors.sidebar }}
      >
        {sidebar(true)}
      </Sheet>

      <If when={toast()}>
        {(t) => (
          <View style={{ position: "absolute", top: size.bar + 10, left: 0, right: 0, alignItems: "center", paddingHorizontal: 12, pointerEvents: "box-none" }}>
            <View
              role="button"
              testID="toast"
              accessibilityLabel={`查看 ${t().ref}`}
              onPress={() => {
                const ref = t().ref; // read before clearing: the toast's accessor is null after set(null)
                toast.set(null);
                pick(ref);
              }}
              style={{
                maxWidth: 520,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
                boxShadow: "0 10px 30px rgba(0,0,0,0.16)",
              }}
            >
              <Dot tone="wait" />
              <Text style={{ flexShrink: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>
                <Text style={{ fontWeight: "600" }}>新决策 {t().ref}</Text> · {t().text}
              </Text>
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.accent }}>查看</Text>
            </View>
          </View>
        )}
      </If>

      <HelpSheet open={help()} onClose={() => help.set(false)} />
    </View>
  );
}

// ---------------------------------------------------------------- connect

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  masked?: boolean;
  testID?: string;
  hint?: string;
  autoFocus?: boolean;
  keyboardType?: "email-address" | "number-pad" | "url";
  autoComplete?: "email" | "one-time-code" | "url";
  maxLength?: number;
  big?: boolean;
}) {
  const focused = signal(false);
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      <Input
        testID={props.testID}
        value={props.value}
        masked={props.masked}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={props.placeholder}
        class="placeholder:text-faint"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
        onChange={({ value }) => props.onChange(value)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        style={{
          height: props.big ? 56 : 44,
          paddingHorizontal: 14,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: focused() ? colors.accent : colors.fieldBorder,
          backgroundColor: colors.field,
          fontSize: 16,
          color: colors.text,
          ...(props.big ? { fontSize: 26, letterSpacing: 10, textAlign: "center", fontVariant: ["tabular-nums"] } : {}),
          ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{props.hint}</Text>
      </If>
    </View>
  );
}

const RESEND = 60;

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("unreachable");
  }
  let data: Record<string, unknown> = {};
  try {
    data = ((await r.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { status: r.status, data };
}

/** Login: the email gets a one-time code. On the web served by the hub the server is the page's own origin. */
function Login(props: { url: string; served: boolean; email: string; notice?: string; onLogin: (c: Config) => void }) {
  const url = signal(props.url);
  const editUrl = signal(!props.served);
  const email = signal(props.email);
  const code = signal("");
  const step = signal<"email" | "code">("email");
  const error = signal(props.notice ?? "");
  const busy = signal(false);
  const wait = signal(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  cleanup(() => clearInterval(timer));
  const server = () => normalizeUrl(url());
  const unreachable = () => `连不上服务器 ${server()}，请检查地址和网络`;

  const viaCli = signal(false); // email not set up yet: the code is shown by `noop login` on the owner's machine
  async function sendCode() {
    const e = email().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return error.set("请填写有效的邮箱地址");
    if (!server()) return error.set("请填写服务器地址");
    busy.set(true);
    error.set("");
    try {
      const r = await postJson(`${server()}/api/auth/start`, { email: e });
      if (r.status === 429) throw new Error(String(r.data.error ?? "请求太频繁，请稍后再试"));
      if (r.status === 503) throw new Error("服务器还没有配置发信，暂时无法用邮箱登录");
      if (r.status >= 400) throw new Error(`服务器返回 ${r.status}，这个地址可能不是 noop`);
      await Storage.setItem(KEYS.email, e);
      viaCli.set(r.data.delivery === "cli");
      code.set("");
      step.set("code");
      wait.set(RESEND);
      clearInterval(timer);
      timer = setInterval(() => {
        wait.update((w) => Math.max(0, w - 1));
        if (untracked(wait) === 0) clearInterval(timer);
      }, 1000);
    } catch (err) {
      error.set(err instanceof Error && err.message !== "unreachable" ? err.message : unreachable());
    } finally {
      busy.set(false);
    }
  }

  async function verify() {
    const c = code().replace(/\D/g, "");
    if (c.length !== 6 || busy()) return;
    busy.set(true);
    error.set("");
    try {
      const r = await postJson(`${server()}/api/auth/verify`, { email: email().trim(), code: c });
      if (r.status === 401) throw new Error("验证码不对或已过期，请重新输入");
      if (r.status === 429) throw new Error(String(r.data.error ?? "尝试太频繁，请稍后再试"));
      if (r.status >= 400 || typeof r.data.session !== "string") throw new Error(`服务器返回 ${r.status}`);
      await Storage.setItem(KEYS.url, server());
      await Storage.setItem(KEYS.token, r.data.session);
      props.onLogin({ url: server(), token: r.data.session });
    } catch (err) {
      code.set("");
      error.set(err instanceof Error && err.message !== "unreachable" ? err.message : unreachable());
    } finally {
      busy.set(false);
    }
  }
  const onCode = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    code.set(digits);
    if (digits.length === 6) verify();
  };

  return (
    <Scroll style={{ flex: 1, backgroundColor: colors.background }} keyboardShouldPersistTaps="handled">
      <View style={{ minHeight: windowSize().height - (touch ? safeArea().top : 0), alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingTop: 48, paddingBottom: 48 }}>
        <View style={{ width: "100%", maxWidth: 440, gap: 24 }}>
          <View style={{ alignItems: "center", gap: 12 }}>
            <Mark size={48} />
            <Text style={{ fontSize: 28, fontWeight: "600", color: colors.text, letterSpacing: -0.3 }}>登录 noop</Text>
            <Text style={{ fontSize: 15.5, lineHeight: 23, color: colors.muted, textAlign: "center" }}>
              {step() === "email" ? "用邮箱登录：我们会发一个 6 位验证码给你。" : viaCli() ? "还没配置发信邮箱：在你的主机终端运行 noop login 查看验证码。" : `验证码已发到 ${email().trim()}，请查收邮件。`}
            </Text>
          </View>
          <View style={{ gap: 18, padding: 22, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <If
              when={step() === "code"}
              else={
                <>
                  <Field
                    label="邮箱"
                    value={email()}
                    onChange={(v) => email.set(v)}
                    onSubmit={sendCode}
                    placeholder="you@example.com"
                    keyboardType="email-address"
                    autoComplete="email"
                    autoFocus
                    testID="email"
                  />
                  <If
                    when={editUrl()}
                    else={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Dot tone="on" />
                        <Text style={{ flex: 1, fontSize: 14, color: colors.muted, numberOfLines: 1 }}>服务器：{server()}</Text>
                        <View role="button" accessibilityLabel="更改服务器" onPress={() => editUrl.set(true)} hoverStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}>
                          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.accent }}>更改</Text>
                        </View>
                      </View>
                    }
                  >
                    <Field label="服务器地址" value={url()} onChange={(v) => url.set(v)} onSubmit={sendCode} placeholder="https://noop.<你的账号>.workers.dev" keyboardType="url" testID="url" hint="你的 noop 地址：安装完成时显示，也可以在主机上运行 noop status --brief 查看" />
                  </If>
                </>
              }
            >
              <Field
                label="验证码"
                value={code()}
                onChange={onCode}
                onSubmit={verify}
                placeholder="······"
                keyboardType="number-pad"
                autoComplete="one-time-code"
                autoFocus
                big
                testID="code"
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View role="button" accessibilityLabel="换个邮箱" onPress={() => { step.set("email"); error.set(""); }} hoverStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}>
                  <Text style={{ fontSize: 14, color: colors.muted }}>‹ 换个邮箱</Text>
                </View>
                <View style={{ flex: 1 }} />
                <View
                  role="button"
                  testID="resend"
                  accessibilityLabel="重新发送"
                  accessibilityState={{ disabled: wait() > 0 }}
                  onPress={() => wait() === 0 && !busy() && sendCode()}
                  hoverStyle={wait() ? undefined : hovered()}
                  style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "500", color: wait() ? colors.faint : colors.accent, fontVariant: ["tabular-nums"] }}>
                    {wait() ? `重新发送（${wait()}s）` : "重新发送"}
                  </Text>
                </View>
              </View>
            </If>
            <If when={error()}>
              <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.control, backgroundColor: tints.danger }}>
                <Text testID="login-error" style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{error()}</Text>
              </View>
            </If>
            <If
              when={step() === "code"}
              else={<Btn testID="send-code" label={busy() ? "发送中…" : "发送验证码"} kind="primary" busy={busy()} grow onPress={sendCode} />}
            >
              <Btn testID="verify" label={busy() ? "登录中…" : "登录"} kind="primary" busy={busy()} disabled={code().length !== 6} grow onPress={verify} />
            </If>
          </View>
        </View>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- app

function Connected(props: { config: Config; openRef: string | null; onExpired: () => void; onLogout: () => void }) {
  const hub = createHub(props.config);
  cleanup(hub.dispose);
  // The service worker answers decisions from notifications with the session.
  hostCall("setSession", { session: props.config.token, origin: props.config.url });
  // A 401 on any call: the session is gone, back to the login.
  effect(() => {
    if (hub.conn() === "unauthorized") props.onExpired();
  });
  return (
    <Chat
      hub={hub}
      openRef={props.openRef}
      onConnection={props.onExpired}
      onDisconnect={async () => {
        const off = await hostCall<{ endpoint: string | null }>("pushDisable");
        if (off?.endpoint) await hub.api("POST", "/api/push/unsubscribe", { endpoint: off.endpoint });
        await hostCall("setSession", { session: null });
        hostCall("setBadge", { count: 0 });
        await hub.logout();
        props.onLogout();
      }}
    />
  );
}

function App() {
  if (hasWindow) {
    Window.setTitle("noop");
    Window.setTitleBar({ style: "hidden", height: size.bar });
  }
  Scrollbar.setTheme(scrollbarTheme);
  const ready = signal(false);
  const config = signal<Config | null>(null);
  const url = signal("");
  const served = signal(false);
  const email = signal("");
  const notice = signal("");
  let openRef: string | null = null;
  loadConfig().then((r) => {
    openRef = r.ref;
    config.set(r.config);
    url.set(r.config?.url ?? r.suggested);
    served.set(r.served);
    email.set(r.email);
    ready.set(true);
  });
  async function forget(message: string) {
    await Storage.removeItem(KEYS.token);
    email.set((await Storage.getItem(KEYS.email)) ?? untracked(email));
    notice.set(message);
    config.set(null);
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: touch && !(systemHeader && config()) ? safeArea().top : 0 }}>
      <If when={ready()}>
        <If
          when={config()}
          else={
            <Login
              url={url()}
              served={served()}
              email={email()}
              notice={notice()}
              onLogin={(c) => {
                notice.set("");
                url.set(c.url);
                config.set(c);
              }}
            />
          }
        >
          {(c) => <Connected config={c()} openRef={openRef} onExpired={() => forget("登录已过期，请重新登录")} onLogout={() => forget("")} />}
        </If>
      </If>
    </View>
  );
}

mount(App);

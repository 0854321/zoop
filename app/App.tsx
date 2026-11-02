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
  mount,
  platform,
  safeArea,
  Scroll,
  type ScrollRef,
  setColorScheme,
  signal,
  Storage,
  Text,
  untracked,
  Video,
  View,
  windowSize, token } from "nsh";
import type { InputRef, JSX, ViewStyle } from "nsh";
import { Input, Scrollbar } from "nsh/base";
import { isAvailable as hasWindow, titleBar, Window } from "nsh/desktop";
import {
  alpha,
  colors,
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
  rows,
  spans,
  type Status,
  TAGS,
  timeOf,
  waiting,
  wsUrl,
  autonomyLabel,
  cliKey,
  cliLabel,
  intervalsWith,
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
} from "./hub";

type Config = { url: string; token: string };
/** `token` holds the login session (sent as `Bearer`, and `?token=` on the WebSocket and media URLs). */
const KEYS = { url: "hub.url", token: "hub.token", email: "hub.email", theme: "hub.theme", seen: "hub.lastSeen", notifyAsked: "hub.notifyAsked" };
const touch = !platform.desktop;
const MONO = "monospace";

/** Sizes: the gallery's proportions, a step larger (the owner reads this all day). */
const size = {
  text: 16,
  line: 25,
  small: 14,
  tiny: 12.5,
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

  async function send(text: string, replyTo: string | null) {
    const r = await fetch(`${cfg.url}/api/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(replyTo ? { text, reply_to: replyTo } : { text }),
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

function Dot(props: { tone: "on" | "run" | "wait" | "off" | "bad" }) {
  const color = () => ({ on: colors.up, run: colors.up, wait: colors.warn, off: colors.faint, bad: colors.danger })[props.tone];
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

function Rich(props: { text: string; muted?: boolean }) {
  return (
    <Text style={{ fontSize: props.muted ? size.small : size.text, lineHeight: props.muted ? 21 : size.line, color: props.muted ? colors.muted : colors.text }}>
      <Each of={spans(props.text)} key="index">
        {(s) =>
          s().code ? (
            <Text style={{ fontFamily: MONO, fontSize: props.muted ? 13 : 14.5, backgroundColor: alpha(colors.text, 0.07), color: colors.text }}>{` ${s().text} `}</Text>
          ) : s().bold ? (
            <Text style={{ fontWeight: "600" }}>{s().text}</Text>
          ) : (
            <Text>{s().text}</Text>
          )
        }
      </Each>
    </Text>
  );
}

function Media(props: { hub: Hub; path: string }) {
  const src = mediaUrl(props.hub.cfg.url, props.hub.cfg.token, props.path);
  const ratio = signal(16 / 10);
  const frame: ViewStyle = { width: "100%", borderRadius: radius.inset, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inset };
  return isVideo(props.path) ? (
    <Video src={src} controls paused style={{ ...frame, aspectRatio: 16 / 9 }} />
  ) : (
    <Image
      src={src}
      onLoad={({ size }) => size.width && size.height && ratio.set(size.width / size.height)}
      style={{ ...frame, aspectRatio: ratio(), maxHeight: 560, objectFit: "contain" }}
    />
  );
}

// ---------------------------------------------------------------- timeline

/** A message the owner sent that the hub has not confirmed yet (optimistic send). */
type Outgoing = { id: string; ts: string; text: string; ref: string | null; state: "held" | "sending" | "failed" };

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
  return full ? full.trim() : choiceLabel(c);
}

function OwnerBubble(props: { event: HubEvent; out?: Outgoing; onRetry?: () => void; onUndo?: () => void }) {
  const e = props.event;
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingVertical: 8 }}>
      <View style={{ maxWidth: "82%", alignItems: "flex-end", gap: 4 }}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 11,
            borderRadius: 18,
            borderBottomRightRadius: 6,
            backgroundColor: tints.accent,
            borderWidth: 1,
            borderColor: alpha(colors.accent, 0.18),
            opacity: props.out ? 0.65 : 1,
            gap: 4,
          }}
        >
          <If when={e.ref}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.accent }}>↳ {e.ref}</Text>
          </If>
          <Rich text={e.text} />
        </View>
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
  onLayout?: (y: number) => void;
}) {
  const e = props.event;
  const ask = isAsk(e);
  const tag = TAGS[e.kind];
  const body = (
    <View selectable style={{ gap: 10 }}>
      <Rich text={e.text} muted={e.kind === "system"} />
      <If when={e.attachments?.length}>
        <View style={{ gap: 10 }}>
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
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 4, paddingLeft: 50 }} onLayout={({ bounds }) => props.onLayout?.(bounds.origin.y)}>
        <Text style={{ fontSize: size.tiny, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
        <Text style={{ flex: 1, fontSize: 14, color: colors.muted }}>{e.text}</Text>
      </View>
    );
  return (
    <View style={{ flexDirection: "row", gap: 14, paddingVertical: 10 }} onLayout={({ bounds }) => props.onLayout?.(bounds.origin.y)}>
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
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
              opacity: done() ? 0.62 : 1,
              overflow: "hidden",
              transitionProperty: "border-color, opacity",
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
            <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 }}>{body}</View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.inset }}>
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
            </View>
          </View>
        ) : (
          body
        )}
      </View>
    </View>
  );
}

/** A task's state: its label, color and mark. */
const STATE: Record<string, [string, string, string]> = {
  active: ["进行中", colors.up, "●"], inbox: ["排队中", colors.muted, "○"], waiting: ["等子任务", colors.muted, "○"],
  blocked: ["等你决定", colors.warn, "!"], failed: ["失败", colors.danger, "✕"], done: ["完成", colors.up, "✓"],
};

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
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 24 }}>
        <If when={t()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{`${props.id} 已经不在最近的任务里了。`}</Text>}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Badge label={STATE[t()!.state ?? ""]?.[0] ?? t()!.state ?? ""} tone={t()!.state === "failed" ? "danger" : t()!.state === "blocked" ? "warn" : "neutral"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{t()!.id}</Text>
            </View>
            <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{t()!.title}</Text>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {[displayName(t()!.agent), t()!.host, t()!.state === "active" ? `已运行 ${since(t()!.started)}` : t()!.finished ? `${since(t()!.finished)}前结束` : "",
                Number(t()!.attempt ?? 1) > 1 ? `第 ${t()!.attempt} 次` : ""].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <If when={t()!.request}>
            {section("请求")}
            <Text style={{ userSelect: "text", fontSize: 15, lineHeight: 23, color: colors.text }}>{t()!.request}</Text>
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
                  <View style={{ flexDirection: "row", gap: 12 }}>
                    <Text style={{ width: 44, fontSize: 13.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{st().time ?? ""}</Text>
                    <Text style={{ flex: 1, fontSize: 14, lineHeight: 21, color: colors.muted }}>{st().text.trim()}</Text>
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
  task: () => string | null;
  onTask: (id: string) => void;
  onSettings: () => void;
  onHelp: () => void;
  onClose?: () => void;
  chrome?: boolean;
}) {
  const s = () => props.hub.status();
  const waits = computed(() => waiting(s()));
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
      </View>
      <Scroll style={{ flex: 1 }}>
        <View style={{ paddingBottom: 16, gap: 1 }}>
          <SideHeading title="待你决定" count={waits().length || undefined} accent />
          <Each of={waits()} key={(d) => d.id}>
            {(d) => (
              <SideRow onPress={() => props.onPick(d().id)} title={d().id}>
                <Dot tone="wait" />
                <Text style={rowText()}>{d().question || d().id}</Text>
                <Text style={{ fontFamily: MONO, fontSize: 12, color: colors.faint }}>{d().id}</Text>
              </SideRow>
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

          <If when={s()?.recent?.length}>
            <SideHeading title="最近" />
            <Each of={(s()?.recent ?? []).slice(0, 6)} key={(a) => a.id}>
              {(a) => (
                <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={a().id}>
                  <Text style={{ width: 14, fontSize: 13, color: STATE[a().state ?? ""]?.[1] ?? colors.faint }}>{STATE[a().state ?? ""]?.[2] ?? "·"}</Text>
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().updated)}</Text>
                </SideRow>
              )}
            </Each>
          </If>

          <SideHeading title="机器" count={s()?.hosts.length || undefined} />
          <Each of={s()?.hosts ?? []} key={(h) => h.host}>
            {(h) => (
              <SideRow title={`负载 ${loadOf(h())}% · 磁盘 ${h().stats?.diskFreeGB ?? "?"}GB · ${h().busy ?? 0} 个运行中`}>
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

function Toggle(props: { on: boolean; onPress: () => void; label: string; testID?: string }) {
  return (
    <View
      role="switch"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.on }}
      onPress={props.onPress}
      focusStyle={focusRing()}
      style={{
        width: 40,
        height: 24,
        borderRadius: 12,
        padding: 3,
        backgroundColor: props.on ? colors.accentFill : colors.track,
        borderWidth: 1,
        borderColor: props.on ? "transparent" : colors.border,
        transitionProperty: "background-color",
        transitionDuration: 180,
      }}
    >
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: props.on ? colors.onAccent : colors.knob,
          transform: [{ translateX: props.on ? 16 : 0 }],
          transitionProperty: "transform",
          transitionDuration: 180,
        }}
      />
    </View>
  );
}

/** A settings section: the gallery's Card (a title above one flat surface). */
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
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
    } catch {
      return "Asia/Shanghai";
    }
  })();
  const prefs = () => notifyPrefsOf(props.view, tz);
  const setPrefs = (change: Partial<NotifyPrefs>) => props.save(notifyPatch({ ...prefs(), ...change, tz }));
  const row: ViewStyle = { gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.line };
  const state = () => {
    const i = push.info();
    if (!i) return "这个环境不支持网页推送（请用手机浏览器打开 hub 的网页）";
    if (push.needsHomeScreen()) return "iPhone 需要先把 noop 添加到主屏幕";
    if (!i.supported) return "这个浏览器不支持网页推送";
    if (i.permission === "denied") return "通知被浏览器拦截了";
    return i.subscribed ? "已开启" : "未开启";
  };
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
                  on={prefs().kinds[k()[0]]}
                  onPress={() => setPrefs({ kinds: { ...prefs().kinds, [k()[0]]: !prefs().kinds[k()[0]] } })}
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

function TeamSettings(props: { hub: Hub; push: Push; wide: boolean; onConnection: () => void; onDisconnect: () => void }) {
  const view = signal<SettingsView | null>(null);
  const error = signal("");
  const saved = signal("");
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(savedTimer));
  props.hub.settings().then((v) => view.set(v), (e) => error.set(String(e?.message ?? e)));

  async function save(patch: Record<string, unknown>) {
    error.set("");
    try {
      view.set(await props.hub.settings(patch));
      saved.set("已保存");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => saved.set(""), 1600);
    } catch (e) {
      error.set(e instanceof Error ? e.message : String(e));
    }
  }
  const eff = () => view()?.effective;
  const row: ViewStyle = { gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.line };
  const chips: ViewStyle = { flexDirection: "row", flexWrap: "wrap", gap: 6 };

  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 28, paddingHorizontal: props.wide ? 32 : 16, paddingTop: props.wide ? 28 : 18, paddingBottom: 48 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ fontSize: 24, fontWeight: "600", color: colors.text, letterSpacing: -0.2 }}>团队设置</Text>
            <Text style={{ fontSize: 15, lineHeight: 22, color: colors.muted }}>Claude Opus 做有挑战的活，Codex 做例行的活；随时可以在这里调整。</Text>
          </View>
          <Text style={{ fontSize: 13.5, color: error() ? colors.danger : colors.up }}>{error() || saved()}</Text>
        </View>
        <NotifySettings push={props.push} view={view()} save={save} wide={props.wide} />
        <If when={eff()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{error() ? "" : "读取中…"}</Text>}>
          {(e) => (
            <View style={{ gap: 28 }}>
              <Group title="成员" hint="模型：先用哪个、失败或额度用尽时换哪个；自主程度：多大的事需要先问你">
                <Each of={e().agents} key={(a) => a.id}>
                  {(a, i) => (
                    <View style={{ ...row, borderTopWidth: i() === 0 ? 0 : 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                        <Avatar from={a().id} />
                        <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>{a().id}</Text>
                      </View>
                      <View style={props.wide ? { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 24, rowGap: 8 } : { gap: 8 }}>
                        <View style={chips}>
                          <Each of={view()!.options.clis}>
                            {(c) => (
                              <Chip
                                testID={`cli-${a().id}-${cliKey(c())}`}
                                label={cliLabel(c())}
                                on={cliKey(c()) === cliKey(a().clis)}
                                onPress={() => save(patches.clis(a().id, c()))}
                              />
                            )}
                          </Each>
                        </View>
                        <View style={chips}>
                          <Each of={view()!.options.autonomy}>
                            {(l) => (
                              <Chip
                                testID={`autonomy-${a().id}-${l()}`}
                                label={autonomyLabel(l())}
                                on={l() === a().autonomy}
                                onPress={() => save(patches.autonomy(a().id, l()))}
                              />
                            )}
                          </Each>
                        </View>
                      </View>
                    </View>
                  )}
                </Each>
              </Group>

              <Group title="例行任务" hint="开关与运行间隔">
                <Each of={e().routines} key={(r) => r.name}>
                  {(r, i) => (
                    <View style={{ ...row, borderTopWidth: i() === 0 ? 0 : 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                        <Toggle
                          testID={`routine-${r().name}`}
                          label={r().name}
                          on={r().enabled}
                          onPress={() => save(patches.routine(r().name, { enabled: !r().enabled }))}
                        />
                        <Text style={{ flex: 1, fontSize: 15.5, color: r().enabled ? colors.text : colors.faint }}>{r().name}</Text>
                        <Text style={{ fontSize: 13, color: colors.faint }}>{r().agent}</Text>
                      </View>
                      <View style={{ ...chips, paddingLeft: 52 }}>
                        <Each of={intervalsWith(r().every)}>
                          {(iv) => (
                            <Chip
                              testID={`every-${r().name}-${iv()}`}
                              label={iv()}
                              on={iv() === r().every}
                              onPress={() => save(patches.routine(r().name, { every: iv() }))}
                            />
                          )}
                        </Each>
                      </View>
                    </View>
                  )}
                </Each>
              </Group>

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
            </View>
          )}
        </If>
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
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- keyboard help

const SHORTCUTS: [string, string][] = [
  ["Enter", "发送"],
  ["Shift+Enter", "换行"],
  [`${keymap.label("mod+enter")}`, "发送（任何时候）"],
  [`/  ·  ${keymap.label("mod+k")}`, "聚焦输入框"],
  ["1 – 9", "选择当前决策的选项"],
  ["J / K", "下一个 / 上一个待决策"],
  ["R", "回复当前决策（其他指示）"],
  ["G", "跳到最新消息"],
  ["Esc", "取消回复 / 离开输入框 / 关闭"],
  [keymap.label("mod+,"), "团队设置"],
  [keymap.label("mod+b"), "显示 / 隐藏侧栏"],
  [keymap.label("mod+shift+l"), "切换浅色 / 深色"],
  ["?", "快捷键一览"],
];

function HelpSheet(props: { onClose: () => void }) {
  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 16 }}>
      <View onPress={props.onClose} accessibilityLabel="关闭快捷键" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.35)" }} />
      <View
        style={{
          width: "100%",
          maxWidth: 520,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          boxShadow: "0 24px 60px rgba(0,0,0,0.25)",
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
        <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingBottom: 16 }}>单键快捷键在输入框里不生效，先按 Esc 离开输入框。</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- chat

function Chat(props: { hub: Hub; openRef?: string | null; onConnection: () => void; onDisconnect: () => void }) {
  const hub = props.hub;
  const push = createPush(hub);
  const wide = () => windowSize().width >= 860;
  const drawer = signal(false);
  const sidebarOpen = signal(true);
  const help = signal(false);
  const page = signal<"channel" | "team" | "task">("channel");
  const taskId = signal<string | null>(null);
  const openTask = (id: string) => { taskId.set(id); page.set("task"); drawer.set(false); };
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
      outbox().map((o) => ({ id: o.id, ts: o.ts, from: "owner", kind: "owner" as const, text: o.text, ref: o.ref ?? undefined })),
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
  const cardY = new Map<string, number>();
  let scroller: ScrollRef | undefined;
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
    if (page() !== "channel") page.set("channel");
    composer?.focus();
  };

  // A message waits a few seconds before it leaves, so a wrong tap or a typo can be taken back.
  const UNDO_MS = 5000;
  const holds = new Map<string, ReturnType<typeof setTimeout>>();
  function send(text: string, ref: string | null, id = `local:${++seq}`) {
    const ts = new Date().toISOString();
    outbox.update((o) => [...o.filter((x) => x.id !== id), { id, ts, text, ref, state: "held" }]);
    jumpToEnd();
    holds.set(id, setTimeout(() => { holds.delete(id); void deliver(id); }, UNDO_MS));
  }
  function undo(id?: string) {
    const o = id ? outbox().find((x) => x.id === id) : [...outbox()].reverse().find((x) => x.state === "held");
    if (!o || !holds.has(o.id)) return false;
    clearTimeout(holds.get(o.id));
    holds.delete(o.id);
    outbox.update((list) => list.filter((x) => x.id !== o.id));
    if (!/^[DLP]-[A-Z]?\d{4} \S+$/.test(o.text) || o.ref) { draft.set(o.text); replyTo.set(o.ref); composer?.focus(); }
    return true;
  }
  async function deliver(id: string) {
    const o = outbox().find((x) => x.id === id);
    if (!o) return;
    const { text, ref } = o;
    outbox.update((l) => l.map((x) => (x.id === id ? { ...x, state: "sending" } : x)));
    try {
      await hub.send(text, ref);
      outbox.update((o) => o.filter((x) => x.id !== id));
    } catch {
      outbox.update((o) => o.map((x) => (x.id === id ? { ...x, state: "failed" } : x)));
    }
  }
  function submit() {
    const v = draft().trim();
    if (!v) return;
    // A bare choice ("1", "B", "1,3", "全部") answers the decision the keyboard is on, never becomes a new task.
    const r = replyTo() ?? (/^([1-9](\s*[,，]\s*[1-9])*|[A-Za-z]|全部|都不要)$/.test(v) ? target() : null);
    draft.set("");
    replyTo.set(null);
    inputHeight.set(28);
    send(v, r);
  }
  const answer = (ref: string, c: string) => {
    hostCall("clearNotifications", { ref });
    return send(`${ref} ${c}`, null);
  };

  function pick(ref: string) {
    drawer.set(false);
    page.set("channel");
    chosen.set(ref);
    hostCall("clearNotifications", { ref });
    const y = cardY.get(ref);
    if (y !== undefined) {
      atEnd.set(false);
      scroller?.scrollTo({ y: Math.max(0, y - 120), animated: true });
    } else if (pending().some((e) => e.ref === ref)) reply(ref);
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
    if (!e || page() !== "channel") return;
    const c = choicesOf(e)[n];
    if (c) answer(e.ref!, c);
  }
  const openTeam = () => {
    drawer.set(false);
    page.set(page() === "team" ? "channel" : "team");
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
  keymap.bind("escape", () => {
    if (help()) help.set(false);
    else if (drawer()) drawer.set(false);
    else if (replyTo()) replyTo.set(null);
    else if (focused()) composer?.blur();
    else if (page() === "team") page.set("channel");
  }, { when: "always" });

  const connLabel = () => ({ connecting: "连接中…", live: "实时", offline: "已断开，重连中…", unauthorized: "登录已过期" })[hub.conn()];
  const connTone = () => (hub.conn() === "live" ? "on" : hub.conn() === "unauthorized" ? "bad" : hub.conn() === "offline" ? "wait" : "off");
  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      hub={hub}
      target={target}
      onPick={pick}
      task={() => (page() === "task" ? taskId() : null)}
      onTask={openTask}
      onSettings={openTeam}
      onHelp={() => help.set(true)}
      onClose={inDrawer ? () => drawer.set(false) : undefined}
      chrome={!inDrawer}
    />
  );
  const gutter = () => (wide() ? 32 : 16);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}>
      <If when={wide() && sidebarOpen()}>
        <View style={{ width: size.sidebar, borderRightWidth: 1, borderRightColor: colors.sidebarBorder }}>{sidebar(false)}</View>
      </If>
      <View style={{ flex: 1, minWidth: 0, backgroundColor: colors.background }}>
        {/* The toolbar: the gallery's DemoPane bar, a breadcrumb and the tools. */}
        <View
          desktop={{ windowDrag: true }}
          style={{
            height: size.bar,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingLeft: (wide() && sidebarOpen() ? 0 : hasWindow ? titleBar().left : 0) + (wide() ? 24 : 8),
            paddingRight: wide() ? 16 : 8,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
          }}
        >
          <If when={!wide()}>
            <ToolButton icon="menu" label="菜单" onPress={() => drawer.set(true)} />
          </If>
          <If when={wide() && !sidebarOpen()}>
            <ToolButton icon="sidebar" label="显示侧栏" shortcut={keymap.label("mod+b")} onPress={() => sidebarOpen.set(true)} />
          </If>
          <If when={page() !== "channel"}>
            <View
              role="button"
              accessibilityLabel="返回频道"
              onPress={() => page.set("channel")}
              hoverStyle={hovered()}
              style={{ height: 36, flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 10, borderRadius: radius.control }}
            >
              <Icon name="back" size={18} tint={colors.accent} />
              <Text style={{ fontSize: 15, fontWeight: "500", color: colors.accent }}>频道</Text>
            </View>
          </If>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{page() === "team" ? "团队设置" : page() === "task" ? `任务 ${taskId() ?? ""}` : "团队频道"}</Text>
            <If when={pending().length && page() === "channel"}>
              <Badge label={`${pending().length} 项待决定`} tone="warn" />
            </If>
          </View>
          <View
            tooltip={<Tip label={hub.cfg.url} />}
            accessibilityLabel={connLabel()}
            style={{ flexDirection: "row", alignItems: "center", gap: 7, height: 30, paddingHorizontal: wide() ? 10 : 11, borderRadius: 15, backgroundColor: hub.conn() === "unauthorized" ? tints.danger : colors.raised }}
          >
            <Dot tone={connTone()} />
            <If when={wide()}>
              <Text style={{ fontSize: 13.5, color: hub.conn() === "unauthorized" ? colors.danger : colors.muted }}>{connLabel()}</Text>
            </If>
          </View>
          <If when={wide() && sidebarOpen()}>
            <ToolButton icon="sidebar" label="隐藏侧栏" shortcut={keymap.label("mod+b")} on onPress={() => sidebarOpen.set(false)} />
          </If>
          <If when={!wide()}>
            <ToolButton icon="sliders" label="设置" onPress={openTeam} testID="settings-top" />
          </If>
        </View>

        <If when={page() === "task" && taskId()}>
          <TaskDetail hub={hub} id={taskId()!} wide={wide()} />
        </If>
        <If when={page() === "team"}>
          <TeamSettings hub={hub} push={push} wide={wide()} onConnection={props.onConnection} onDisconnect={props.onDisconnect} />
        </If>
        <If when={page() === "channel"}>
          <View style={{ flex: 1 }}>
            <Scroll
              ref={(r) => (scroller = r)}
              style={{ flex: 1 }}
              scrollEventThrottle={100}
              keyboardShouldPersistTaps="handled"
              onScroll={(ev) => {
                const end = ev.contentSize.height - ev.offset.y - ev.size.height < 80;
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
                          else page.set("team");
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
                      return <OwnerBubble event={row.event} out={out()} onRetry={() => { const o = out(); if (o) send(o.text, o.ref, o.id); }} onUndo={() => undo(row.event.id)} />;
                    }
                    return (
                      <Message
                        hub={hub}
                        event={row.event}
                        answered={answered}
                        target={target}
                        onAnswer={answer}
                        onReply={reply}
                        onLayout={isAsk(row.event) ? (y) => cardY.set(row.event.ref!, y) : undefined}
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

          {/* The composer. */}
          <View style={{ paddingHorizontal: wide() ? 32 : 10, paddingTop: 4, paddingBottom: Math.max(12, safeArea().bottom + 8) }}>
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
              <View
                style={{
                  gap: 6,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: focused() ? colors.accent : colors.fieldBorder,
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
                <Input
                  testID="composer"
                  ref={(r) => (composer = r)}
                  multiline
                  submitBehavior={touch ? "newline" : "submit"}
                  onSubmit={submit}
                  value={draft()}
                  onChange={({ value }) => draft.set(value)}
                  onFocus={() => focused.set(true)}
                  onBlur={() => focused.set(false)}
                  onContentSizeChange={({ size: s }) => inputHeight.set(Math.min(220, Math.max(28, s.height)))}
                  placeholder={replyTo() ? `回复 ${replyTo()}…` : wide() ? "给团队下指令，例如：把 nsh 的 gallery 在 Linux 上截图检查一遍" : "给团队下指令…"}
                  class="placeholder:text-faint"
                  style={{ height: inputHeight(), fontSize: size.text, lineHeight: 24, color: colors.text, paddingVertical: 2 }}
                />
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <If when={!touch && wide()}>
                      <Kbd k="Enter" />
                      <Text style={{ fontSize: 13, color: colors.faint }}>发送</Text>
                      <Kbd k="Shift+Enter" />
                      <Text style={{ fontSize: 13, color: colors.faint }}>换行</Text>
                      <View
                        role="button"
                        accessibilityLabel="快捷键"
                        onPress={() => help.set(true)}
                        hoverStyle={hovered()}
                        style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 6, borderRadius: 6, marginLeft: 4 }}
                      >
                        <Kbd k="?" />
                        <Text style={{ fontSize: 13, color: colors.faint }}>全部快捷键</Text>
                      </View>
                    </If>
                  </View>
                  <View
                    testID="send"
                    role="button"
                    accessibilityLabel="发送"
                    accessibilityState={{ disabled: !draft().trim() }}
                    onPress={submit}
                    tooltip={touch ? undefined : <Tip label="发送" shortcut="Enter" />}
                    hoverStyle={draft().trim() ? { opacity: 0.9 } : undefined}
                    style={{
                      height: touch ? 40 : 36,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 14,
                      borderRadius: radius.control,
                      backgroundColor: draft().trim() ? colors.accentFill : colors.raised,
                      transitionProperty: "background-color",
                      transitionDuration: 120,
                    }}
                  >
                    <Text style={{ fontSize: 15, fontWeight: "600", color: draft().trim() ? colors.onAccent : colors.faint }}>发送</Text>
                    <Icon name="arrow-up" size={15} tint={draft().trim() ? colors.onAccent : colors.faint} />
                  </View>
                </View>
              </View>
            </View>
          </View>
        </If>
      </View>

      <If when={!wide() && drawer()}>
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
          <View
            onPress={() => drawer.set(false)}
            accessibilityLabel="关闭菜单"
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.4)" }}
          />
          <View
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: Math.min(size.sidebar + 16, windowSize().width * 0.86),
              boxShadow: "0 0 40px rgba(0,0,0,0.25)",
              backgroundColor: colors.sidebar,
            }}
          >
            {sidebar(true)}
          </View>
        </View>
      </If>

      <If when={toast()}>
        {(t) => (
          <View style={{ position: "absolute", top: size.bar + 10, left: 0, right: 0, alignItems: "center", paddingHorizontal: 12, pointerEvents: "box-none" }}>
            <View
              role="button"
              testID="toast"
              accessibilityLabel={`查看 ${t().ref}`}
              onPress={() => {
                toast.set(null);
                pick(t().ref);
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

      <If when={help()}>
        <HelpSheet onClose={() => help.set(false)} />
      </If>
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
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: touch ? safeArea().top : 0 }}>
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

import { describe, expect, open, test } from "nsh/test";

const URL = "http://hub.test:8787";
const STORAGE = { "hub.url": URL, "hub.token": "tok" };
const ts = (min: number) => new Date(Date.now() - (60 - min) * 60000).toISOString();

const events = [
  { id: "e1", ts: ts(1), from: "lead@mac", kind: "notice", text: "开始处理 `T-0007`，*很快*完成" },
  {
    id: "e2", ts: ts(2), from: "hub", kind: "decision", ref: "D-0001",
    text: "要不要升级依赖？建议：B", options: ["A: 不升级", "B: 升级", "C: 先评估"],
  },
  {
    id: "e3", ts: ts(3), from: "hub", kind: "proposals", ref: "P-0002",
    text: "待批准清单", options: ["1 写测试", "2 修文档", "all", "none"],
  },
  { id: "e4", ts: ts(4), from: "owner", kind: "owner", text: "P-0002 1" },
  { id: "e5", ts: ts(5), from: "hub", kind: "system", text: "⚙️ 设置已更新：{\"routines\":{}}" },
];
const status = {
  tasks: { proposed: 1, inbox: 2, active: 1, blocked: 0, failed: 0, done: 9 },
  active: [{ id: "T-0007", title: "截图检查 gallery", agent: "dev", host: "linux-box" }],
  decisions: [{ id: "D-0001", kind: "decision", question: "要不要升级依赖？", held: true }],
  recent: [{ id: "T-0005", title: "修复登录页", agent: "dev", host: "linux-box", state: "done", finished: ts(30), updated: ts(30) }],
  hosts: [{
    host: "linux-box", caps: ["os:linux", "arch:x64", "cli:claude"], seen: ts(59), busy: 1,
    stats: { loadRatio: 0.42, cores: 8, memFreePct: 40, diskFreeGB: 120, diskFreePct: 60 },
    os: "linux", arch: "x64", clis: ["claude"], accounts: [{ cli: "claude", name: "default", state: "ok" }],
    running: [{ id: "T-0007", title: "截图检查 gallery", agent: "dev", started: ts(50) }],
    recent: [{ id: "T-0005", title: "修复登录页", state: "done", finished: ts(30) }],
  }],
};

function hub(posts: { text: string; reply_to?: string }[]) {
  return {
    [`GET ${URL}/api/feed`]: { body: { events } },
    [`GET ${URL}/api/feed?*`]: { body: { events: [] } },
    [`GET ${URL}/api/status`]: { body: status },
    [`POST ${URL}/api/messages`]: (r: { body?: string | null }) => {
      const m = JSON.parse(r.body!);
      posts.push(m);
      return { body: { id: `o${posts.length}`, ts: new Date().toISOString(), from: "owner", kind: "owner", text: m.text, ref: m.reply_to } };
    },
  };
}

type Auth = { starts: unknown[]; verifies: unknown[]; logouts: number };
function auth(log: Auth, opts: { start?: number; code?: string } = {}) {
  return {
    [`POST ${URL}/api/auth/start`]: (r: { body?: string | null }) => {
      log.starts.push(JSON.parse(r.body!));
      return opts.start ? { status: opts.start, body: { error: opts.start === 429 ? "请求太频繁" : "email not configured" } } : { body: { ok: true } };
    },
    [`POST ${URL}/api/auth/verify`]: (r: { body?: string | null }) => {
      const b = JSON.parse(r.body!);
      log.verifies.push(b);
      return b.code === (opts.code ?? "123456") ? { body: { session: "sess" } } : { status: 401, body: { error: "bad code" } };
    },
    [`POST ${URL}/api/auth/logout`]: () => {
      log.logouts++;
      return { body: { ok: true } };
    },
  };
}
const newLog = (): Auth => ({ starts: [], verifies: [], logouts: 0 });

describe("login", () => {
  test("email, then the 6-digit code logs in and keeps the session", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { network: { ...hub([]), ...auth(log) } });
    await app.waitFor("登录 noop");
    await app.clear("id:url");
    await app.type("id:url", "hub.test:8787/");
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    expect(log.starts).toEqual([{ email: "ceo@example.com" }]);
    expect(app.shows("text:/重新发送（\\d+s）/")).toBe(true);
    await app.type("id:code", "123456"); // auto-submits on the 6th digit
    await app.waitFor("团队频道");
    expect(log.verifies).toEqual([{ email: "ceo@example.com", code: "123456" }]);
    expect(app.storage()["hub.token"]).toBe("sess");
    expect(app.storage()["hub.url"]).toBe(URL);
    expect(app.storage()["hub.email"]).toBe("ceo@example.com");
  });

  test("served by the hub: no address field; a pasted code with spaces works", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      host: { handlers: { page: { origin: URL } } },
      storage: { "hub.email": "ceo@example.com" },
      network: { ...hub([]), ...auth(log) },
    });
    await app.waitFor("登录 noop");
    expect(app.shows("id:url")).toBe(false);
    expect(app.value("id:email")).toBe("ceo@example.com");
    await app.submit("id:email");
    await app.waitFor("id:code");
    await app.paste("id:code", { text: "123 456" });
    await app.waitFor("团队频道");
  });

  test("a wrong code, rate limits and no email configured are explained", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: { ...hub([]), ...auth(log) } });
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.type("id:code", "000000");
    await app.waitFor("text:/验证码不对/");
    expect(app.value("id:code")).toBe("");

    const limited = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: auth(newLog(), { start: 429 }) });
    await limited.type("id:email", "ceo@example.com");
    await limited.press("id:send-code");
    await limited.waitFor("text:/请求太频繁/");

    const noMail = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: auth(newLog(), { start: 503 }) });
    await noMail.type("id:email", "ceo@example.com");
    await noMail.press("id:send-code");
    await noMail.waitFor("text:/没有配置发信/");
  });

  test("an unreachable server is told apart", async () => {
    const app = await open("./App.tsx", { network: {} });
    await app.clear("id:url");
    await app.type("id:url", "nowhere.test:1");
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.waitFor("text:/连不上服务器/");
  });

  test("a 401 sends you back to the login", async () => {
    const app = await open("./App.tsx", {
      storage: STORAGE,
      network: { [`GET ${URL}/api/feed`]: { status: 401 }, [`GET ${URL}/api/status`]: { status: 401 } },
    });
    await app.waitFor("登录已过期，请重新登录");
    expect(app.storage()["hub.token"]).toBeUndefined();
  });

  test("退出登录 calls logout and forgets the session", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), ...auth(log), [`GET ${URL}/api/settings`]: { status: 500 } },
    });
    await app.press("id:settings");
    await app.press("id:logout");
    await app.waitFor("登录 noop");
    expect(log.logouts).toBe(1);
    expect(app.storage()["hub.token"]).toBeUndefined();
  });
});

describe("channel", () => {
  test("shows the timeline, cards and sidebar", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("要不要升级依赖？建议：B");
    expect(app.shows("今天")).toBe(true);
    expect(app.shows("需要决定")).toBe(true);
    expect(app.shows("id:opt-D-0001-B")).toBe(true);
    expect(app.shows("全部")).toBe(true);
    expect(app.shows("都不要")).toBe(true);
    expect(app.shows("↳ P-0002") || app.shows("P-0002 1")).toBe(true);
    // sidebar
    expect(app.shows("text:/设置已更新/")).toBe(false);
    await app.waitFor("截图检查 gallery");
    expect(app.shows("待你决定")).toBe(true);
    expect(app.shows("text:/linux-box/")).toBe(true);
    expect(app.shows("text:/排队 2/")).toBe(true);
  });

  test("answers a decision with one tap", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:opt-D-0001-B");
    await app.press("id:opt-D-0001-B");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-0001 B" });
  });

  test("其他指示 replies to the item from the composer", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:opt-D-0001-B");
    await app.press("text:其他指示… >> nth=0");
    await app.waitFor("回复 D-0001");
    await app.type("id:composer", "先等一周");
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "先等一周", reply_to: "D-0001" });
    expect(app.value("id:composer")).toBe("");
  });

  test("a machine in the sidebar opens its page, and its tasks open theirs", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("团队频道");
    await app.press("label:负载 42% · 磁盘 120GB · 1 个运行中");
    await app.waitFor("机器 linux-box");
    await app.waitFor("运行中");
    await app.waitFor("已用 60%");
    await app.waitFor("修复登录页");
    await app.press("label:T-0005 修复登录页");
    await app.waitFor("任务 T-0005");
  });

  test("sends a task with the button, and the drawer opens on phones", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts) });
    await app.waitFor("团队频道");
    await app.press("label:菜单");
    await app.press("label:关闭菜单");
    await app.type("id:composer", "截图检查\n两个平台");
    await app.press("id:send");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "截图检查\n两个平台" });
  });
});

describe("keyboard", () => {
  const desk = { storage: STORAGE, width: 1200, height: 800, platform: "macos" as const };

  test("Enter sends from the composer", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "看一下日志");
    await app.submit("id:composer");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "看一下日志" });
    expect(app.value("id:composer")).toBe("");
  });

  test("number keys answer the pending decision; r replies to it", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:opt-D-0001-B");
    // P-0002 is answered (e4), so D-0001 is the pending one.
    await app.keyboard.press("2");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-0001 B" });
  });

  test("r replies, Escape cancels the reply, ? shows the shortcuts", async () => {
    const app = await open("./App.tsx", { ...desk, network: hub([]) });
    await app.waitFor("id:opt-D-0001-B");
    await app.keyboard.press("r");
    await app.waitFor("回复 D-0001");
    await app.keyboard.press("escape");
    expect(app.shows("回复 D-0001")).toBe(false);
    await app.keyboard.press("escape");
    await app.keyboard.press("shift+/");
    await app.waitFor("键盘快捷键");
    await app.keyboard.press("escape");
    expect(app.shows("键盘快捷键")).toBe(false);
  });

  test("mod+, opens team settings", async () => {
    const app = await open("./App.tsx", { ...desk, network: { ...hub([]), [`GET ${URL}/api/settings`]: { status: 500 } } });
    await app.waitFor("id:composer");
    await app.keyboard.press("mod+,");
    await app.waitFor("团队设置");
  });
});

describe("team settings", () => {
  test("changes an agent's models, a routine and max parallel", async () => {
    const puts: unknown[] = [];
    let view = {
      current: {},
      effective: {
        agents: [{ id: "reporter", clis: ["codex", "claude"], autonomy: "onboarding" }],
        autonomy: "onboarding",
        routines: [{ name: "triage-inbound", every: "30m", agent: "lead", enabled: true }],
        max_parallel: 4,
      },
      options: { clis: [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] },
    };
    const app = await open("./App.tsx", {
      storage: STORAGE,
      width: 1200,
      height: 800,
      platform: "macos",
      network: {
        ...hub([]),
        [`GET ${URL}/api/settings`]: () => ({ body: view }),
        [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
          const p = JSON.parse(r.body!);
          puts.push(p);
          if (p.clis) view = { ...view, effective: { ...view.effective, agents: [{ ...view.effective.agents[0], clis: p.clis.agents.reporter }] } };
          if (p.host) view = { ...view, effective: { ...view.effective, max_parallel: p.host.max_parallel } };
          return { body: view };
        },
      },
    });
    await app.press("id:settings");
    await app.waitFor("仅 Claude");
    await app.press("id:cli-reporter-claude");
    await app.waitUntil(() => puts.length === 1);
    await app.press("id:autonomy-reporter-assisted");
    await app.press("id:routine-triage-inbound");
    await app.press("id:every-triage-inbound-1h");
    await app.press("id:parallel-inc");
    await app.waitUntil(() => puts.length === 5);
    expect(puts).toEqual([
      { clis: { agents: { reporter: ["claude"] } } },
      { autonomy: { agents: { reporter: "assisted" } } },
      { routines: { "triage-inbound": { enabled: false } } },
      { routines: { "triage-inbound": { every: "1h" } } },
      { host: { max_parallel: 5 } },
    ]);
    await app.waitFor("text:5");
    await app.press("label:返回频道");
    await app.waitFor("id:composer");
  });
});

describe("notifications", () => {
  type Info = { supported: boolean; ios: boolean; standalone: boolean; permission: string; subscribed: boolean; endpoint: string | null; device: string };
  const device = (over: Partial<Info> = {}): Info => ({
    supported: true, ios: false, standalone: false, permission: "default", subscribed: false, endpoint: null, device: "Android · Chrome", ...over,
  });
  /** The browser host.js wraps (Notification, PushManager, the service worker), played by the test. */
  function browser(info: Info, permission = "granted") {
    let state = { ...info };
    return {
      page: { origin: URL },
      pushState: () => state,
      pushEnable: () => {
        state = { ...state, permission, subscribed: permission === "granted", endpoint: "https://push.test/e1" };
        return { permission, subscription: permission === "granted" ? { endpoint: "https://push.test/e1", keys: { p256dh: "k", auth: "a" } } : null, device: state.device };
      },
      pushDisable: () => {
        state = { ...state, subscribed: false };
        return { endpoint: "https://push.test/e1" };
      },
      setSession: {},
      setBadge: {},
      clearNotifications: {},
      vibrate: {},
    };
  }
  function server(log: { subs: unknown[]; unsubs: unknown[]; tests: number; puts: unknown[] }) {
    return {
      ...hub([]),
      [`GET ${URL}/api/push/vapid`]: { body: { publicKey: "BPublicKey" } },
      [`POST ${URL}/api/push/subscribe`]: (r: { body?: string | null }) => (log.subs.push(JSON.parse(r.body!)), { body: { ok: true } }),
      [`POST ${URL}/api/push/unsubscribe`]: (r: { body?: string | null }) => (log.unsubs.push(JSON.parse(r.body!)), { body: { ok: true } }),
      [`POST ${URL}/api/push/test`]: () => (log.tests++, { body: { ok: true } }),
      [`GET ${URL}/api/settings`]: { body: { current: {}, effective: { agents: [], autonomy: "assisted", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } } },
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
        const p = JSON.parse(r.body!);
        log.puts.push(p);
        return { body: { current: p, effective: { agents: [], autonomy: "assisted", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } } };
      },
    };
  }
  const newLog = () => ({ subs: [] as unknown[], unsubs: [] as unknown[], tests: 0, puts: [] as unknown[] });

  test("enable on this device, send a test, turn a kind off, set quiet hours", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device()) }, network: server(log) });
    await app.press("id:settings-top");
    await app.waitFor("id:push-enable");
    expect(app.texts()).toContain("未开启");
    await app.press("id:push-enable");
    await app.waitUntil(() => log.subs.length === 1);
    expect(log.subs[0]).toEqual({ subscription: { endpoint: "https://push.test/e1", keys: { p256dh: "k", auth: "a" } }, device_label: "Android · Chrome" });
    await app.waitFor("id:push-test");
    await app.press("id:push-test");
    await app.waitUntil(() => log.tests === 1);
    await app.waitFor("text:/测试通知已发出/");
    await app.press("id:notify-result");
    await app.waitUntil(() => log.puts.length === 1);
    const p = log.puts[0] as { notify_prefs: { kinds: Record<string, boolean>; quiet_hours: unknown; tz: string } };
    expect(p.notify_prefs.kinds).toEqual({ decision: true, menu: true, proposals: true, login: true, result: false });
    expect(p.notify_prefs.quiet_hours).toBe(null);
    await app.press("id:quiet-22:00-08:00");
    await app.waitUntil(() => log.puts.length === 2);
    expect((log.puts[1] as typeof p).notify_prefs).toMatchObject({ quiet_hours: { start: "22:00", end: "08:00" }, kinds: { result: false } });
    await app.press("id:push-disable");
    await app.waitUntil(() => log.unsubs.length === 1);
    expect(log.unsubs[0]).toEqual({ endpoint: "https://push.test/e1" });
  });

  test("a refused permission is explained", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device(), "denied") }, network: server(newLog()) });
    await app.press("id:settings-top");
    await app.press("id:push-enable");
    await app.waitFor("text:/通知被拦截了/");
  });

  test("iPhone in Safari: add to the home screen first", async () => {
    const app = await open("./App.tsx", {
      storage: STORAGE,
      host: { handlers: browser(device({ supported: false, ios: true, permission: "unsupported", device: "iPhone · Safari" })) },
      network: server(newLog()),
    });
    await app.waitFor("id:notify-banner");
    await app.press("id:notify-banner-enable");
    await app.waitFor("text:/选「添加到主屏幕」/");
    expect(app.enabled("id:push-enable")).toBe(false);
    expect(app.storage()["hub.notifyAsked"]).toBe("1");
  });

  test("the phone banner shows once and enables from its button", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device()) }, network: server(log) });
    await app.waitFor("id:notify-banner");
    await app.press("id:notify-banner-enable");
    await app.waitUntil(() => log.subs.length === 1);
    expect(app.shows("id:notify-banner")).toBe(false);
    const again = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, host: { handlers: browser(device()) }, network: server(newLog()) });
    await again.waitFor("团队频道");
    expect(again.shows("id:notify-banner")).toBe(false);
  });

  test("badge, unread divider, and a notification opening an event", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.lastSeen": ts(1), "hub.notifyAsked": "1" },
      host: { handlers: browser(device()) },
      network: server(newLog()),
      width: 1200, height: 800, platform: "macos",
    });
    await app.waitFor("以下为新消息");
    await app.waitUntil(() => app.host.calls().some((c) => c.name === "setBadge" && (c.data as { count: number }).count === 1));
    expect(app.host.calls().some((c) => c.name === "setSession" && (c.data as { session: string }).session === "tok")).toBe(true);
    await app.host.send("open", { ref: "D-0001" });
    await app.waitUntil(() => app.host.calls().some((c) => c.name === "clearNotifications" && (c.data as { ref: string }).ref === "D-0001"));
  });

  test("logging out turns this device's notifications off", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" },
      host: { handlers: browser(device({ subscribed: true, permission: "granted", endpoint: "https://push.test/e1" })) },
      network: { ...server(log), [`POST ${URL}/api/auth/logout`]: { body: { ok: true } } },
    });
    await app.press("id:settings-top");
    await app.press("id:logout");
    await app.waitFor("登录 noop");
    expect(log.unsubs).toEqual([{ endpoint: "https://push.test/e1" }]);
  });
});

// MCP server + OAuth 2.1 (cloud/src/mcp.ts) against a bun:sqlite stand-in for the Hub Durable Object.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { initFilesSchema } from "../cloud/src/files";
import { Mcp, type McpHost, okRedirect, pkceChallenge } from "../cloud/src/mcp";

function sqlOf() {
  const db = new Database(":memory:");
  return {
    exec(q: string, ...b: any[]) {
      let rows: any[] = [];
      for (const part of q.split(";").map((s) => s.trim()).filter(Boolean)) {
        const st = db.query(part);
        if (/^SELECT/i.test(part)) rows = st.all(...b) as any[]; else st.run(...b);
      }
      return { toArray: () => rows };
    },
  };
}

function hub() {
  const sql = sqlOf();
  initFilesSchema(sql);
  sql.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, json TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, email TEXT, created INTEGER, last_seen INTEGER, ua TEXT)`);
  const said: { text: string; ref?: string }[] = [];
  let mcp: Mcp;
  const append = (e: any) => {
    const ev = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e };
    sql.exec("INSERT INTO events (ts, json) VALUES (?, ?)", ev.ts, JSON.stringify(ev));
    mcp.onEvent(ev);
    return ev;
  };
  let rev = 0;
  const file = (path: string, content: string) => sql.exec("INSERT OR REPLACE INTO files (path, content, hash, version, updated, by, deleted, rev) VALUES (?, ?, '', 1, ?, 'x', 0, ?)",
    path, new TextEncoder().encode(content), new Date(Date.now() + rev * 1000).toISOString(), ++rev);
  const host: McpHost = {
    sql, status: () => ({ tasks: { active: 1 }, decisions: [{ id: "D-0099", question: "合并吗？" }], hosts: [{ host: "h1", online: true }], active: [], hub: { online: true } }),
    events: (after, limit) => sql.exec("SELECT seq, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).toArray().map((r) => ({ seq: r.seq, ev: JSON.parse(r.json) })),
    say: (text, ref) => { said.push({ text, ref }); return append({ from: "owner", kind: "owner", text, ref }); },
    startCode: async (email) => (email === "owner@example.com" ? { status: 200, body: { ok: true } } : { status: 400, body: { error: "invalid email" } }),
    checkCode: async (email, code) => (code === "123456" ? { email } : { error: "验证码不对" }),
    newSession: async (email) => { const s = crypto.randomUUID().replace(/-/g, ""); sql.exec("INSERT INTO sessions (id, email) VALUES (?, ?)", s, email); return s; },
    dropSession: async () => {},
  };
  mcp = new Mcp(host);
  file("tasks/active/T-0184.md", "---\nid: T-0184\ntitle: noop: MCP server\nagent: lead\nrepo: huacnlee/noop\nclaimed_by: h1\n---\nBuild the MCP server.\n");
  file("tasks/done/T-0100.md", "---\nid: T-0100\ntitle: Fix typo\nagent: lead\n---\ndone\n");
  file("decisions/open/D-0099.md", "---\nid: D-0099\ntask: T-0184\nquestion: 合并吗？\nrecommendation: A\noptions: A: 合并 — 好 | B: 不合并 — 等\n---\n## Context\n需要你决定。\n\n## Options\n- A\n");
  return { sql, mcp, said, append, file };
}

const B = "https://noop.example.com";
const post = (path: string, body: unknown, h: Record<string, string> = {}) =>
  new Request(B + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...h }, body: JSON.stringify(body) });
const rpc = async (mcp: Mcp, method: string, params: unknown = {}, sid = "", id: number | null = 1) => {
  const r = await mcp.fetch(post("/mcp", id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }, sid ? { "mcp-session-id": sid } : {}), "machine");
  return { status: r.status, sid: r.headers.get("mcp-session-id") ?? "", body: r.status === 202 ? null : (await r.json()) as any };
};
const tool = async (mcp: Mcp, name: string, args: unknown = {}) => {
  const r = await rpc(mcp, "tools/call", { name, arguments: args });
  return { ...r.body.result, data: r.body.result.isError ? null : JSON.parse(r.body.result.content[0].text) };
};

test("unauthenticated /mcp → 401 pointing at the protected-resource metadata", async () => {
  const { mcp } = hub();
  const r = await mcp.fetch(post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" }), null);
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${B}/.well-known/oauth-protected-resource"`);
  const pr = (await (await mcp.fetch(new Request(`${B}/.well-known/oauth-protected-resource/mcp`), null)).json()) as any;
  expect(pr).toMatchObject({ resource: `${B}/mcp`, authorization_servers: [B] });
  const as = (await (await mcp.fetch(new Request(`${B}/.well-known/oauth-authorization-server`), null)).json()) as any;
  expect(as).toMatchObject({ issuer: B, registration_endpoint: `${B}/oauth/register`, code_challenge_methods_supported: ["S256"] });
});

test("OAuth: register → sign in with email code → PKCE token → refresh rotates", async () => {
  const { mcp, sql } = hub();
  expect((await mcp.fetch(post("/oauth/register", { redirect_uris: ["https://evil.example.com/cb#x"] }), null)).status).toBe(400);
  const reg = await mcp.fetch(post("/oauth/register", { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }), null);
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as any;
  const verifier = "v".repeat(50), challenge = await pkceChallenge(verifier);
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: challenge, code_challenge_method: "S256", state: "st8" });
  const page = await mcp.fetch(new Request(`${B}/oauth/authorize?${q}`), null);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Claude");
  expect(html).toContain("claude.ai");
  // wrong redirect_uri is refused on the page itself (never redirected)
  const bad = new URLSearchParams(q); bad.set("redirect_uri", "https://evil.example.com/cb");
  expect((await mcp.fetch(new Request(`${B}/oauth/authorize?${bad}`), null)).status).toBe(400);
  const form = (o: Record<string, string>) => new Request(`${B}/oauth/authorize?${q}`, { method: "POST", body: new URLSearchParams(o) });
  expect(await (await mcp.fetch(form({ step: "send", email: "owner@example.com" }), null)).text()).toContain('name="code"');
  expect(await (await mcp.fetch(form({ step: "verify", email: "owner@example.com", code: "000000" }), null)).text()).toContain("验证码不对");
  const ok = await mcp.fetch(form({ step: "verify", email: "owner@example.com", code: "123456" }), null);
  expect(ok.status).toBe(302);
  const back = new URL(ok.headers.get("location")!);
  expect(back.origin + back.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
  expect(back.searchParams.get("state")).toBe("st8");
  const code = back.searchParams.get("code")!;
  const tok = (b: Record<string, string>) => mcp.fetch(new Request(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(b) }), null);
  expect((await tok({ grant_type: "authorization_code", code, client_id: client.client_id, code_verifier: "wrong".repeat(10) })).status).toBe(400);
  // the failed attempt burnt the code (single use) — get a fresh one
  const again = new URL((await mcp.fetch(form({ step: "verify", email: "owner@example.com", code: "123456" }), null)).headers.get("location")!).searchParams.get("code")!;
  const t = (await (await tok({ grant_type: "authorization_code", code: again, client_id: client.client_id, code_verifier: verifier, redirect_uri: "https://claude.ai/api/mcp/auth_callback" })).json()) as any;
  expect(t.token_type).toBe("Bearer");
  expect(sql.exec("SELECT email FROM sessions WHERE id = ?", t.access_token).toArray()[0]?.email).toBe("owner@example.com");
  expect((await tok({ grant_type: "authorization_code", code: again, client_id: client.client_id, code_verifier: verifier })).status).toBe(400); // replay
  const t2 = (await (await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id })).json()) as any;
  expect(t2.access_token).toBeTruthy();
  expect((await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id })).status).toBe(400); // rotated
  // deny goes back with access_denied
  const deny = await mcp.fetch(form({ step: "deny" }), null);
  expect(new URL(deny.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
});

test("initialize, tools/list, resources", async () => {
  const { mcp } = hub();
  const init = await rpc(mcp, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(init.sid).toMatch(/^[0-9a-f]{32}$/);
  expect(init.body.result.protocolVersion).toBe("2025-06-18");
  expect(init.body.result.capabilities.resources.subscribe).toBe(true);
  expect((await rpc(mcp, "notifications/initialized", {}, init.sid, null)).status).toBe(202);
  const names = (await rpc(mcp, "tools/list", {}, init.sid)).body.result.tools.map((t: any) => t.name);
  expect(names).toEqual(["get_status", "list_tasks", "get_task", "list_decisions", "get_feed", "wait_for_events", "send_message", "create_task", "answer_decision", "search", "fetch"]);
  expect(names.some((n: string) => /merge|release|setting/.test(n))).toBe(false);
  const res = (await rpc(mcp, "resources/list")).body.result.resources.map((r: any) => r.uri);
  expect(res).toContain("noop://tasks/T-0184");
  expect(res).not.toContain("noop://tasks/T-0100"); // done tasks aren't listed
  const read = (await rpc(mcp, "resources/read", { uri: "noop://tasks/T-0184" })).body.result.contents[0];
  expect(JSON.parse(read.text).title).toBe("noop: MCP server");
  expect((await rpc(mcp, "nope/x")).body.error.code).toBe(-32601);
});

test("tools: read and owner-level writes", async () => {
  const { mcp, said } = hub();
  expect((await tool(mcp, "get_status")).data.decisions[0].id).toBe("D-0099");
  expect((await tool(mcp, "list_tasks")).data.tasks.map((t: any) => t.id)).toEqual(["T-0184"]);
  expect((await tool(mcp, "list_tasks", { state: "all", query: "typo" })).data.tasks.map((t: any) => t.id)).toEqual(["T-0100"]);
  const t = (await tool(mcp, "get_task", { id: "T-0184" })).data;
  expect(t).toMatchObject({ state: "active", host: "h1", repo: "huacnlee/noop" });
  expect(t.body).toContain("Build the MCP server");
  expect((await tool(mcp, "get_task", { id: "T-9999" })).isError).toBe(true);
  const d = (await tool(mcp, "list_decisions")).data.decisions[0];
  expect(d).toMatchObject({ id: "D-0099", recommendation: "A", options: ["A: 合并 — 好", "B: 不合并 — 等"], context: "需要你决定。" });

  expect((await tool(mcp, "send_message", { text: "  hi team ", reply_to: "T-0184" })).data.ok).toBe(true);
  expect((await tool(mcp, "answer_decision", { id: "D-0099", answer: "A" })).data.ok).toBe(true);
  expect((await tool(mcp, "answer_decision", { id: "D-0001", answer: "A" })).isError).toBe(true); // not open
  await tool(mcp, "create_task", { title: "Add dark mode", details: "Make it balanced.", repo: "huacnlee/noop" });
  expect(said).toEqual([{ text: "hi team", ref: "T-0184" }, { text: "D-0099 A", ref: "D-0099" },
    { text: "新任务：Add dark mode\n\n仓库：huacnlee/noop\n\nMake it balanced.", ref: undefined }]);

  const feed = (await tool(mcp, "get_feed")).data;
  expect(feed.events.map((e: any) => e.text)).toContain("D-0099 A");
  const s = (await tool(mcp, "search", { query: "mcp" })).data.results;
  expect(s.map((r: any) => r.id)).toEqual(["T-0184"]);
  expect(s[0].url).toBe(`${B}/?ref=T-0184`);
  const f = (await tool(mcp, "fetch", { id: "D-0099" })).data;
  expect(f).toMatchObject({ id: "D-0099", title: "D-0099 合并吗？", metadata: { state: "open" } });
});

test("wait_for_events returns as soon as an event lands", async () => {
  const { mcp, append } = hub();
  const cursor = (await tool(mcp, "get_feed")).data.cursor;
  const t0 = Date.now();
  const p = tool(mcp, "wait_for_events", { cursor, timeout_seconds: 10 });
  setTimeout(() => append({ from: "lead@h1", kind: "result", text: "T-0184 done", ref: "T-0184" }), 50);
  const r = (await p).data;
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(r.events.map((e: any) => e.text)).toEqual(["T-0184 done"]);
  expect(r.cursor).toBeGreaterThan(cursor);
});

test("SSE stream delivers events as notifications/message and resources/updated for subscriptions", async () => {
  const { mcp, append } = hub();
  const { sid } = await rpc(mcp, "initialize", { protocolVersion: "2025-11-25" });
  await rpc(mcp, "resources/subscribe", { uri: "noop://tasks/T-0184" }, sid);
  await rpc(mcp, "logging/setLevel", { level: "info" }, sid);
  const r = await mcp.fetch(new Request(`${B}/mcp`, { headers: { accept: "text/event-stream", "mcp-session-id": sid } }), "machine");
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  const reader = r.body!.getReader(), dec = new TextDecoder();
  append({ from: "lead@h1", kind: "result", text: "T-0184 PR opened", ref: "T-0184" });
  append({ from: "hub", kind: "system", text: "debug noise" }); // below "info" → no message
  let buf = "";
  while (!(buf.match(/^data: /gm)?.length! >= 2)) buf += dec.decode((await reader.read()).value);
  const msgs = buf.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  expect(msgs[0]).toMatchObject({ method: "notifications/message", params: { level: "info", logger: "noop", data: { text: "T-0184 PR opened" } } });
  expect(msgs[1]).toMatchObject({ method: "notifications/resources/updated", params: { uri: "noop://tasks/T-0184" } });
  expect(msgs.some((m) => m.params?.data?.text === "debug noise")).toBe(false);
  mcp.onChanged(["noop://status", "noop://tasks/T-0184"]);
  buf = "";
  while (!buf.includes("resources/updated")) buf += dec.decode((await reader.read()).value);
  expect(buf).toContain("noop://tasks/T-0184");
  expect(buf).not.toContain("noop://status"); // not subscribed
  for (const s of mcp.streams) s.close();
});

test("redirect URIs: https or loopback only", () => {
  expect(okRedirect("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
  expect(okRedirect("http://localhost:6274/oauth/callback")).toBe(true);
  expect(okRedirect("http://example.com/cb")).toBe(false);
  expect(okRedirect("javascript:alert(1)")).toBe(false);
});

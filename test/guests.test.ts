import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { FilesSql as SqlStorage } from "../cloud/src/files";
import { guestApi, guestJoin, guestWho, guestsAdmin, initGuestSchema } from "../cloud/src/guests";

// SqlStorage shim over bun:sqlite: exec(q, ...binds) → {toArray, one}, multi-statement DDL allowed
function sql() {
  const db = new Database(":memory:");
  return { exec(q: string, ...b: unknown[]) {
    if (!b.length && q.split(";").filter((s) => s.trim()).length > 1) { db.exec(q); return { toArray: () => [], one: () => ({}) }; }
    const rows = db.query(q).all(...(b as any[])) as Record<string, unknown>[];
    return { toArray: () => rows, one: () => rows[0] };
  } } as unknown as SqlStorage;
}
const req = (path: string, method = "GET", body?: unknown) => new Request(`https://hub${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const call = async (s: SqlStorage, path: string, who: "machine" | "owner", method = "GET", body?: unknown) => {
  const r = req(path, method, body);
  const res = (await guestsAdmin(s, r, new URL(r.url), who))!;
  return { status: res.status, body: (await res.json()) as any };
};
async function joined(s: SqlStorage, label = "shared-win") {
  const { body: { code } } = await call(s, "/api/guests/code", "owner", "POST", { label });
  const r = await guestJoin(s, req("/api/guest/join", "POST", { code }), () => {});
  return (await r.json()) as { id: string; token: string };
}
const asGuest = async (s: SqlStorage, token: string, path: string, method = "GET", body?: unknown) => {
  const who = await guestWho(s, token);
  if (!who) return { status: 401, body: null as any };
  const r = req(path, method, body);
  const res = await guestApi(s, r, new URL(r.url), who, () => {});
  return { status: res.status, body: (await res.json()) as any };
};

test("a join code works once", async () => {
  const s = sql(); initGuestSchema(s);
  const { body: { code } } = await call(s, "/api/guests/code", "owner", "POST", { label: "shared-win" });
  const first = await guestJoin(s, req("/api/guest/join", "POST", { code }), () => {});
  expect(first.status).toBe(200);
  const { token } = (await first.json()) as any;
  expect(token).toMatch(/^g_[0-9a-f]{64}$/);
  expect((await guestJoin(s, req("/api/guest/join", "POST", { code }), () => {})).status).toBe(401);
});

test("a guest only gets tasks assigned to it and can only answer its own claimed task", async () => {
  const s = sql(); initGuestSchema(s);
  const a = await joined(s, "a"), b = await joined(s, "b");
  expect((await call(s, "/api/guests/assign", "owner", "POST", { guest: a.id, task: { id: "T-0001", title: "t", body: "b" } })).status).toBe(403);
  expect((await call(s, "/api/guests/assign", "machine", "POST", { guest: a.id, task: { id: "T-0001", title: "run tests", body: "do it" } })).status).toBe(200);
  expect((await asGuest(s, b.token, "/api/guest/next")).body.task).toBeNull();
  expect((await asGuest(s, a.token, "/api/guest/result", "POST", { id: "T-0001", text: "early" })).status).toBe(403); // not claimed yet
  const t = (await asGuest(s, a.token, "/api/guest/next")).body.task;
  expect(t).toEqual({ id: "T-0001", title: "run tests", body: "do it" });
  expect((await asGuest(s, b.token, "/api/guest/result", "POST", { id: "T-0001", text: "spoof" })).status).toBe(403);
  expect((await asGuest(s, a.token, "/api/guest/result", "POST", { id: "T-0001", ok: true, text: "passed" })).status).toBe(200);
  expect((await asGuest(s, a.token, "/api/guest/result", "POST", { id: "T-0001", text: "again" })).status).toBe(403);
  const res = (await call(s, "/api/guests/results", "machine")).body.results;
  expect(res).toEqual([{ id: "T-0001", guest: a.id, label: "a", untrusted: true, ok: true, text: "passed" }]);
  await call(s, "/api/guests/ack", "machine", "POST", { ids: ["T-0001"] });
  expect((await call(s, "/api/guests/results", "machine")).body.results).toEqual([]);
});

test("a guest token reaches nothing outside /api/guest/*, and revocation is immediate", async () => {
  const s = sql(); initGuestSchema(s);
  const a = await joined(s);
  for (const p of ["/api/files/list", "/api/feed", "/api/settings", "/api/host/join", "/api/guests"])
    expect((await asGuest(s, a.token, p)).status).toBe(403);
  await call(s, "/api/guests/revoke", "owner", "POST", { id: a.id });
  expect((await asGuest(s, a.token, "/api/guest/next")).status).toBe(401);
});

test("oversized results are refused", async () => {
  const s = sql(); initGuestSchema(s);
  const a = await joined(s);
  await call(s, "/api/guests/assign", "machine", "POST", { guest: a.id, task: { id: "T-0002", title: "t", body: "b" } });
  await asGuest(s, a.token, "/api/guest/next");
  expect((await asGuest(s, a.token, "/api/guest/result", "POST", { id: "T-0002", text: "x".repeat(300 * 1024) })).status).toBe(413);
});

// Local Web Push e2e against `wrangler dev` (needs HUB_VAPID_* vars + fake-smtp.ts running; see scenario.ts).
// Starts a fake push service on 127.0.0.1:2626 that checks the VAPID JWT and decrypts the aes128gcm body like a browser.
import { readdirSync, readFileSync } from "node:fs";
import { b64u, unb64u } from "../../cloud/src/push";
const BASE = process.env.BASE ?? "http://localhost:8799", TOKEN = process.env.TOKEN ?? "machinetok", OUT = process.env.OUT!, VAPID_PUB = process.env.VAPID_PUB!;
let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
const te = new TextEncoder(), cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const hmac = async (k: Uint8Array, d: Uint8Array) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d as any));
const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => (await hmac(await hmac(s, ikm), cat(info, new Uint8Array([1])))).slice(0, n);

// the "browser" side of a subscription
const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey)), authSecret = crypto.getRandomValues(new Uint8Array(16));
async function decrypt(body: Uint8Array) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const key = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12) }, key, ct));
  return JSON.parse(new TextDecoder().decode(pt.slice(0, pt.lastIndexOf(2))));
}
const got: { path: string; h: Headers; payload: any; jwtOk: boolean }[] = [];
Bun.serve({ hostname: "127.0.0.1", port: 2626, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/gone") return new Response("", { status: 410 });
  const [, t, k] = req.headers.get("authorization")!.match(/^vapid t=([^,]+), k=(.+)$/)!;
  const [h, p, s] = t.split(".");
  const pub = await crypto.subtle.importKey("raw", unb64u(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const jwtOk = k === VAPID_PUB && await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(s), te.encode(`${h}.${p}`))
    && JSON.parse(new TextDecoder().decode(unb64u(p))).aud === "http://127.0.0.1:2626";
  got.push({ path, h: req.headers, payload: await decrypt(new Uint8Array(await req.arrayBuffer())), jwtOk });
  return new Response("", { status: 201 });
} });
const wait = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, b: unknown, h: Record<string, string>) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });
const M = { authorization: `Bearer ${TOKEN}` };

// login as owner (email code)
await post("/api/auth/start", { email: "owner@example.com" }, {}); await wait();
const mail = readFileSync(`${OUT}/${readdirSync(OUT).sort((a, b) => parseInt(a) - parseInt(b)).at(-1)}`, "utf8");
const code = Buffer.from(mail.match(/Subject: =\?UTF-8\?B\?(\S+)\?=/)![1], "base64").toString().match(/\d{6}/)![0];
const { session } = (await (await post("/api/auth/verify", { email: "owner@example.com", code }, {})).json()) as any;
const S = { authorization: `Bearer ${session}` };
ok(!!session, "owner session");

ok(((await (await fetch(BASE + "/api/push/vapid", { headers: S })).json()) as any).publicKey === VAPID_PUB, "GET /api/push/vapid");
const sub = { endpoint: "http://127.0.0.1:2626/sub1", keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } };
ok((await post("/api/push/subscribe", { subscription: sub, device_label: "test phone" }, S)).status === 200, "subscribe");
ok((await post("/api/push/subscribe", { subscription: sub, device_label: "test phone 2" }, S)).status === 200, "re-subscribe (upsert)");
ok((await post("/api/push/subscribe", { subscription: { ...sub, endpoint: "http://127.0.0.1:2626/gone" } }, S)).status === 200, "subscribe a dead endpoint");
ok((await post("/api/push/subscribe", { subscription: sub }, M)).status === 403, "machine token cannot subscribe");

let r: any = await (await post("/api/push/test", {}, S)).json(); await wait();
ok(r.sent === 1 && r.removed === 1, `push/test → ${JSON.stringify(r)} (dead endpoint dropped on 410)`);
ok(got.length === 1 && got[0].jwtOk && got[0].payload.tag === "test", "fake push service got a valid VAPID JWT + decryptable payload");

// status snapshot with 2 open decisions (1 held) → badge 1
await fetch(BASE + "/api/host/state", { method: "PUT", headers: { ...M, "content-type": "application/json" }, body: JSON.stringify({ status: { decisions: [{ id: "D-1" }, { id: "D-2", held: true }] }, settings: { current: {} } }) });
got.length = 0;
await post("/api/events", { from: "lead@box", kind: "decision", text: "**Ship** the new build?\n" + "x".repeat(300), ref: "D-1", options: ["A: ship it", "B: wait", "C: cancel", "D: more"] }, M); await wait();
const d = got[0];
ok(!!d && d.h.get("urgency") === "high" && d.h.get("ttl") === "86400" && d.h.get("content-encoding") === "aes128gcm", `decision push headers urgency=${d?.h.get("urgency")} ttl=${d?.h.get("ttl")}`);
ok(d?.payload.kind === "decision" && d.payload.ref === "D-1" && d.payload.url === "/?ref=D-1" && d.payload.tag === "D-1" && d.payload.badge === 1, "decision payload ref/url/tag/badge");
ok(d?.payload.options.length === 3 && d.payload.body.length <= 140 && !d.payload.body.includes("**"), `options ≤3, plain body ≤140 (${d?.payload.body.length})`);

got.length = 0;
for (const e of [{ kind: "system", from: "hub", text: "s" }, { kind: "owner", from: "owner", text: "o" }, { kind: "notice", from: "hub@box", text: "n" }])
  await post("/api/events", e, M);
await wait();
ok(got.length === 0, "system / owner / hub notice → no push");
await post("/api/events", { kind: "notice", from: "lead@box", text: "done", ref: "T-1" }, M); await wait();
ok(got.length === 1 && got[0].h.get("urgency") === "normal", "agent notice → push (normal urgency)");

// prefs: notice off; quiet hours all day → only login + urgent decisions
const now = new Date(), hh = (d: Date) => d.toISOString().slice(11, 16);
const quiet = `${hh(new Date(now.getTime() - 3600_000))}-${hh(new Date(now.getTime() + 3600_000))}`;
await fetch(BASE + "/api/host/state", { method: "PUT", headers: { ...M, "content-type": "application/json" }, body: JSON.stringify({ settings: { current: { notify_prefs: { kinds: { notice: false }, quiet_hours: quiet, tz: "UTC" } } } }) });
got.length = 0;
await post("/api/events", { kind: "notice", from: "lead@box", text: "n" }, M);
await post("/api/events", { kind: "decision", from: "lead@box", text: "normal", ref: "D-3" }, M);
await post("/api/events", { kind: "proposals", from: "lead@box", text: "p", ref: "P-1" }, M);
await wait();
ok(got.length === 0, `quiet hours (${quiet} UTC) + notice off → nothing`);
await post("/api/events", { kind: "decision", from: "lead@box", text: "urgent", ref: "D-4", priority: "urgent" }, M);
await post("/api/events", { kind: "login", from: "hub", text: "new login" }, M);
await wait();
ok(got.map((g) => g.payload.kind).sort().join() === "decision,login", `quiet hours let through: ${got.map((g) => g.payload.kind)}`);

// answer from a notification action
r = await (await post("/api/push/answer", { ref: "D-1", answer: "A" }, S)).json();
ok(r.kind === "owner" && r.text === "D-1 A" && r.ref === "D-1", "push/answer → owner message 'D-1 A'");
const inbox: any = await (await fetch(BASE + "/api/host/inbox", { headers: M })).json();
ok(inbox.items.some((i: any) => i.type === "message" && i.event.text === "D-1 A"), "answer reached the fleet inbox");

ok((await post("/api/push/unsubscribe", { endpoint: sub.endpoint }, S)).status === 200, "unsubscribe");
got.length = 0; r = await (await post("/api/push/test", {}, S)).json();
ok(r.total === 0 && got.length === 0, "no subscriptions left");
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);

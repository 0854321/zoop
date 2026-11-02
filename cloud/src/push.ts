// Web Push without a third-party service: RFC 8291 (aes128gcm message encryption) + RFC 8292 (VAPID, ES256 JWT).
// Pure WebCrypto — runs in Workers and in Bun (unit-tested against the RFC 8291 test vector).

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
export interface Vapid { publicKey: string /* b64url raw P-256 point */; privateJwk: Jwk; subject: string /* mailto: */ }

// Local aliases so this file typechecks under both workers-types and plain Bun (no DOM lib).
export type Jwk = { kty?: string; crv?: string; x?: string; y?: string; d?: string; ext?: boolean };
type BS = any;
const te = new TextEncoder();
export const b64u = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u8 = (b: ArrayBuffer) => new Uint8Array(b);

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key as BS, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return u8(await crypto.subtle.sign("HMAC", k, data as BS));
}
/** HKDF with a single output block (≤32 bytes), as RFC 8291 uses it. */
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) =>
  (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, len);

/** Raw uncompressed point (65 bytes) → ECDH/ECDSA public key. */
const pubJwk = (raw: Uint8Array): Jwk => ({ kty: "EC", crv: "P-256", x: b64u(raw.slice(1, 33)), y: b64u(raw.slice(33, 65)), ext: true });

/** RFC 8291 §3–4: encrypt `plaintext` for one subscription. `fixed` is for test vectors only. */
export async function encrypt(plaintext: Uint8Array, sub: PushSub, fixed?: { asPrivate: string; asPublic: string; salt: string }) {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  let asPriv: CryptoKey, asPublic: Uint8Array;
  if (fixed) {
    asPublic = unb64u(fixed.asPublic);
    asPriv = await crypto.subtle.importKey("jwk", { ...pubJwk(asPublic), d: fixed.asPrivate } as any, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPriv = kp.privateKey;
    asPublic = u8((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BS, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = u8(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, asPriv, 256));
  const ikm = await hkdf(authSecret, ecdh, cat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed ? unb64u(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek as BS, "AES-GCM", false, ["encrypt"]);
  const ct = u8(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BS }, key, cat(plaintext, new Uint8Array([2])) as BS)); // single last record
  const rs = 4096;
  const header = cat(salt, new Uint8Array([rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic);
  return cat(header, ct);
}

/** RFC 8292: `Authorization: vapid t=<jwt>, k=<public key>` for the push service origin. */
export async function vapidAuth(endpoint: string, v: Vapid, now = Date.now()) {
  const enc = (o: unknown) => b64u(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })}`;
  const key = await crypto.subtle.importKey("jwk", v.privateJwk as any, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = u8(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned))); // WebCrypto gives raw r||s = JOSE format
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.publicKey}`;
}

/** Send one notification. Returns the push service's HTTP status (404/410 → caller drops the subscription). */
export async function sendPush(sub: PushSub, payload: unknown, v: Vapid, o: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string } = {}) {
  const body = await encrypt(te.encode(JSON.stringify(payload)), sub);
  const headers: Record<string, string> = {
    Authorization: await vapidAuth(sub.endpoint, v), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
    TTL: String(o.ttl ?? 86400), Urgency: o.urgency ?? "normal",
  };
  if (o.topic) headers.Topic = o.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32); // RFC 8030: ≤32 url-safe chars
  const r = await fetch(sub.endpoint, { method: "POST", headers, body: body as BS, signal: AbortSignal.timeout(15_000) });
  return r.status;
}

/** New VAPID keypair: { publicKey (b64url raw), privateJwk }. Used by `hub cloud deploy` once. */
export async function newVapidKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = u8((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as Jwk;
  return { publicKey: b64u(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

// Web Push crypto: RFC 8291 §5 test vector + VAPID JWT verifies with the public key.
import { expect, test } from "bun:test";
import { b64u, encrypt, newVapidKeys, unb64u, vapidAuth } from "../../cloud/src/push";

test("RFC 8291 aes128gcm test vector", async () => {
  const out = await encrypt(new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    { endpoint: "https://push.example.net/x", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } },
    { asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8", salt: "DGv6ra1nlYgDCS1FRnbzlw" });
  expect(b64u(out)).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("VAPID JWT is ES256-signed by the advertised key", async () => {
  const k = await newVapidKeys();
  const h = await vapidAuth("https://fcm.googleapis.com/fcm/send/abc", { ...k, subject: "mailto:owner@example.com" });
  const [, t, kk] = h.match(/^vapid t=([^,]+), k=(.+)$/)!;
  expect(kk).toBe(k.publicKey);
  const [hd, pl, sig] = t.split(".");
  expect(JSON.parse(atob(pl.replace(/-/g, "+").replace(/_/g, "/"))).aud).toBe("https://fcm.googleapis.com");
  const pub = await crypto.subtle.importKey("raw", unb64u(k.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sig), new TextEncoder().encode(`${hd}.${pl}`))).toBe(true);
});

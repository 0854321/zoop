// Fake SMTP server for local Worker auth tests (plain TCP, no TLS). Writes each received message to $OUT/<n>.eml.
// Usage: OUT=/tmp/mails PORT=2525 bun test/cloud-auth/fake-smtp.ts
const out = process.env.OUT ?? "./mails", port = Number(process.env.PORT ?? 2525);
let n = 0;
type S = { buf: string; data: boolean; msg: string[]; auth: number };
Bun.listen<S>({
  hostname: "127.0.0.1", port,
  socket: {
    open(s) { s.data = { buf: "", data: false, msg: [], auth: 0 }; s.write("220 fake ESMTP\r\n"); },
    data(s, chunk) {
      s.data.buf += chunk.toString();
      let i;
      while ((i = s.data.buf.indexOf("\r\n")) >= 0) {
        const l = s.data.buf.slice(0, i); s.data.buf = s.data.buf.slice(i + 2);
        if (s.data.data) {
          if (l === ".") { s.data.data = false; Bun.write(`${out}/${++n}.eml`, s.data.msg.join("\r\n")); s.data.msg = []; s.write("250 queued\r\n"); }
          else s.data.msg.push(l.startsWith("..") ? l.slice(1) : l);
          continue;
        }
        const c = l.toUpperCase();
        if (c.startsWith("EHLO")) s.write("250-fake\r\n250-8BITMIME\r\n250 AUTH LOGIN PLAIN\r\n");
        else if (c === "AUTH LOGIN") { s.data.auth = 1; s.write("334 VXNlcm5hbWU6\r\n"); }
        else if (s.data.auth === 1) { s.data.auth = 2; s.write("334 UGFzc3dvcmQ6\r\n"); }
        else if (s.data.auth === 2) { s.data.auth = 3; s.write("235 ok\r\n"); }
        else if (c.startsWith("MAIL") || c.startsWith("RCPT")) s.write("250 ok\r\n");
        else if (c === "DATA") { s.data.data = true; s.write("354 go\r\n"); }
        else if (c === "QUIT") { s.write("221 bye\r\n"); s.end(); }
        else s.write("502 ?\r\n");
      }
    },
  },
});
console.log(`fake smtp on 127.0.0.1:${port} → ${out}`);

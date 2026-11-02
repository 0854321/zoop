// Minimal SMTP client for Workers (cloudflare:sockets). Enough to send one plain-text UTF-8 mail.
//   port 465 → implicit TLS · 587 (or secure:false) → STARTTLS · localhost with starttls:false → plain (local tests only)
import { connect } from "cloudflare:sockets";

export interface SmtpCfg { host: string; port?: number; secure?: boolean; starttls?: boolean; user?: string; pass?: string; from?: string }

const enc = new TextEncoder();
const b64 = (s: string) => { let bin = ""; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
const addr = (s: string) => s.match(/<([^>]+)>/)?.[1] ?? s.trim();
const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1";

class Conn {
  buf = "";
  reader!: ReadableStreamDefaultReader<Uint8Array>;
  writer!: WritableStreamDefaultWriter<Uint8Array>;
  dec = new TextDecoder();
  constructor(public sock: Socket) { this.attach(); }
  attach() { this.reader = this.sock.readable.getReader(); this.writer = this.sock.writable.getWriter(); this.buf = ""; }
  release() { this.reader.releaseLock(); this.writer.releaseLock(); }
  async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); return l; }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("smtp: connection closed");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  /** Read a (possibly multi-line "250-...") reply; throw unless the code matches. */
  async reply(expect: number): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.line();
      lines.push(l);
      if (!/^\d{3}-/.test(l)) break;
    }
    const code = Number(lines.at(-1)!.slice(0, 3));
    if (code !== expect) throw new Error(`smtp: expected ${expect}, got ${lines.join(" | ").slice(0, 300)}`);
    return lines;
  }
  send(s: string) { return this.writer.write(enc.encode(s + "\r\n")); }
  async cmd(s: string, expect: number) { await this.send(s); return this.reply(expect); }
}

export async function sendMail(c: SmtpCfg, to: string, subject: string, text: string) {
  const port = c.port ?? 465;
  const implicit = c.secure ?? port === 465;
  const plain = !implicit && c.starttls === false && isLocal(c.host); // never send credentials in clear over the internet
  const sock = connect({ hostname: c.host, port }, { secureTransport: implicit ? "on" : plain ? "off" : "starttls", allowHalfOpen: false });
  const conn = new Conn(sock);
  const timer = setTimeout(() => { try { sock.close(); } catch {} }, 20_000);
  try {
    await conn.reply(220);
    let ehlo = await conn.cmd("EHLO agent-hub", 250);
    if (!implicit && !plain) {
      await conn.cmd("STARTTLS", 220);
      conn.release();
      conn.sock = sock.startTls();
      conn.attach();
      ehlo = await conn.cmd("EHLO agent-hub", 250);
    }
    if (c.user) {
      const caps = ehlo.join(" ").toUpperCase();
      if (/AUTH[ =][^\r\n]*PLAIN/.test(caps) && !/AUTH[ =][^\r\n]*LOGIN/.test(caps)) {
        await conn.cmd(`AUTH PLAIN ${b64(`\0${c.user}\0${c.pass ?? ""}`)}`, 235);
      } else {
        await conn.cmd("AUTH LOGIN", 334);
        await conn.cmd(b64(c.user), 334);
        await conn.cmd(b64(c.pass ?? ""), 235);
      }
    }
    const from = c.from || c.user || `agent-hub@${c.host}`;
    await conn.cmd(`MAIL FROM:<${addr(from)}>`, 250);
    await conn.cmd(`RCPT TO:<${addr(to)}>`, 250);
    await conn.cmd("DATA", 354);
    const domain = addr(from).split("@")[1] ?? "agent-hub";
    const body = b64(text).replace(/.{1,76}/g, "$&\r\n").trimEnd(); // base64 never starts a line with "." — no dot-stuffing hazard, but stuff anyway
    const msg = [
      `From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
      "", body,
    ].join("\r\n").replace(/\r\n\./g, "\r\n..");
    await conn.send(`${msg}\r\n.`);
    await conn.reply(250);
    await conn.send("QUIT").catch(() => {});
  } finally {
    clearTimeout(timer);
    try { await sock.close(); } catch {}
  }
}

// Learn digest: only the owner's own words get in, and secrets never do.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerText, readClaude, readCodex, redact } from "../src/sessions";

// Fake values, assembled so the source never holds anything key-shaped.
const body = (n: number) => "aB3".repeat(n).slice(0, n);
const googleNew = "AQ." + body(50);
const googleOld = "AIza" + body(35);

const jsonl = (rows: unknown[]) => {
  const f = join(mkdtempSync(join(tmpdir(), "noop-sessions-")), "s.jsonl");
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
};
const codexMsg = (role: string, text: string) => ({ type: "response_item", timestamp: "2026-11-01T00:00:00Z", payload: { type: "message", role, content: [{ text }] } });
const claudeUser = (content: string) => ({ type: "user", timestamp: "2026-11-01T00:00:00Z", message: { content } });

test("redact: token families are removed", () => {
  for (const s of [googleNew, googleOld, "github_pat_" + body(30), "glpat-" + body(20), "npm_" + body(36), "hf_" + body(30), "sk_live_" + body(24), "rk_test_" + body(24), "ASIA" + "ABCDEFGHIJ234567", "ya29." + body(40), "GOCSPX-" + body(24)])
    expect(redact(`the key ${s} here`)).toBe("the key [REDACTED] here");
});

test("redact: assignments keep the name and drop the value", () => {
  expect(redact('"apiKey": "' + body(12) + '"')).toBe('"apiKey": [REDACTED]');
  expect(redact("API_KEY：" + body(12))).toBe("API_KEY：[REDACTED]");
  expect(redact("password='two words'")).toBe("password=[REDACTED]");
  expect(redact("token: [REDACTED]")).toBe("token: [REDACTED]");
  expect(redact('"password": "a\\"b c"')).toBe('"password": [REDACTED]');
});

test("redact: a huge unbroken run stays fast", () => {
  for (const s of ["x".repeat(300_000), "a.".repeat(150_000)]) {
    const start = performance.now();
    expect(redact(s)).toBe("[REDACTED]");
    expect(performance.now() - start).toBeLessThan(2000);
  }
});

test("redact: credentials in headers and URLs", () => {
  expect(redact("Authorization: Bearer " + body(40))).not.toContain(body(40));
  expect(redact("postgres://admin:" + body(12) + "@db.example.com/x")).not.toContain(body(12));
});

test("redact: ordinary text is left alone", () => {
  for (const s of ["see the FAQ.md section", "AQ. is short", "AWS regions", "https://github.com/o/r/pull/1", "AIza is a prefix"]) expect(redact(s)).toBe(s);
});

test("ownerText: machine-written turns are dropped", () => {
  for (const s of [
    "The following is the Codex agent history whose request action you are assessing.",
    '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
    "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
    '<artifact-content-authored-by-others x="1"/>\nThis session is being continued from a previous conversation.',
    '<in-app-browser-context source="ambient-ui-state">\nsupplied state\n</in-app-browser-context>',
  ]) expect(ownerText(s)).toBeNull();
  expect(ownerText("改成图标，别留文字")).toBe("改成图标，别留文字");
});

test("ownerText: wrappers are removed and the owner's words kept", () => {
  expect(ownerText('<in-app-browser-context source="x">state</in-app-browser-context>\n把按钮对齐')).toBe("把按钮对齐");
  expect(ownerText("# Files mentioned by the user:\n\n## a.jpg: /tmp/a.jpg\n\n## My request for Codex:\n这张图的边距不对\n")).toBe("这张图的边距不对");
});

test("ownerText: a secret across the length cap is redacted, not cut", () => {
  expect(ownerText("x".repeat(1490) + " " + googleNew)).not.toContain(googleNew.slice(0, 12));
});

test("readers: fleet planner and medic sessions are dropped whole", () => {
  for (const p of ["You place tasks for an AI agent fleet running on several machines.", "You are the Noop MEDIC on this machine. Something is broken; fix it."]) {
    expect(readCodex(jsonl([codexMsg("user", p), codexMsg("user", "should not appear")]))).toEqual([]);
    expect(readClaude(jsonl([claudeUser(p), claudeUser("should not appear")]), "proj")).toEqual([]);
  }
});

test("readers: the previous AI message is redacted before it is shortened", () => {
  const turns = readCodex(jsonl([codexMsg("assistant", googleNew + " " + "y".repeat(380)), codexMsg("user", "继续做这个功能")]));
  expect(turns).toHaveLength(1);
  expect(turns[0].prev).not.toContain(googleNew.slice(-20));
});

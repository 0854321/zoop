import { expect, test } from "bun:test";
import { due } from "../src/cli";
import { matches } from "../src/core";
import { parseResult } from "../src/runner";

test("routine schedule", () => {
  const t = new Date("2026-11-02T19:05:00"); // Monday
  expect(due("15m", undefined, t)).toBe(true);
  expect(due("15m", new Date(+t - 5 * 60e3).toISOString(), t)).toBe(false);
  expect(due("weekdays 19:00", undefined, t)).toBe(true);
  expect(due("weekdays 19:00", new Date("2026-11-02T19:01:00").toISOString(), t)).toBe(false);
  expect(due("weekly FRI 17:00", undefined, t)).toBe(false);
  expect(due("daily 20:00", undefined, t)).toBe(false);
  expect(due("daily 02:30", undefined, t)).toBe(false); // first run long after slot → wait for next slot
});

test("capability matching", () => {
  const caps = ["os:linux", "host:pc", "gpu"];
  expect(matches({ requires: "os:linux" }, caps)).toBe(true);
  expect(matches({ requires: "os:macos" }, caps)).toBe(false);
  expect(matches({ host: "pc", requires: "gpu" }, caps)).toBe(true);
  expect(matches({ host: "mbp" }, caps)).toBe(false);
});

test("result parsing", () => {
  expect(parseResult('blah\n```json\n{"status":"done","summary":"ok"}\n```').status).toBe("done");
  expect(parseResult("no block").status).toBe("failed");
});

test("owner image uploads: images only, 10 MB, attachments are the hub's own media", async () => {
  const { uploadProblem, ownerAttachments, MAX_UPLOAD } = await import("../cloud/src/uploads");
  expect(uploadProblem("image/png", 1000)).toBeNull();
  expect(uploadProblem("image/svg+xml", 1000)?.status).toBe(415);
  expect(uploadProblem("application/pdf", 1000)?.status).toBe(415);
  expect(uploadProblem("image/jpeg", MAX_UPLOAD + 1)?.status).toBe(413);
  expect(ownerAttachments(undefined)).toEqual([]);
  expect(ownerAttachments(["/media/1-a.png"])).toEqual(["/media/1-a.png"]);
  expect(ownerAttachments(["https://evil.example/x.png"])).toBeNull();
  expect(ownerAttachments(["/media/../noop.toml"])).toBeNull();
  expect(ownerAttachments(Array(11).fill("/media/a.png"))).toBeNull();
});

test("owner images are downloaded and named by absolute path in the task text", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveAttachments, withAttachments } = await import("../src/server");
  const root = mkdtempSync(join(tmpdir(), "noop-att-"));
  const got: string[] = [];
  const files = await saveAttachments("ev-1", ["/media/1-shot.png", "/media/2-gone.png"], async (p) => {
    got.push(p);
    return p.includes("gone") ? null : new Uint8Array([1, 2, 3]);
  }, root);
  expect(got).toEqual(["/media/1-shot.png", "/media/2-gone.png"]);
  expect(files).toEqual([join(root, "ev-1", "1-shot.png")]);
  expect([...readFileSync(files[0])]).toEqual([1, 2, 3]);
  const text = withAttachments("看这个报错", files, 1);
  expect(text.startsWith("看这个报错\n\nAttached images")).toBe(true);
  expect(text).toContain(`- ${files[0]}`);
  expect(text).toContain("1 more image(s) could not be downloaded");
  expect(withAttachments("", files).split("\n")[0]).toBe("(see the attached images)");
  expect(withAttachments("plain", [])).toBe("plain");
  rmSync(root, { recursive: true, force: true });
});

test("repo language → host requirements (only when the repo is on disk)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { capOk, repoRequires } = await import("../src/core");
  const rust = mkdtempSync(join(tmpdir(), "noop-rust-"));
  writeFileSync(join(rust, "Cargo.toml"), "[package]\n");
  const js = mkdtempSync(join(tmpdir(), "noop-js-"));
  writeFileSync(join(js, "package.json"), "{}");
  expect(repoRequires(rust)).toEqual(["cli:cargo"]);
  expect(repoRequires("/nonexistent/repo/xyz")).toEqual([]);
  const mac = ["os:macos", "host:mbp", "cli:claude", "cli:node"];
  expect(matches({ repo: rust }, mac)).toBe(false); // the Mac without cargo must not claim a Rust task
  expect(matches({ repo: rust }, [...mac, "cli:cargo"])).toBe(true);
  expect(matches({ repo: js }, mac)).toBe(true); // node is enough for package.json
  expect(matches({ repo: js }, ["os:linux"])).toBe(false);
  expect(capOk("cli:bun|cli:node", ["cli:bun"])).toBe(true);
  expect(matches({ repo: "/nonexistent/repo/xyz", requires: "cli:cargo" }, mac)).toBe(false); // stored at creation
});

test("quota/auth failover: same CLI's other account, then the other CLI, else nothing", async () => {
  const { failoverAccount } = await import("../src/accounts");
  const all = () => true;
  const a = { cli: "claude", name: "zz-test-a", dir: "" };
  const two = { accounts: [{ cli: "claude", name: "zz-test-a" }, { cli: "claude", name: "zz-test-b" }] } as any;
  expect(failoverAccount(two, a, ["claude"], all)?.name).toBe("zz-test-b");
  const solo = { accounts: [{ cli: "claude", name: "zz-test-a" }, { cli: "codex", name: "zz-test-c" }] } as any;
  expect(failoverAccount(solo, a, ["claude"], all)?.cli).toBe("codex"); // claude-only (owner/hard) work still falls back
  expect(failoverAccount(solo, a, ["claude"], (c) => c === "claude")).toBeNull(); // codex not installed → requeue
  expect(failoverAccount(solo, { cli: "codex", name: "zz-test-c", dir: "" }, ["codex", "claude"], all)?.cli).toBe("claude");
});

test("restart throttle: at most one voluntary restart per hour unless forced", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { restartAllowed } = await import("../src/cli");
  const f = join(mkdtempSync(join(tmpdir(), "noop-rs-")), "last-restart");
  expect(restartAllowed(false, f)).toBe(true); // never restarted
  const t = Date.parse("2026-11-02T17:00:00Z");
  writeFileSync(f, "2026-11-02T16:30:00Z");
  expect(restartAllowed(false, f, t)).toBe(false);
  expect(restartAllowed(true, f, t)).toBe(true);
  expect(restartAllowed(false, f, t + 31 * 60_000)).toBe(true);
});

test("selfUpdate defers while tasks run on this host", async () => {
  const { selfUpdate } = await import("../src/setup");
  expect(await selfUpdate({ busy: 2 })).toBe(false);
});

test("taskView shows the original ask, not daemon requeue notes", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeDoc } = await import("../src/core");
  const { taskView } = await import("../src/server");
  const dir = mkdtempSync(join(tmpdir(), "noop-tv-"));
  const old = join(dir, "T-1.md"); // legacy body: note appended as a quote, no owner quote
  writeDoc(old, { id: "T-1", title: "Fix build" }, "Fix the Rust build on CI.\n\n> Requeued after daemon restart on pc; check for partial work.\n");
  expect(taskView(old, "inbox", []).request).toBe("Fix the Rust build on CI.");
  const chat = join(dir, "T-2.md");
  writeDoc(chat, { id: "T-2", title: "x", requeue_note: "Requeued after daemon restart on pc; check for partial work." },
    "The owner (CEO) said in chat:\n\n> ship the release\n\nHandle it.\n\n> Attempt 1 failed: boom. Try a different approach.\n");
  expect(taskView(chat, "inbox", []).request).toBe("ship the release");
});

test("uploads: the real image type comes from the bytes", async () => {
  const { sniffImage } = await import("../cloud/src/uploads");
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "application/octet-stream")).toBe("image/jpeg");
  expect(sniffImage(new TextEncoder().encode("\0\0\0\x18ftypheic"), "")).toBe("image/heic");
  expect(sniffImage(new Uint8Array([1, 2, 3]), "image/jpg")).toBe("image/jpeg");
});


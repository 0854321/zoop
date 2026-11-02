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

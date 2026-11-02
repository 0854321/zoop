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

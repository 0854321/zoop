import { expect, test } from "bun:test";
import { signalChanged } from "../src/cli";

test("routine signal only fires on change", () => {
  const st: Record<string, string> = {};
  const r = { name: "x", signal: "echo a" };
  expect(signalChanged(r, st)).toBe(true);
  expect(signalChanged(r, st)).toBe(false);
  expect(signalChanged({ ...r, signal: "echo b" }, st)).toBe(true);
  expect(signalChanged({ ...r, signal: "exit 3" }, st)).toBe(true); // failure → let the agent look
});

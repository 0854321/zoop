import { expect, test } from "bun:test";
import { claimInboxMessage } from "../src/cloud";

test("a replayed owner message id is handled once, also after the seen list is reloaded", () => {
  const seen: string[] = [];
  expect(claimInboxMessage(seen, "m1")).toBe(true);
  expect(claimInboxMessage(seen, "m1")).toBe(false);
  const reloaded = JSON.parse(JSON.stringify({ seen })).seen as string[]; // cloud-inbox.json round trip, any hub url
  expect(claimInboxMessage(reloaded, "m1")).toBe(false);
  expect(claimInboxMessage(reloaded, "m2")).toBe(true);
  expect(claimInboxMessage(reloaded, undefined)).toBe(true);
});

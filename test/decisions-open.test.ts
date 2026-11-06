// A chat reply ("D-0001 忽略") is matched against the ids of the cards still waiting for the owner.
// The ids must be bare ids on every OS: on Windows list() returns "…\decisions\open\D-0001.md", and splitting
// that on "/" put the whole path in the set, so every reply was dropped and the card stayed open forever.
import { expect, test } from "bun:test";
import { fileId } from "../src/core";

test("a decision file's id is its bare name on both path styles", () => {
  expect(fileId("C:\\Users\\testuser\\.noop\\data\\decisions\\open\\D-0001.md")).toBe("D-0001");
  expect(fileId("/home/testuser/.noop/data/decisions/open/D-0012.md")).toBe("D-0012");
});

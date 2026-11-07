import { expect, test } from "bun:test";
import { isUnread, markAllRead, readTo, toggleRead, unreadCount, type ReadState } from "../app/read";

const ev = (id: string, ts: string, kind = "info", from = "lead") => ({ id, ts, kind, from });
const events = [ev("a", "1"), ev("b", "2", "owner", "owner"), ev("c", "3"), ev("d", "4", "system", "hub@x"), ev("e", "5")];

test("unread counts the team's messages after the cursor, plus manual marks", () => {
  const s: ReadState = { upTo: "2", marked: ["a"] };
  expect(unreadCount(events, s)).toBe(3); // a (marked), c, e — not the owner's or the hub's quiet line
  expect(isUnread(events[3], s)).toBe(false);
});

test("mark all read clears marks and moves the cursor to the end", () => {
  expect(markAllRead(events, { upTo: "1", marked: ["a"] })).toEqual({ upTo: "5", marked: [] });
});

test("toggle marks unread, reads it back, and reaching the bottom keeps manual marks", () => {
  let s: ReadState = { upTo: "5", marked: [] };
  s = toggleRead(events[0], s);
  expect(isUnread(events[0], s)).toBe(true);
  expect(readTo("6", s).marked).toEqual(["a"]);
  s = toggleRead(events[0], s);
  expect(unreadCount(events, s)).toBe(0);
  expect(toggleRead(events[4], { upTo: "1", marked: [] }).upTo).toBe("5");
});

test("a channel item follows the chat's read state for its messages", async () => {
  const { refUnread } = await import("../app/read");
  const evs = [{ ...ev("m1", "3"), ref: "T-1" }, { ...ev("m2", "4"), ref: "T-2" }];
  expect(refUnread(evs, { upTo: "3", marked: [] }, "T-1", "0")).toBe(false);
  expect(refUnread(evs, { upTo: "3", marked: [] }, "T-2", "0")).toBe(true);
  expect(refUnread(evs, { upTo: "3", marked: [] }, "T-2", "5")).toBe(false); // channel opened after it
  expect(refUnread(evs, { upTo: "9", marked: ["m1"] }, "T-1", "9")).toBe(true);
  expect(refUnread(evs, { upTo: "3", marked: [] }, "T-9", "0")).toBeUndefined();
});

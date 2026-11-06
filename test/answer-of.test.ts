import { expect, mock, test } from "bun:test";

// app/hub reads the language through app/i18n, which imports nsh (only resolvable inside the app).
mock.module("nsh", () => ({ signal: <T>(v: T) => () => v }));
const { answerOf } = await import("../app/hub");

const ev = (text: string, ref?: string) => ({ id: text, ts: "2026-11-06T05:56:00Z", kind: "owner", from: "owner", text, ref }) as any;

test("answerOf reads the owner's latest answer to a card", () => {
  expect(answerOf([ev("D-0116 A")], "D-0116")).toBe("A");
  expect(answerOf([ev("D-0116 A"), ev("D-0116 B")], "D-0116")).toBe("B");
  expect(answerOf([ev("改一下命名", "D-0117")], "D-0117")).toBe("改一下命名");
  expect(answerOf([ev("D-0115 A")], "D-0116")).toBeNull();
});

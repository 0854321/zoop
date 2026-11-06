import { expect, test } from "bun:test";
import { appendQuote } from "../app/quote";

test("quotes formatted paragraphs, lists and code without losing a draft", () => {
  expect(appendQuote("My draft", "**bold**\n\n- item\n\n```ts\nx()\n```"))
    .toBe("My draft\n\n> **bold**\n> \n> - item\n> \n> ```ts\n> x()\n> ```\n\n");
});
test("handles an empty selection, Windows line endings and repeated quotes", () => {
  expect(appendQuote("draft  ", " \n")).toBe("draft  ");
  expect(appendQuote("", "a\r\nb")).toBe("> a\n> b\n\n");
  expect(appendQuote(appendQuote("", "one"), "two")).toBe("> one\n\n> two\n\n");
});
